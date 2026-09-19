/* ============================================================================
 * AI SEN — API
 * ----------------------------------------------------------------------------
 * Hace tres cosas, y ninguna puede ocurrir en el navegador:
 *   1. Guarda la unified key del motor. El navegador nunca la ve.
 *   2. Valida la sesión que el usuario obtuvo de Supabase Auth.
 *   3. Cuenta la cuota diaria en el servidor (la del navegador se burla sola).
 *
 * El login en sí lo maneja Supabase directamente desde el navegador. Aquí solo
 * verificamos el token que trae, y decidimos si puede gastar tokens.
 * ========================================================================== */
'use strict';

const express = require('express');
const { Readable } = require('node:stream');
const sb = require('./supabase');

const PORT = process.env.PORT || 8080;
const ENGINE_URL = process.env.ENGINE_URL || 'http://freellmapi:3001/v1';
const ENGINE_KEY = process.env.ENGINE_KEY || '';
const VOICE_URL = process.env.VOICE_URL || 'http://chatterbox:8004';

if (!ENGINE_KEY) {
  console.error('[AI SEN] Falta ENGINE_KEY: sin ella el motor rechaza todo.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

/* ============================== SESIÓN ================================== */

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Inicia sesión para usar AI SEN.' });
  }
  const user = await sb.userFromToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Sesión expirada. Vuelve a entrar.' });
  }
  req.authUser = user;
  req.profile = await sb.getProfile(user.id, user.email);
  next();
}

/* ============================== MI CUENTA =============================== */

app.get('/api/me', requireAuth, async (req, res) => {
  res.json({
    email: req.authUser.email,
    ...(await sb.quotaOf(req.profile))
  });
});

/* ===================== PROXY AL MOTOR (key escondida) =================== */

// Estimación de respaldo cuando el motor no reporta uso real.
const estimate = (t) => Math.ceil(String(t || '').length / 4);

/* ============ GEOLOCALIZACIÓN POR IP + CONTEXTO DE RUTAS ============= */
// Mejora de respuestas: si la conversación habla de caminos, rutas o
// distancias, inyectamos contexto local —la diferencia práctica entre
// pavimento (asfalto/hormigón), ripio y huella de tierra— y, si la IP lo
// permite, la ubicación aproximada del usuario. Sin clave, servicio gratis.
const geoCache = new Map(); // ip -> {city,region,country,lat,lon} | null

function isPrivateIp(ip) {
  const i = String(ip || '');
  return !i || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fe80)/i.test(i);
}

async function geolocate(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip);
  if (isPrivateIp(ip)) { geoCache.set(ip, null); return null; }
  try {
    const r = await fetch('https://ipwho.is/' + encodeURIComponent(ip) +
      '?fields=city,region,country,latitude,longitude,success');
    const j = await r.json();
    const out = j && j.success ? {
      city: j.city, region: j.region, country: j.country,
      lat: j.latitude, lon: j.longitude
    } : null;
    geoCache.set(ip, out);
    return out;
  } catch (_) { geoCache.set(ip, null); return null; }
}

// Palabras que disparan el contexto de rutas/caminos/terreno.
const ROAD_KEYWORDS = /\b(carretera|caminos?|rutas?|ripio|maicillo|tierra|asfalto|paviment|hormig[oó]n|baches?|huellas?|vecinal|autopista|vialidad|accesos?|portezuelo|nieve|hielo|escarcha|tracci[oó]n|4x4|cuatrimoto|camioneta|llegar|lleg[oó]|distancia|demora|kil[oó]metros?|kms?\b|cerca|lejos|trayecto|viaje|austral)\b/i;

const TERRAIN_CONTEXT =
  'Contexto para responder: el usuario habla de rutas o desplazamientos. ' +
  'En Chile —sobre todo en la Patagonia y Aysén— hay diferencia práctica entre ' +
  'camino pavimentado (asfalto u hormigón), ripio y huella de tierra: la velocidad ' +
  'segura, la tracción requerida y los tiempos de viaje cambian según el tipo de ' +
  'vía y el clima. Si aplica, distingue el tipo de camino y da estimaciones realistas.';

function buildContext(messages, geo) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  // Si ya hay un system propio (p. ej. del cliente), no pisar.
  if (messages[0] && messages[0].role === 'system') return messages;
  const lastUser = [...messages].reverse()
    .find(function (m) { return m && m.role === 'user' && typeof m.content === 'string'; });
  if (!lastUser || !ROAD_KEYWORDS.test(lastUser.content)) return messages;
  let ctx = TERRAIN_CONTEXT;
  if (geo) {
    const loc = [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
    if (loc) ctx += ' Ubicación aproximada del usuario: ' + loc + '.';
  }
  return [{ role: 'system', content: ctx }].concat(messages);
}

// Ubicación aproximada del usuario (para mostrarla y para el contexto).
app.get('/api/geo', requireAuth, async (req, res) => {
  res.json({ geo: await geolocate(req.ip) });
});

app.post('/api/v1/chat/completions', requireAuth, async (req, res) => {
  const q = await sb.quotaOf(req.profile);
  if (q.remaining <= 0) {
    return res.status(429).json({
      error: 'Se te acabaron los tokens de hoy. Vuelven mañana, o súbete de plan.',
      quota: q
    });
  }

  // Forzamos stream:false para contar el uso exacto que reporta el motor.
  // El cliente ya esperaba la respuesta completa, así que no cambia nada.
  const body = Object.assign({}, req.body, { stream: false });

  // Contexto de rutas/terreno + ubicación por IP: mejora respuestas locales.
  const geo = await geolocate(req.ip);
  body.messages = buildContext(body.messages, geo);

  try {
    const upstream = await fetch(ENGINE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ENGINE_KEY   // ← aquí, nunca en el navegador
      },
      body: JSON.stringify(body)
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok || !data) {
      return res.status(upstream.status || 502).json({
        error: 'El motor no respondió bien.',
        detail: data && data.error ? data.error : undefined
      });
    }

    const used = (data.usage && data.usage.total_tokens) ||
      (estimate(JSON.stringify(body.messages)) +
       estimate(data.choices && data.choices[0] &&
                data.choices[0].message && data.choices[0].message.content));
    await sb.addUsage(req.profile.id, used);

    res.json(Object.assign({}, data, { aisen_quota: await sb.quotaOf(req.profile) }));
  } catch (e) {
    res.status(502).json({ error: 'No pude alcanzar el motor.', detail: String(e.message || e) });
  }
});

/* ===================== TRANSCRIPCIÓN DE VOZ (grabar) =================== */

// El botón 🎙 del chat graba con el micrófono y manda el WAV en base64.
// Aquí lo reenviamos como multipart al motor (whisper de Groq).
app.post('/api/v1/audio/transcriptions', requireAuth, async (req, res) => {
  const dataBase64 = req.body && req.body.dataBase64;
  const filename = String(req.body && req.body.filename || 'grabacion.wav')
    .replace(/[^a-zA-Z0-9._-]/g, '');
  if (!dataBase64) {
    return res.status(400).json({ error: 'Falta el audio (dataBase64).' });
  }
  const q = await sb.quotaOf(req.profile);
  if (q.remaining <= 0) {
    return res.status(429).json({ error: 'Se te acabaron los tokens de hoy.' });
  }
  try {
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length < 1000) {
      return res.status(400).json({ error: 'La grabación está vacía o es muy corta.' });
    }
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), filename);
    form.append('model', 'auto');
    const upstream = await fetch(ENGINE_URL + '/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + ENGINE_KEY },
      body: form
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok || !data) {
      return res.status(upstream.status || 502).json({
        error: 'El motor no pudo transcribir.',
        detail: data && data.error ? data.error : undefined
      });
    }
    await sb.addUsage(req.profile.id, estimate(data.text || '') + 50);
    res.json(Object.assign({}, data, { aisen_quota: await sb.quotaOf(req.profile) }));
  } catch (e) {
    res.status(502).json({ error: 'No pude alcanzar el motor.', detail: String(e.message || e) });
  }
});

/* ========================= PROXY AL MOTOR DE VOZ ======================== */

// Trial local de voz: con ALLOW_VOICE_TRIAL=1 cualquier plan puede clonar.
// En producción (sin esa variable) solo pro/premium, como define PLANS.
const allowVoiceTrial = ['1', 'true'].includes(
  (process.env.ALLOW_VOICE_TRIAL || '').toLowerCase()
);

app.get('/api/v1/voices', requireAuth, async (req, res) => {
  try {
    const r = await fetch(VOICE_URL + '/get_reference_files');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    res.json(await r.json());
  } catch (_) {
    res.status(503).json({ error: 'El motor de voz está apagado.' });
  }
});

// Sube la muestra de voz del usuario (WAV/MP3 en base64) al motor de voz.
// El motor la guarda como voz de referencia para clonar.
app.post('/api/v1/voices/upload', requireAuth, async (req, res) => {
  const filename = String(req.body && req.body.filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
  const dataBase64 = req.body && req.body.dataBase64;
  if (!/\.(wav|mp3)$/i.test(filename)) {
    return res.status(400).json({ error: 'La muestra debe ser .wav o .mp3.' });
  }
  if (!dataBase64) {
    return res.status(400).json({ error: 'Falta el audio (dataBase64).' });
  }
  try {
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length < 1000) {
      return res.status(400).json({ error: 'La muestra está vacía o es muy corta.' });
    }
    const form = new FormData();
    form.append('files', new Blob([buf], { type: 'audio/wav' }), filename);
    const r = await fetch(VOICE_URL + '/upload_reference', { method: 'POST', body: form });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      return res.status(r.status || 502).json({
        error: 'El motor de voz rechazó la muestra.',
        detail: data ? (data.detail || data.errors) : undefined
      });
    }
    // El motor devuelve la lista de referencias válidas tras subir.
    res.json({
      ok: true,
      filename: filename,
      voices: data ? (data.all_reference_files || []) : []
    });
  } catch (e) {
    res.status(502).json({ error: 'No pude alcanzar el motor de voz.', detail: String(e.message || e) });
  }
});

app.post('/api/v1/audio/speech', requireAuth, async (req, res) => {
  const plan = sb.PLANS[req.profile.plan] || sb.PLANS.free;
  if (!plan.voice && !allowVoiceTrial) {
    return res.status(402).json({
      error: 'La voz clonada viene desde el plan Pro. Súbete y te respondo hablando.'
    });
  }
  const q = await sb.quotaOf(req.profile);
  if (q.remaining <= 0) {
    return res.status(429).json({ error: 'Se te acabaron los tokens de hoy.' });
  }

  try {
    const upstream = await fetch(VOICE_URL + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'El motor de voz falló.' });
    }
    await sb.addUsage(req.profile.id, estimate(req.body.input) + 200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (_) {
    res.status(503).json({ error: 'El motor de voz está apagado.' });
  }
});

/* ================================ SALUD ================================= */

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('[AI SEN] API escuchando en :' + PORT);
  console.log('[AI SEN] motor → ' + ENGINE_URL);
  console.log('[AI SEN] voz   → ' + VOICE_URL);
});
