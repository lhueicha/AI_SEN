#!/usr/bin/env node
/* ============================================================================
 * AI SEN — aprovisionamiento automático del motor
 * ----------------------------------------------------------------------------
 * Deja FreeLLMAPI listo sin tocar el panel: crea la cuenta admin, carga las
 * claves de OpenRouter / Groq / Google AI Studio, las prueba una por una, y
 * devuelve la unified key para pegar en el .env.
 *
 * Uso:
 *   ENGINE=http://localhost:3001 \
 *   ADMIN_EMAIL=tu@correo.com ADMIN_PASSWORD='algo-largo' \
 *   OPENROUTER_KEY=sk-or-v1-... GROQ_KEY=gsk_... GOOGLE_KEY=AQ... \
 *   node provision-engine.mjs
 *
 * Opcionales:
 *   SETUP_CODE=XXXXXX   si el motor no es loopback (sale en los logs)
 *   REGENERATE=1        regenera la unified key (hazlo si la anterior se filtró)
 * ========================================================================== */

const ENGINE = (process.env.ENGINE || 'http://localhost:3001').replace(/\/+$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const SETUP_CODE = process.env.SETUP_CODE;
const REGENERATE = process.env.REGENERATE === '1';

// Las claves que quieras cargar. Las vacías se saltan.
const CANDIDATAS = [
  { alias: 'openrouter', env: 'OPENROUTER_KEY', nombres: ['openrouter'] },
  { alias: 'groq',       env: 'GROQ_KEY',       nombres: ['groq'] },
  { alias: 'google',     env: 'GOOGLE_KEY',     nombres: ['google', 'gemini', 'google-ai-studio'] },
  { alias: 'huggingface',env: 'HF_KEY',         nombres: ['huggingface'] }
];

if (!EMAIL || !PASSWORD) {
  console.error('Faltan ADMIN_EMAIL y ADMIN_PASSWORD.');
  process.exit(1);
}

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = null;

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(ENGINE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

/* --------------------------- 1. esperar al motor -------------------------- */
async function esperarMotor() {
  process.stdout.write('· Esperando al motor en ' + ENGINE + ' ');
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(ENGINE + '/api/ping');
      if (r.ok) { log('→ vivo'); return; }
    } catch (_) { /* aún no levanta */ }
    process.stdout.write('.');
    await sleep(2000);
  }
  log('');
  throw new Error('El motor no respondió en 2 minutos. ¿Está corriendo el contenedor?');
}

/* ------------------------ 2. cuenta admin / sesión ------------------------ */
async function autenticar() {
  const estado = await api('/api/auth/status', { auth: false });
  const necesitaSetup = estado.data && (estado.data.needsSetup ?? estado.data.setupRequired);

  if (necesitaSetup) {
    log('· No hay cuenta admin: la creo.');
    const body = { email: EMAIL, password: PASSWORD };
    if (SETUP_CODE) body.setupCode = SETUP_CODE;
    const r = await api('/api/auth/setup', { method: 'POST', body, auth: false });
    if (!r.ok) {
      throw new Error('No pude crear la cuenta (HTTP ' + r.status + '): ' +
        JSON.stringify(r.data) +
        (r.status === 403 ? '\n  → Necesitas SETUP_CODE. Sale en: docker compose logs aisen-engine' : ''));
    }
    token = r.data.token;
    log('  ✓ cuenta admin creada');
  } else {
    const r = await api('/api/auth/login', {
      method: 'POST', body: { email: EMAIL, password: PASSWORD }, auth: false
    });
    if (!r.ok) throw new Error('Login rechazado (HTTP ' + r.status + '): ' + JSON.stringify(r.data));
    token = r.data.token;
    log('· Sesión iniciada como ' + EMAIL);
  }
  if (!token) throw new Error('El motor no devolvió token de sesión.');
}

/* ---------------------- 3. cargar claves de proveedor --------------------- */
async function cargarClaves() {
  // Preguntamos al motor qué plataformas acepta, en vez de adivinar el nombre.
  const disp = await api('/api/keys/providers');
  const soportadas = new Set(
    (Array.isArray(disp.data) ? disp.data : (disp.data?.providers || []))
      .map((p) => String(typeof p === 'string' ? p : (p.platform || p.id || p.name)).toLowerCase())
      .filter(Boolean)
  );
  if (soportadas.size) log('· El motor acepta: ' + [...soportadas].join(', '));

  const cargadas = [];
  for (const c of CANDIDATAS) {
    const valor = process.env[c.env];
    if (!valor) { log('· ' + c.alias + ': sin clave, salto.'); continue; }

    const platform = c.nombres.find((n) => !soportadas.size || soportadas.has(n)) || c.nombres[0];
    const r = await api('/api/keys', {
      method: 'POST',
      body: { platform, key: valor, label: 'aisen-' + c.alias }
    });
    if (r.ok) {
      log('  ✓ ' + platform + ' cargada');
      cargadas.push(platform);
    } else if (r.status === 409) {
      log('  · ' + platform + ' ya estaba cargada');
      cargadas.push(platform);
    } else {
      log('  ✗ ' + platform + ' falló (HTTP ' + r.status + '): ' + JSON.stringify(r.data));
    }
  }
  return cargadas;
}

/* -------------------------- 4. probar cada clave -------------------------- */
async function probarClaves() {
  const lista = await api('/api/keys');
  const claves = Array.isArray(lista.data) ? lista.data : (lista.data?.keys || []);
  if (!claves.length) { log('· No hay claves que probar.'); return; }

  log('· Probando ' + claves.length + ' clave(s) contra los proveedores reales…');
  for (const k of claves) {
    const r = await api('/api/keys/' + k.id + '/test', { method: 'POST' });
    const estado = r.ok ? (r.data?.status || 'ok') : ('HTTP ' + r.status);
    const icono = /healthy|ok|valid/i.test(String(estado)) ? '✓' : '⚠';
    log('  ' + icono + ' ' + (k.platform || k.label) + ' → ' + estado);
  }
}

/* ------------------------- 5. la clave unificada -------------------------- */
async function claveUnificada() {
  if (REGENERATE) {
    const r = await api('/api/settings/api-key/regenerate', { method: 'POST' });
    if (r.ok) { log('· Unified key regenerada (la anterior ya no sirve).'); return r.data.apiKey; }
    log('· No pude regenerarla, leo la actual.');
  }
  const r = await api('/api/settings/api-key');
  if (!r.ok) throw new Error('No pude leer la unified key (HTTP ' + r.status + ')');
  return r.data.apiKey;
}

/* --------------------------------- main ---------------------------------- */
try {
  await esperarMotor();
  await autenticar();
  const cargadas = await cargarClaves();
  await probarClaves();
  const unified = await claveUnificada();

  log('');
  log('═══════════════════════════════════════════════════════════');
  log(' Motor aprovisionado · proveedores: ' + (cargadas.join(', ') || 'ninguno'));
  log('');
  log(' Pega esto en deploy/.env :');
  log('');
  log('   ENGINE_KEY=' + unified);
  log('');
  log(' Y reinicia la API:  docker compose up -d aisen-api');
  log('═══════════════════════════════════════════════════════════');
} catch (e) {
  console.error('');
  console.error('✗ ' + (e.message || e));
  process.exit(1);
}
