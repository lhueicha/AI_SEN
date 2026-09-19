/* ============================================================================
 * AI SEN — Chatbot real conectado a FreeLLMAPI
 * ----------------------------------------------------------------------------
 * Vanilla JavaScript. Sin dependencias. Conecta la landing de AI SEN a un
 * endpoint OpenAI-compatible (FreeLLMAPI en http://localhost:3001/v1).
 *
 * Características:
 *   - Chat real vía POST /v1/chat/completions (JSON o SSE streaming).
 *   - 4 modos: 'rapido' (velocidad), 'inteligente' (razonamiento),
 *     'voz' (respuestas habladas con voz clonada), 'web' (búsqueda real).
 *   - Límite diario de tokens gratis con persistencia en localStorage y
 *     contador visual "tienes X tokens hoy".
 *   - Manejo de errores: si el motor está caído, muestra "motor apagado".
 *
 * Para conectar: edita CONFIG abajo (baseUrl + apiKey) y enlaza este archivo
 * en index.html con <script src="app.js"></script>. Ver README.md.
 * ========================================================================== */

(function () {
  'use strict';

  /* ============================ CONFIGURACIÓN ============================ */
  // TODO: cambia estos valores por los tuyos.
  const CONFIG = {
    // Todo pasa por el backend propio, en el mismo dominio.
    baseUrl: '/api/v1',

    // No hay clave en el navegador. La del motor vive en el servidor, dentro
    // del contenedor aisen-api, y nunca se envía al cliente.
    apiKey: null,

    // Límite diario de tokens gratis (por día calendario, por navegador).
    dailyTokenLimit: 100000,

    // true -> SSE streaming; false -> respuesta JSON completa.
    streaming: true,

    // Modelo / estrategia de routing por modo.
    // FreeLLMAPI acepta auto, auto:fast, auto:smart, auto:cheap, etc.
    modeModel: {
      rapido: 'auto:fast',
      voz: 'auto:fast' // modo clonar voz: chat normal, respuesta leída en voz clonada
    },

    // --- Motor de voz: Chatterbox TTS Server (Resemble AI, licencia MIT) ---
    // Clona una voz con 5-20s de muestra. Gratis, self-host, uso comercial OK.
    // Instalación: ver VOZ.md. Corre aparte de FreeLLMAPI, en el puerto 8004.
    voice: {
      baseUrl: 'http://localhost:8004/v1',
      model: 'chatterbox',
      // WAV a propósito: esta instalación de Chatterbox no trae codificador
      // de MP3 y responde "Failed to encode audio" (500). WAV no necesita
      // ninguno. Comprobado: wav 200 · opus 200 · mp3 500.
      format: 'wav',
      // Nombres de voz que el servidor expone (archivos en ./voices y
      // ./reference_audio). Se suben desde la UI del servidor: localhost:8004
      available: ['default'],
      selected: 'default',
      // Leer automáticamente cada respuesta cuando el modo Voz está activo.
      autoSpeak: true
    },

    // Clave de almacenamiento local.
    storageKey: 'aisen.tokens'
  };

  // Permite sobrescribir la configuración sin tocar este archivo: define
  // window.AISEN_CONFIG en config.js antes de cargar app.js. Así el mismo
  // código sirve en local (localhost) y en Vercel (URLs públicas).
  if (typeof window !== 'undefined' && window.AISEN_CONFIG) {
    Object.keys(window.AISEN_CONFIG).forEach(function (k) {
      const v = window.AISEN_CONFIG[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && CONFIG[k]) {
        Object.assign(CONFIG[k], v);
      } else {
        CONFIG[k] = v;
      }
    });
  }

  /* ============================== ESTADO ================================== */
  let activeMode = 'rapido';
  // Búsqueda web habilitada SIEMPRE por defecto (el check quedó fuera de vista).
  let webEnabled = true;
  // Historial de mensajes en memoria (contexto de la conversación).
  const history = [];

  /* ===================== GESTIÓN DE TOKENS DIARIOS ======================= */
  const TokenStore = {
    // Devuelve { day: 'YYYY-MM-DD', used: number }
    load() {
      try {
        const raw = localStorage.getItem(CONFIG.storageKey);
        if (raw) return JSON.parse(raw);
      } catch (_) { /* almacenamiento no disponible */ }
      return { day: '', used: 0 };
    },
    save(day, used) {
      try {
        localStorage.setItem(CONFIG.storageKey, JSON.stringify({ day, used }));
      } catch (_) { /* ignorar */ }
    },
    today() {
      const d = new Date();
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    },
    // Devuelve los tokens usados hoy, reseteando si cambió el día.
    usedToday() {
      const s = this.load();
      if (s.day !== this.today()) {
        this.save(this.today(), 0);
        return 0;
      }
      return s.used || 0;
    },
    remaining() {
      return Math.max(0, CONFIG.dailyTokenLimit - this.usedToday());
    },
    add(n) {
      const s = this.load();
      const day = this.today();
      const base = (s.day === day ? s.used : 0);
      this.save(day, base + n);
      return base + n;
    }
  };

  /* ============================ UTILIDADES ================================ */
  // Estima tokens de un texto cuando el servidor no reporta usage.
  function estimateTokens(text) {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  /* ============================== DOM ===================================== */
  // Referencias a elementos existentes de index.html.
  const chatbox = document.getElementById('chatbox');
  const modeButtons = Array.prototype.slice.call(
    document.querySelectorAll('.mode')
  );

  // --- Barra de entrada (input + grabar + enviar) ---
  const inputRow = document.createElement('div');
  inputRow.className = 'aisen-input-row';
  const input = document.createElement('textarea');
  input.rows = 1;
  input.placeholder = 'Escribe o habla…';
  const micBtn = document.createElement('button');
  micBtn.className = 'aisen-mic';
  micBtn.textContent = '🎙';
  micBtn.title = 'Grabar con tu voz: se corta sola al hacer pausa';
  const lipBtn = document.createElement('button');
  lipBtn.className = 'aisen-lip';
  lipBtn.textContent = '👄';
  lipBtn.title = 'Leer mis labios: habla mirando a la cámara y transcribo lo que digas';
  const brainBtn = document.createElement('button');
  brainBtn.className = 'aisen-brain-tool';
  brainBtn.textContent = '🧠';
  brainBtn.title = 'Segundo cerebro: tu red de conocimiento en grande';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'aisen-send';
  sendBtn.textContent = 'Enviar';
  inputRow.appendChild(input);
  inputRow.appendChild(micBtn);
  inputRow.appendChild(lipBtn);
  inputRow.appendChild(brainBtn);
  inputRow.appendChild(sendBtn);

  // --- Contador de tokens ---
  const tokenBadge = document.createElement('div');
  tokenBadge.className = 'aisen-tokens';

  // --- Panel del modo Voz: TUTOR con tu voz clonada ---
  // Flujo: 1) grabas tu voz  2) dices qué aprender  3) lección hablada.
  const voiceRow = document.createElement('div');
  voiceRow.className = 'aisen-tutor';

  const tuTitle = document.createElement('div');
  tuTitle.className = 'tu-title';
  tuTitle.textContent = '🎓 Tu tutor con tu voz';

  const row1 = document.createElement('div');
  row1.className = 'tu-row';
  const recordBtn = document.createElement('button');
  recordBtn.className = 'tu-record';
  recordBtn.textContent = '🎤 Grabar mi voz';
  recordBtn.title = 'Graba 10 segundos con tu micrófono para clonar tu voz';
  const voiceStatus = document.createElement('span');
  voiceStatus.className = 'tu-status';
  voiceStatus.textContent = '';
  row1.appendChild(recordBtn);
  row1.appendChild(voiceStatus);

  const row2 = document.createElement('div');
  row2.className = 'tu-row';
  const topicInput = document.createElement('textarea');
  topicInput.className = 'tu-topic';
  topicInput.rows = 1;
  topicInput.placeholder = '¿Qué quieres aprender? Ej: inglés para viajar, derivadas, preparar una prueba…';
  row2.appendChild(topicInput);

  const chipsRow = document.createElement('div');
  chipsRow.className = 'tu-chips';
  ['🇬🇧 Inglés para conversar', '💼 Inglés para el trabajo',
   '📐 Matemáticas: derivadas', '🧪 Física de fluidos',
   '📝 Preparar una prueba', '🗣 Pronunciación en inglés'
  ].forEach(function (t) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'tu-chip';
    c.textContent = t;
    c.addEventListener('click', function () {
      topicInput.value = t;
      updateTutorState();
      topicInput.focus();
    });
    chipsRow.appendChild(c);
  });

  const row3 = document.createElement('div');
  row3.className = 'tu-row';
  const lessonBtn = document.createElement('button');
  lessonBtn.className = 'tu-go';
  lessonBtn.textContent = '🎓 Generar mi lección';
  lessonBtn.disabled = true;
  const continueBtn = document.createElement('button');
  continueBtn.className = 'tu-cont';
  continueBtn.textContent = '📚 Continuar lección';
  continueBtn.style.display = 'none';
  row3.appendChild(lessonBtn);
  row3.appendChild(continueBtn);

  voiceRow.appendChild(tuTitle);
  voiceRow.appendChild(row1);
  voiceRow.appendChild(row2);
  voiceRow.appendChild(chipsRow);
  voiceRow.appendChild(row3);
  voiceRow.style.display = 'none';

  /* ============================ RENDER ==================================== */
  function appendMessage(role, html) {
    const line = document.createElement('div');
    line.className = 'line ' + (role === 'user' ? 'user' : 'bot');
    if (role === 'user') {
      // Burbuja del usuario: etiqueta "TÚ" arriba del texto.
      const uname = document.createElement('span');
      uname.className = 'uname';
      uname.textContent = 'Tú';
      line.appendChild(uname);
      const span = document.createElement('span');
      span.innerHTML = html;
      line.appendChild(span);
    } else {
      line.innerHTML = '<span class="aisen-label">AI SEN</span> ' + html;
    }
    chatbox.appendChild(line);
    chatbox.scrollTop = chatbox.scrollHeight;
    return line;
  }

  // Inserta la respuesta del bot con render markdown+LaTeX.
  function appendBotRendered(rawText) {
    const line = document.createElement('div');
    line.className = 'line bot';
    const label = document.createElement('span');
    label.className = 'aisen-label';
    label.textContent = 'AI SEN';
    const body = document.createElement('span');
    body.className = 'aisen-body';
    body.setAttribute('data-raw', rawText);
    line.appendChild(label);
    line.appendChild(body);
    chatbox.appendChild(line);
    renderAisen(body);
    attachPdfButton(line, rawText);
    if (activeMode === 'voz') attachSpeakButton(line, rawText);
    chatbox.scrollTop = chatbox.scrollHeight;
    return line;
  }

  function appendBotStream() {
    // Devuelve una línea bot con cursor, lista para recibir texto.
    const line = document.createElement('div');
    line.className = 'line bot';
    line.innerHTML = '<span class="aisen-label">AI SEN</span> ' +
      '<span class="aisen-out"></span>' +
      '<span class="cursor"></span>';
    chatbox.appendChild(line);
    return line.querySelector('.aisen-out');
  }

  function setBusy(busy) {
    isBusy = busy;
    sendBtn.disabled = busy;
    recordBtn.disabled = busy;
    input.disabled = busy;
    updateTutorState();
  }

  function updateTokenBadge() {
    const remaining = serverQuota ? serverQuota.remaining : TokenStore.remaining();
    tokenBadge.textContent =
      'Tienes ' + remaining.toLocaleString('es-CL') + ' tokens hoy';
    if (serverQuota) {
      tokenBadge.title = 'Plan ' + (serverQuota.planLabel || serverQuota.plan) +
        ' · Límite diario: ' + serverQuota.limit.toLocaleString('es-CL') +
        ' · Usados: ' + serverQuota.used.toLocaleString('es-CL');
      tokenBadge.classList.toggle('low', remaining <= 0);
      return;
    }
    tokenBadge.title =
      'Límite diario: ' + CONFIG.dailyTokenLimit.toLocaleString('es-CL') +
      ' · Usados: ' + TokenStore.usedToday().toLocaleString('es-CL');
    if (TokenStore.remaining() <= 0) {
      tokenBadge.classList.add('low');
    } else {
      tokenBadge.classList.remove('low');
    }
  }

  /* ============================ MOTOR ===================================== */
  function apiUrl(path) {
    return CONFIG.baseUrl.replace(/\/+$/, '') + path;
  }

  // La autorización es la sesión del usuario (Supabase). La clave del motor
  // no existe en el navegador: vive en el servidor, detrás de /api.
  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    const t = window.AisenAuth && window.AisenAuth.token();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  // Cuota real, la que dicta el servidor. El contador local es solo un reflejo.
  let serverQuota = null;
  function applyServerQuota(q) {
    if (!q) return;
    serverQuota = q;
    if (window.AisenAuth) window.AisenAuth.setPlan(q.planLabel || q.plan);
    updateTokenBadge();
  }

  // Envía un turno de chat. Devuelve el texto de la respuesta.
  async function chat(mode, userText) {
    let msgs = history.concat([{ role: 'user', content: userText }]);
    // Auto-mejora: inyecta el perfil aprendido como system (si existe).
    if (window.AisenAuto && window.AisenAuto.systemContext()) {
      msgs = [{ role: 'system', content: window.AisenAuto.systemContext() }].concat(msgs);
    }
    const body = {
      model: CONFIG.modeModel[mode] || 'auto',
      messages: msgs,
      stream: CONFIG.streaming
    };

    // Web activada (toggle): cadena de búsqueda con failover multi-modelo.
    if (webEnabled) {
      return await webSearchChat(userText, mode);
    }

    const resp = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const detail = await safeText(resp);
      const limpio = esHtml(detail) ? '' : String(detail).slice(0, 200);
      throw new Error('HTTP ' + resp.status + (limpio ? ' · ' + limpio : ''));
    }

    // El backend fuerza stream:false para contar los tokens exactos que
    // reporta el motor. La respuesta llega como JSON aunque aquí se pidiera
    // streaming: nos guiamos por el tipo real, no por lo que pedimos.
    const tipo = resp.headers.get('content-type') || '';
    if (tipo.includes('text/event-stream') && resp.body) {
      return await readSSE(resp);
    }
    const data = await resp.json();
    const content = data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;
    if (typeof content !== 'string' || !content) {
      throw new Error('Respuesta vacía del motor');
    }
    recordUsage(data.usage);
    applyServerQuota(data.aisen_quota);
    return content;
  }

  // Modo Web: intenta modelos con busqueda real (grounding) en cadena.
  // Si todos estan en cuota, cae al routing 'auto' del motor con nota honesta.
  const WEB_MODELS = [
    'gemini-3.5-flash-lite', // mas cuota gratis en AI Studio
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.1-flash-lite'
  ];

  async function webSearchChat(userText, mode) {
    let messages = history.concat([{ role: 'user', content: userText }]);
    // Auto-mejora también en el camino web.
    if (window.AisenAuto && window.AisenAuto.systemContext()) {
      messages = [{ role: 'system', content: window.AisenAuto.systemContext() }].concat(messages);
    }
    const lastErrors = [];

    for (const model of WEB_MODELS) {
      try {
        const resp = await fetch(apiUrl('/chat/completions'), {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            model: model,
            messages: messages,
            stream: false, // grounding responde de una, sin stream
            tools: [{
              type: 'function',
              function: { name: 'google_search', description: 'Buscar en internet', parameters: {} }
            }]
          })
        });
        if (!resp.ok) {
          lastErrors.push(model + ': HTTP ' + resp.status);
          continue; // modelo en cuota o caido -> siguiente en la cadena
        }
        const data = await resp.json();
        const content = data.choices &&
          data.choices[0] &&
          data.choices[0].message &&
          data.choices[0].message.content;
        if (typeof content === 'string' && content) {
          recordUsage(data.usage);
          return content;
        }
        lastErrors.push(model + ': respuesta vacía');
      } catch (e) {
        lastErrors.push(model + ': ' + (e.message || e));
      }
    }

    // Fallback final: el modelo del modo activo sin búsqueda (pero responde).
    try {
      const resp = await fetch(apiUrl('/chat/completions'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          model: CONFIG.modeModel[mode] || 'auto',
          messages: messages,
          stream: false
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        const content = data.choices &&
          data.choices[0] &&
          data.choices[0].message &&
          data.choices[0].message.content;
        if (typeof content === 'string' && content) {
          recordUsage(data.usage);
          return content;
        }
      }
    } catch (_) { /* cayó el fallback, seguimos al error honesto */ }

    throw new Error('Todos los modelos de búsqueda fallaron: ' + lastErrors.join(' | '));
  }

  // Lee un stream SSE de OpenAI y devuelve el texto completo concatenado.
  async function readSSE(resp) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (line === 'data: [DONE]') return full;
        if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices &&
              obj.choices[0] &&
              obj.choices[0].delta &&
              obj.choices[0].delta.content;
            if (delta) full += delta;
            if (obj.usage) recordUsage(obj.usage);
          } catch (_) { /* chunk no JSON, ignorar */ }
        }
      }
    }
    return full;
  }

  function recordUsage(usage) {
    if (!usage) return;
    const t = usage.total_tokens != null ? usage.total_tokens
      : (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    if (t > 0) {
      TokenStore.add(t);
      updateTokenBadge();
    }
  }

  // Un servidor que no conoce la ruta contesta con una página de error en
  // HTML. Volcarla en el chat no le dice nada a nadie: la descartamos.
  function esHtml(t) {
    return /^\s*(<!doctype|<html|<\?xml)/i.test(String(t || ''));
  }

  async function safeText(resp) {
    try {
      const t = await resp.text();
      return t.length > 300 ? t.slice(0, 300) + '…' : t;
    } catch (_) { return ''; }
  }

  /* ========================= MOTOR DE VOZ CLONADA ========================= */
  // Flujo completo: grabar muestra → clonar → escribir → escuchar → descargar.
  // La grabación del navegador es webm/opus; la convertimos a WAV PCM en el
  // cliente (AudioContext.decodeAudioData) porque Chatterbox acepta .wav/.mp3.

  let clonedVoice = null; // { filename, audioUrl } de la voz clonada por el usuario

  function encodeWav(pcm, sampleRate) {
    const numCh = 1;
    const bytesPerSample = 2;
    const dataLen = pcm.length * bytesPerSample;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, numCh, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * numCh * bytesPerSample, true);
    v.setUint16(32, numCh * bytesPerSample, true); v.setUint16(34, 16, true);
    writeStr(36, 'data'); v.setUint32(40, dataLen, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // Graba con el micrófono y se DETIENE SOLA cuando el usuario hace una pausa.
  // AnalyserNode mide el volumen en vivo: si baja del umbral por `pauseSec`,
  // la grabación termina. `maxSec` es el techo de seguridad.
  function recordSample(maxSec, pauseSec) {
    const max = maxSec || 20;
    const pause = pauseSec || 1.2;
    return new Promise(function (resolve, reject) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        reject(new Error('Tu navegador no permite grabar el micrófono.'));
        return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (stream) {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const levels = new Float32Array(analyser.fftSize);

          const recorder = new MediaRecorder(stream);
          const chunks = [];
          let settled = false;
          let silentMs = 0;
          let lastCheck = performance.now();
          let startedAt = performance.now();
          let hadSpeech = false;

          function rms() {
            analyser.getFloatTimeDomainData(levels);
            let sum = 0;
            for (let i = 0; i < levels.length; i++) sum += levels[i] * levels[i];
            return Math.sqrt(sum / levels.length);
          }

          function stopNow() {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            try { if (recorder.state === 'recording') recorder.stop(); }
            catch (_) { /* ya estaba detenido */ }
          }

          // Detecta pausa: volumen bajo por `pause` segundos seguidos.
          const timer = setInterval(function () {
            const now = performance.now();
            const dt = now - lastCheck;
            lastCheck = now;
            const vol = rms();
            const speaking = vol > 0.012;
            if (speaking) {
              hadSpeech = true;
              silentMs = 0;
            } else {
              silentMs += dt;
            }
            if (now - startedAt > 700 && hadSpeech && silentMs >= pause * 1000) {
              stopNow();
            }
            if (now - startedAt >= max * 1000) {
              stopNow(); // techo de seguridad
            }
          }, 120);

          recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
          recorder.onstop = async function () {
            clearInterval(timer);
            stream.getTracks().forEach(function (t) { t.stop(); });
            try {
              const webm = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
              const arrayBuf = await webm.arrayBuffer();
              const decoded = await ctx.decodeAudioData(arrayBuf);
              const src = decoded.getChannelData(0);
              const targetRate = 24000;
              const ratio = decoded.sampleRate / targetRate;
              const len = Math.floor(src.length / ratio);
              const pcm = new Float32Array(len);
              for (let i = 0; i < len; i++) pcm[i] = src[Math.floor(i * ratio)];
              ctx.close();
              resolve(encodeWav(pcm, targetRate));
            } catch (e) {
              reject(new Error('No pude convertir la grabación: ' + e.message));
            }
          };
          recorder.onerror = function () {
            clearInterval(timer);
            stream.getTracks().forEach(function (t) { t.stop(); });
            reject(new Error('El micrófono falló durante la grabación.'));
          };
          recorder.start();
        })
        .catch(function () {
          reject(new Error('No pude acceder al micrófono. Revisa los permisos del navegador.'));
        });
    });
  }

  // Sube la muestra al motor de voz (via backend) y la deja clonada.
  async function uploadVoiceSample(wavBlob) {
    const buf = await wavBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const dataBase64 = btoa(bin);
    const filename = 'usuario_' + Date.now() + '.wav';
    const resp = await fetch(apiUrl('/voices/upload'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ filename: filename, dataBase64: dataBase64 })
    });
    const data = await resp.json().catch(function () { return null; });
    if (!resp.ok || !data) {
      const detail = data && (data.detail || data.error);
      throw new Error(detail ? String(detail) : 'HTTP ' + resp.status);
    }
    return filename;
  }

  // Transcribe un WAV con el motor (whisper de Groq vía FreeLLMAPI).
  async function transcribeAudio(wavBlob) {
    const buf = await wavBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const dataBase64 = btoa(bin);
    const resp = await fetch(apiUrl('/audio/transcriptions'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ dataBase64: dataBase64, filename: 'grabacion_' + Date.now() + '.wav' })
    });
    const data = await resp.json().catch(function () { return null; });
    if (!resp.ok || !data) {
      const detail = data && (data.detail || data.error);
      throw new Error(detail ? String(detail) : 'HTTP ' + resp.status);
    }
    applyServerQuota(data.aisen_quota);
    return data.text || '';
  }

  // Sintetiza texto con la voz clonada. Devuelve { url, blob }.
  async function synthesizeCloned(text, voiceName) {
    const resp = await fetch(apiUrl('/audio/speech'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: CONFIG.voice.model,
        input: text,
        voice: voiceName || (clonedVoice && clonedVoice.filename),
        response_format: 'wav'
      })
    });
    if (!resp.ok) {
      const detail = await safeText(resp);
      const limpio = esHtml(detail) ? '' : String(detail).slice(0, 200);
      throw new Error('HTTP ' + resp.status + (limpio ? ' · ' + limpio : ''));
    }
    const blob = await resp.blob();
    return { url: URL.createObjectURL(blob), blob: blob };
  }

  /* ======================= TUTOR DE VOZ (profesor) ======================== */
  // Flujo: grabar voz → decir qué aprender → lección hablada en tu voz.
  // El texto de la lección se genera con la ruta inteligente del motor
  // (auto:smart = el mejor modelo sano disponible); la voz la pone el
  // motor de clonación (Chatterbox).

  let isBusy = false;
  let tutorContext = ''; // resumen rodante de la lección, para continuarla
  let tutorTopic = '';

  const TUTOR_SYSTEM =
    'Eres un profesor particular experto, claro y motivador. El estudiante ' +
    'quiere aprender un tema concreto. Genera una lección de 8 a 12 minutos ' +
    'de lectura, en español, en markdown limpio, con esta estructura:\n' +
    '## Objetivo de hoy\nQué logrará el estudiante al terminar.\n' +
    '## Ideas clave\nMáximo 4 conceptos, cada uno con una analogía cotidiana y un ejemplo breve.\n' +
    '## Ejemplo resuelto\nUn caso práctico paso a paso.\n' +
    '## Pruébate\n2 o 3 preguntas de recuerdo activo (sin respuestas).\n' +
    '## Siguiente paso\nQué viene después.\n' +
    'Aplica chunking (máximo 4 ideas a la vez), analogías y ejemplos concretos. ' +
    'Frases claras y cercanas, sin relleno ni clichés.';

  // Genera el texto de la lección con la ruta inteligente del motor.
  async function tutorChat(userPrompt) {
    const msgs = [{ role: 'system', content: TUTOR_SYSTEM }];
    if (window.AisenAuto && window.AisenAuto.systemContext()) {
      msgs.push({ role: 'system', content: window.AisenAuto.systemContext() });
    }
    msgs.push({ role: 'user', content: userPrompt });
    const resp = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'auto:smart', messages: msgs, stream: false })
    });
    if (!resp.ok) {
      const detail = await safeText(resp);
      const limpio = esHtml(detail) ? '' : String(detail).slice(0, 200);
      throw new Error('HTTP ' + resp.status + (limpio ? ' · ' + limpio : ''));
    }
    const data = await resp.json();
    const content = data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string' || !content) {
      throw new Error('Respuesta vacía del motor.');
    }
    recordUsage(data.usage);
    return content;
  }

  // Recorta la lección para el audio automático: solo el objetivo de hoy.
  // La lección completa (8-12 min) se sintetiza bajo demanda con 🔊 Escuchar;
  // el motor de voz es CPU y una llamada gigante lo deja masticando minutos.
  function shortenForSpeech(rawText) {
    const m = String(rawText || '').match(/##\s*Objetivo de hoy\s*\n([\s\S]*?)(?=\n##|\n$)/i);
    const objetivo = m ? m[1].trim() : '';
    const intro = String(rawText || '')
      .replace(/^#.*$/gm, '')
      .trim()
      .split(/\n+/)[0] || '';
    const corto = (objetivo || intro).replace(/[*#`>|]/g, ' ').replace(/\s+/g, ' ').trim();
    return corto.slice(0, 420);
  }

  // Habla la lección completa con la voz clonada (se reproduce sola al estar lista).
  async function autoSpeakLesson(lineEl, rawText) {
    try {
      const res = await synthesizeCloned(rawText);
      res.text = rawText;
      lastAudio = res;
      const prev = lineEl.querySelectorAll('audio');
      prev.forEach(function (a) { a.remove(); });
      const audio = document.createElement('audio');
      audio.className = 'aisen-audio';
      audio.controls = true;
      audio.src = res.url;
      audio.autoplay = true;
      lineEl.appendChild(audio);
      voiceStatus.textContent = '✅ Lección lista y hablada con tu voz.';
    } catch (_) { /* el botón 🔊 de la línea queda para reintentar */ }
  }

  // El corazón del modo: pedir el tema y generar la lección hablada.
  async function generateLesson(continuar) {
    const topic = topicInput.value.trim();
    if (!clonedVoice) {
      voiceStatus.innerHTML =
        '<span class="aisen-err">Graba tu voz primero: el tutor habla con ella.</span>';
      return;
    }
    if (!topic) {
      voiceStatus.innerHTML =
        '<span class="aisen-err">Escribe qué quieres aprender.</span>';
      return;
    }
    setBusy(true);
    voiceStatus.textContent = continuar
      ? '📚 Preparando la continuación…'
      : '🎓 Tu profesor está preparando la lección…';
    appendMessage('user',
      (continuar ? '📚 Continuar lección: ' : '🎓 Quiero aprender: ') + esc(topic));
    const out = appendBotStream();
    try {
      const prompt = (continuar && tutorContext)
        ? 'CONTINUACIÓN de la lección sobre "' + topic + '". Avanza a la ' +
          'siguiente sección, más profunda, sin repetir lo ya enseñado. ' +
          'Lo ya visto, en resumen:\n' + tutorContext.slice(-1400) +
          '\n\nGenera la siguiente parte con la misma estructura.'
        : 'El estudiante quiere aprender: ' + topic;
      const full = await tutorChat(prompt);
      const rendered = appendBotRendered(full);
      out.parentNode.replaceWith(rendered);
      tutorContext = (tutorContext + '\n' + full).slice(-2400);
      tutorTopic = topic;
      // Segundo cerebro y auto-mejora también aprenden de la lección.
      if (window.AisenBrain) {
        window.AisenBrain.logTurn(topic, full);
        window.AisenBrain.extractConcepts(topic, full);
      }
      if (window.AisenAuto) {
        window.AisenAuto.observe(topic, full);
        window.AisenAuto.reflectMaybe();
      }
      if (pet()) { pet().activity('voice'); pet().celebrate(); }
      continueBtn.style.display = 'inline-block';
      voiceStatus.textContent = '✅ Lección lista. Preparando el audio…';
      autoSpeakLesson(rendered, shortenForSpeech(full));
    } catch (e) {
      const cursor = out.parentNode.querySelector('.cursor');
      if (cursor) cursor.remove();
      out.parentNode.innerHTML =
        'AI SEN: <span class="aisen-err">' + engineError(e) + '</span>';
      voiceStatus.innerHTML =
        '<span class="aisen-err">' + esc(e.message || e) + '</span>';
    } finally {
      setBusy(false);
      updateTokenBadge();
    }
  }

  function updateTutorState() {
    const hasTopic = topicInput.value.trim().length > 0;
    lessonBtn.disabled = !clonedVoice || !hasTopic || isBusy;
    recordBtn.textContent = clonedVoice ? '🎤 Regrabar mi voz' : '🎤 Grabar mi voz';
    if (!clonedVoice) {
      voiceStatus.textContent =
        'Todavía no has clonado tu voz. Grábala para que tu tutor hable contigo.';
    } else if (!hasTopic) {
      voiceStatus.textContent = '✅ Voz lista. Ahora escribe qué quieres aprender.';
    }
  }

  // Pregunta al backend qué muestras clonadas existen (referencias del usuario).
  async function loadVoices() {
    try {
      const resp = await fetch(apiUrl('/voices'), {
        headers: authHeaders()
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const names = (Array.isArray(data) ? data : (data.files || data.voices || []))
        .map(function (v) { return typeof v === 'string' ? v : (v.filename || v.name); })
        .filter(Boolean);
      return names;
    } catch (e) {
      return null; // motor de voz apagado o sin login
    }
  }

  // Descarga un blob con el truco del ancla + fallback de ventana nueva.
  function downloadAudio(url, name) {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); }, 100);
    } catch (_) {
      window.open(url, '_blank');
    }
  }

  // PDF tipo paper: abre una ventana con la respuesta formateada como
  // documento académico (LaTeX renderizado, márgenes, cajetín) y la
  // impresión del navegador la guarda como PDF.
  function attachPdfButton(lineEl, rawText) {
    const wrap = document.createElement('span');
    wrap.className = 'aisen-speak-wrap';

    const btn = document.createElement('button');
    btn.className = 'aisen-speak';
    btn.textContent = '📄 PDF';
    btn.title = 'Guardar esta respuesta como documento (paper)';
    btn.addEventListener('click', function () {
      openPaperWindow(rawText);
    });
    wrap.appendChild(btn);
    lineEl.appendChild(wrap);
  }

  // El documento lo arma paper.js: convierte el markdown en tipografía de
  // libro (sin asteriscos ni almohadillas a la vista) y aplica APA en
  // tablas, figuras, ecuaciones numeradas y referencias.
  function openPaperWindow(rawText, titulo) {
    if (window.AisenPaper) {
      window.AisenPaper.abrir(rawText, titulo || 'AI SEN — Documento');
      return;
    }
    alert('El generador de documentos no cargó. Recarga la página.');
  }

  // Añade a una línea del bot los controles 🔊 escuchar y ⬇ descargar.
  // En el modo tutor, el audio hablado es un RESUMEN del objetivo: el motor
  // de voz corre en CPU y una lección de 8-12 min lo dejaría masticando
  // minutos enteros (la lección completa se lee y se descarga como PDF).
  function attachSpeakButton(lineEl, rawText) {
    if (!rawText) return;
    const speakText = (activeMode === 'voz')
      ? shortenForSpeech(rawText)
      : rawText;
    if (!speakText) return;
    const wrap = document.createElement('span');
    wrap.className = 'aisen-speak-wrap';

    const btn = document.createElement('button');
    btn.className = 'aisen-speak';
    btn.textContent = (activeMode === 'voz') ? '🔊 Escuchar resumen' : '🔊 Escuchar';
    btn.title = (activeMode === 'voz')
      ? 'Escuchar el objetivo de la lección en tu voz clonada'
      : 'Escuchar esta respuesta en tu voz clonada';
    btn.addEventListener('click', function () {
      speakInto(lineEl, speakText, btn);
    });
    wrap.appendChild(btn);

    // Descargar SIEMPRE funciona: si aún no hay audio, lo genera al vuelo.
    const dl = document.createElement('button');
    dl.className = 'aisen-speak';
    dl.textContent = '⬇ Descargar';
    dl.title = 'Descargar el audio en tu voz';
    dl.addEventListener('click', async function () {
      if (dl.dataset.busy) return;
      dl.dataset.busy = '1';
      dl.textContent = '⏳ Generando…';
      try {
        let res = lastAudio;
        if (!res || res.text !== speakText) {
          res = await synthesizeCloned(speakText);
          res.text = speakText;
          lastAudio = res;
        }
        downloadAudio(res.url, 'aisen-voz.wav');
        dl.textContent = '⬇ Descargar';
      } catch (e) {
        dl.textContent = '⬇ Descargar';
        const err = document.createElement('span');
        err.className = 'aisen-err';
        err.textContent = ' 🔇 ' + (e.message || 'Motor de voz apagado.');
        lineEl.appendChild(err);
      } finally {
        delete dl.dataset.busy;
      }
    });
    wrap.appendChild(dl);

    lineEl.appendChild(wrap);
  }

  let lastAudio = null; // { url } del último audio generado

  async function speakInto(lineEl, rawText, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Clonando…'; }
    try {
      const res = await synthesizeCloned(rawText);
      res.text = rawText;
      lastAudio = res;
      // limpia audios anteriores en esta línea
      const prev = lineEl.querySelectorAll('audio');
      prev.forEach(function (a) { a.remove(); });
      const audio = document.createElement('audio');
      audio.className = 'aisen-audio';
      audio.controls = true;
      audio.src = res.url;
      audio.autoplay = true;
      lineEl.appendChild(audio);
      if (btn) { btn.textContent = '🔊 Escuchar'; btn.disabled = false; }
      // Fidelización: usar el clonador cuenta como uso de voz.
      if (pet()) pet().activity('voice');
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '🔊 Escuchar'; }
      const err = document.createElement('span');
      err.className = 'aisen-err';
      err.textContent = ' 🔇 ' + (e.message || 'Motor de voz apagado.');
      lineEl.appendChild(err);
    }
  }

  /* ============================ ACCIONES ================================== */
  function pet() { return window.AisenPet; }

  async function handleSend() {
    const text = input.value.trim();
    if (!text) return;

    if (TokenStore.remaining() <= 0) {
      appendMessage('bot', '<span class="aisen-err">Límite diario alcanzado. ' +
        'Vuelve mañana o desbloquea más tokens.</span>');
      return;
    }

    // Cariño: si el mensaje es afectuoso, la pet suelta corazones.
    if (/^(gracias|good bot|te quiero|ily|thanks|thank you|<3|💙|❤|🩵|✨)\b/i.test(text) ||
        text.includes('💙') || text.includes('❤') || text.includes('✨')) {
      if (pet()) pet().affection();
    }

    input.value = '';
    appendMessage('user', esc(text));
    history.push({ role: 'user', content: text });

    if (pet()) pet().activity('chat');
    if (pet()) pet().work();
    await runChat(text);
  }

  async function runChat(userText) {
    setBusy(true);
    const out = appendBotStream();
    try {
      const full = await chat(activeMode, userText);
      if (!full) throw new Error('Respuesta vacía del motor.');
      // Reemplaza la linea de streaming por el render final (markdown+LaTeX).
      const rendered = appendBotRendered(full);
      out.parentNode.replaceWith(rendered);
      history.push({ role: 'assistant', content: full });
      if (!TokenStore._usedReported) TokenStore.add(estimateTokens(full));
      // Segundo cerebro: registra el intercambio y extrae conceptos.
      if (window.AisenBrain) {
        window.AisenBrain.logTurn(userText, full);
        window.AisenBrain.extractConcepts(userText, full);
      }
      // Auto-mejora: observar el intercambio y, cada N, reflexionar.
      if (window.AisenAuto) {
        window.AisenAuto.observe(userText, full);
        window.AisenAuto.reflectMaybe();
      }
      if (pet()) pet().celebrate();
    } catch (e) {
      const cursor = out.parentNode.querySelector('.cursor');
      if (cursor) cursor.remove();
      out.parentNode.innerHTML =
        'AI SEN: <span class="aisen-err">' + engineError(e) + '</span>';
      if (pet()) pet().failed();
    } finally {
      setBusy(false);
      updateTokenBadge();
    }
  }

  function engineError(e) {
    if (e instanceof TypeError) {
      // Fetch falló: red caída, CORS, o el servidor no responde.
      return '🛑 Motor apagado. No pude conectar con el endpoint (' +
        CONFIG.baseUrl + '). Verifica que FreeLLMAPI esté corriendo.';
    }
    const m = String(e.message || e);

    // 404/405/501: hay un servidor, pero no es nuestro backend. Es lo que
    // pasa al abrir la web sin el stack levantado (por ejemplo en local,
    // servida por un servidor de archivos que no acepta POST).
    if (/HTTP (404|405|501)\b/.test(m)) {
      return '🔌 El backend de AI SEN no está corriendo en esta dirección. ' +
        'La web se ve, pero el chat necesita el servidor levantado ' +
        '(docker compose up en el VPS).';
    }
    if (m.includes('rate_limit') || m.includes('429')) {
      return '⏳ Cuota de búsqueda agotada por ahora (Google limita las consultas gratis por día). ' +
        'Inténtalo en unos minutos o cambia a otro modo.';
    }
    return '🛑 Motor apagado: ' + esc(m);
  }

  // Consulta si ya hay una voz clonada en el servidor y actualiza el panel.
  async function refreshVoices() {
    const names = await loadVoices();
    if (names === null) {
      voiceStatus.innerHTML =
        '<span class="aisen-err">🔇 Motor de voz apagado.</span>';
      recordBtn.disabled = false;
      return;
    }
    if (names.length) {
      // Recupera la última voz clonada (la más reciente del usuario).
      clonedVoice = { filename: names[names.length - 1] };
    } else {
      clonedVoice = null;
    }
    updateTutorState();
  }

  /* ============================ INICIO ==================================== */
  function setupModeButtons() {
    modeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        modeButtons.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeMode = btn.getAttribute('data-mode') || 'rapido';
        voiceRow.style.display = (activeMode === 'voz') ? 'flex' : 'none';
        // La barra de escritura (con micrófono y cerebrito) es solo del chatbot.
        inputRow.style.display = (activeMode === 'rapido') ? 'flex' : 'none';
        if (activeMode === 'voz') refreshVoices();
        if (activeMode === 'vision') {
          // El chatbox se transforma en la pizarra del modo visión.
          if (window.AisenVision) window.AisenVision.show();
        } else if (window.AisenVision) {
          window.AisenVision.destroy();
        }
      });
    });
  }

  // Inyecta estilos mínimos para los controles que este script añade.
  function injectStyles() {
    if (document.getElementById('aisen-style')) return;
    const s = document.createElement('style');
    s.id = 'aisen-style';
    s.textContent = [
      '.aisen-input-row{display:flex;gap:10px;margin-top:16px}',
      '.aisen-input-row textarea{flex:1;resize:none;font-family:inherit;' +
        'font-size:14.5px;color:var(--ink);background:rgba(5,8,16,.6);' +
        'border:1px solid var(--glass-line);border-radius:12px;padding:12px 14px;' +
        'min-height:46px;outline:none}',
      '.aisen-input-row textarea:focus{border-color:var(--accent)}',
      '.aisen-mic{padding:0 14px;border:1px solid var(--glass-line);border-radius:12px;' +
        'cursor:pointer;font-size:17px;background:rgba(92,225,230,.1);' +
        'color:var(--ink);font-family:inherit;transition:.2s}',
      '.aisen-mic:hover{border-color:var(--accent);background:rgba(92,225,230,.22)}',
      '.aisen-mic.rec{background:rgba(255,77,141,.25);border-color:var(--accent2);' +
        'animation:mic-pulse 1.2s infinite}',
      '@keyframes mic-pulse{0%,100%{opacity:1}50%{opacity:.6}}',
      '.aisen-lip{padding:0 14px;border:1px solid rgba(255,212,121,.45);border-radius:12px;' +
        'cursor:pointer;font-size:17px;background:rgba(255,212,121,.08);' +
        'color:var(--ink);font-family:inherit;transition:.2s}',
      '.aisen-lip:hover{border-color:#ffd479;background:rgba(255,212,121,.2)}',
      '.aisen-lip.rec{background:rgba(255,77,141,.25);border-color:var(--accent2);' +
        'animation:mic-pulse 1.2s infinite}',
      '.aisen-brain-tool{padding:0 14px;border:1px solid rgba(255,212,121,.4);border-radius:12px;' +
        'cursor:pointer;font-size:17px;background:rgba(255,212,121,.08);' +
        'color:var(--ink);font-family:inherit;transition:.2s}',
      '.aisen-brain-tool:hover{border-color:#ffd479;background:rgba(255,212,121,.2)}',
      '.aisen-tutor{margin-top:16px;border:1px solid var(--glass-line);border-radius:16px;' +
        'padding:16px 18px;background:rgba(10,16,30,.5);display:flex;flex-direction:column;gap:12px}',
      '.aisen-tutor .tu-title{font-size:15px;font-weight:700;color:var(--ink);letter-spacing:.02em}',
      '.aisen-tutor .tu-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.aisen-tutor .tu-topic{flex:1;min-width:220px;resize:none;font-family:inherit;font-size:14.5px;' +
        'color:var(--ink);background:rgba(5,8,16,.6);border:1px solid var(--glass-line);' +
        'border-radius:12px;padding:11px 14px;outline:none;min-height:44px}',
      '.aisen-tutor .tu-topic:focus{border-color:var(--accent)}',
      '.aisen-tutor .tu-chips{display:flex;gap:8px;flex-wrap:wrap}',
      '.aisen-tutor .tu-chip{padding:6px 12px;border-radius:999px;border:1px solid rgba(92,225,230,.4);' +
        'background:rgba(92,225,230,.08);color:var(--accent);font-size:12px;cursor:pointer;' +
        'font-family:inherit;transition:.15s}',
      '.aisen-tutor .tu-chip:hover{background:rgba(92,225,230,.22)}',
      '.aisen-tutor .tu-go{padding:10px 18px;border:none;border-radius:12px;font-weight:700;font-size:14px;' +
        'color:#031018;background:linear-gradient(135deg,var(--accent),#2ea8d8);cursor:pointer;' +
        'font-family:inherit;transition:.2s}',
      '.aisen-tutor .tu-go:disabled{opacity:.5;cursor:not-allowed}',
      '.aisen-tutor .tu-cont{padding:9px 16px;border-radius:12px;border:1px solid rgba(255,212,121,.5);' +
        'background:rgba(255,212,121,.1);color:#ffd479;font-weight:600;font-size:13.5px;' +
        'cursor:pointer;font-family:inherit;transition:.2s}',
      '.aisen-tutor .tu-cont:hover{background:rgba(255,212,121,.24)}',
      '.aisen-tutor .tu-record{padding:9px 16px;border-radius:11px;border:1px solid var(--glass-line);' +
        'background:rgba(92,225,230,.1);color:var(--ink);cursor:pointer;font-size:13.5px;' +
        'font-family:inherit;transition:.2s}',
      '.aisen-tutor .tu-record:hover{border-color:var(--accent)}',
      '.aisen-tutor .tu-status{font-size:13px;color:var(--muted);flex:1;min-width:160px}',
      '.aisen-send{padding:0 22px;border:none;border-radius:12px;cursor:pointer;' +
        'font-weight:600;font-size:14.5px;color:#031018;' +
        'background:linear-gradient(135deg,var(--accent),#2ea8d8);transition:.2s}',
      '.aisen-send:hover{transform:translateY(-1px)}',
      '.aisen-send:disabled{opacity:.5;cursor:not-allowed}',
      '.aisen-tokens{font-size:12.5px;color:var(--muted);margin-top:12px;' +
        'letter-spacing:.02em}',
      '.aisen-tokens.low{color:var(--accent2)}',
      '.aisen-err{color:var(--accent2)}',
      '.aisen-audio{width:100%;max-width:360px;margin-top:6px;display:block}',
      '.aisen-speak{background:rgba(92,225,230,.14);border:1px solid var(--glass-line);' +
        'color:var(--ink);border-radius:8px;padding:1px 8px;margin-left:8px;' +
        'cursor:pointer;font-size:13px;line-height:1.6}',
      '.aisen-speak:hover{background:rgba(92,225,230,.28)}',
      '.aisen-speak-wrap{display:inline-flex;gap:8px;margin-left:8px;vertical-align:middle}',
      '.line code{background:rgba(92,225,230,.12);padding:1px 6px;' +
        'border-radius:6px;font-size:13px}',
      '.aisen-body p{margin:4px 0}',
      '.aisen-body ul{margin:6px 0 6px 18px;padding:0}',
      '.aisen-body li{margin:2px 0;color:var(--ink)}',
      '.aisen-body h2,.aisen-body h3,.aisen-body h4{margin:10px 0 4px;color:var(--ink)}',
      '.aisen-body h2{font-size:17px}.aisen-body h3{font-size:15.5px}.aisen-body h4{font-size:14px}',
      '.aisen-body .md-code{background:rgba(5,8,16,.75);border:1px solid var(--glass-line);' +
        'border-radius:10px;padding:12px;margin:8px 0;overflow-x:auto;font-size:13px}',
      '.aisen-body .md-code code{background:transparent;padding:0}',
      '.aisen-body .katex{color:var(--ink);font-size:1.05em}',
      '.aisen-body .katex-display{margin:10px 0;overflow-x:auto;padding:2px}',
      '.aisen-body .md-tex-raw{opacity:.7}',
      // Tablas: ancho completo, sin caja, solo lineas finas.
      '.md-table{width:100%;overflow-x:auto;margin:10px 0}',
      '.md-table table{width:100%;border-collapse:collapse;font-size:13px;' +
        'font-variant-numeric:tabular-nums}',
      '.md-table th{text-align:left;color:var(--accent);font-weight:600;' +
        'padding:6px 12px 6px 0;border-bottom:1px solid rgba(160,220,255,.35);' +
        'font-size:11.5px;letter-spacing:.08em;text-transform:uppercase}',
      '.md-table td{padding:6px 12px 6px 0;border-bottom:1px solid rgba(160,220,255,.12);' +
        'color:#d7e3f4;white-space:nowrap}',
      '.md-table tr:last-child td{border-bottom:none}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function init() {
    if (!chatbox) {
      console.warn('[AI SEN] No encontré #chatbox en el DOM.');
      return;
    }
    injectStyles();

    // Inserta contador, barra de entrada y controles creativos.
    chatbox.parentNode.insertBefore(tokenBadge, chatbox.nextSibling);
    chatbox.parentNode.insertBefore(inputRow, chatbox.nextSibling);
    chatbox.parentNode.insertBefore(voiceRow, chatbox.nextSibling);

    setupModeButtons();
    sendBtn.addEventListener('click', handleSend);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // 🧠 Segundo cerebro: abre la red a pantalla completa (overlay).
    brainBtn.addEventListener('click', function () {
      if (window.AisenBrain) window.AisenBrain.show();
    });

    // 👄 Leer labios: la cámara detecta cuándo hablas y cuándo terminaste;
    // el motor transcribe. Igual que el micrófono, con la señal de los labios.
    lipBtn.addEventListener('click', function () {
      if (!window.AisenLip) {
        appendMessage('bot', '<span class="aisen-err">👄 El lector de labios no cargó. Recarga la página.</span>');
        return;
      }
      if (window.AisenLip.active()) {
        window.AisenLip.stop();
        lipBtn.classList.remove('rec');
        return;
      }
      lipBtn.classList.add('rec');
      window.AisenLip.start(function (r) {
        lipBtn.classList.remove('rec');
        if (r.error) {
          appendMessage('bot', '<span class="aisen-err">👄 ' + esc(r.error) + '</span>');
          return;
        }
        const texto = r.text.trim();
        if (!texto) return;
        // Muestra lo que se leyó y responde.
        appendMessage('user', '👄 ' + esc(texto));
        if (pet()) { pet().activity('chat'); pet().work(); }
        runChat(texto);
      });
    });

    // 🎙 Grabar (chat): micrófono → transcripción → respuesta automática.
    micBtn.addEventListener('click', async function () {
      if (micBtn.dataset.rec) return;
      micBtn.dataset.rec = '1';
      micBtn.classList.add('rec');
      const original = micBtn.textContent;
      try {
        micBtn.textContent = '🔴';
        const wav = await recordSample(20, 1.2); // se detiene sola en la pausa
        micBtn.textContent = '⏳';
        const texto = await transcribeAudio(wav);
        if (!texto) throw new Error('No escuché nada. Inténtalo de nuevo.');
        micBtn.textContent = original;
        micBtn.classList.remove('rec');
        // Muestra lo que escuchó y responde.
        appendMessage('user', '🎙 ' + esc(texto));
        if (pet()) { pet().activity('chat'); pet().work(); }
        await runChat(texto);
        history.push({ role: 'user', content: texto });
      } catch (e) {
        micBtn.textContent = original;
        micBtn.classList.remove('rec');
        appendMessage('bot', '<span class="aisen-err">🎙 ' + esc(e.message || e) + '</span>');
      } finally {
        delete micBtn.dataset.rec;
      }
    });
    // 🎤 Grabar mi voz: micrófono → WAV → subir al motor → clonada.
    recordBtn.addEventListener('click', async function () {
      if (recordBtn.dataset.recording) return;
      recordBtn.dataset.recording = '1';
      const original = recordBtn.textContent;
      try {
        for (let s = 3; s > 0; s--) {
          recordBtn.textContent = '🎙 Habla en ' + s + '…';
          voiceStatus.textContent = 'Preparando el micrófono…';
          await new Promise(function (r) { setTimeout(r, 1000); });
        }
        recordBtn.textContent = '🔴 Grabando… habla con naturalidad';
        voiceStatus.textContent = 'Grabando tu muestra (10 segundos).';
        // Muestra de clonación: duración fija (la pausa no la corta).
        const wav = await recordSample(10, 999);
        recordBtn.textContent = '⏳ Clonando tu voz…';
        voiceStatus.textContent = 'Subiendo la muestra al motor…';
        const filename = await uploadVoiceSample(wav);
        clonedVoice = { filename: filename };
        voiceStatus.textContent = '✅ Voz clonada. Ahora escribe qué quieres aprender.';
        updateTutorState();
        topicInput.focus();
        if (pet()) {
          pet().activity('voice');
          pet().celebrate();
        }
      } catch (e) {
        voiceStatus.innerHTML = '<span class="aisen-err">' + esc(e.message || e) + '</span>';
        recordBtn.textContent = original;
      } finally {
        delete recordBtn.dataset.recording;
      }
    });

    // 🎓 Tutor: generar la lección y continuarla.
    lessonBtn.addEventListener('click', function () { generateLesson(false); });
    continueBtn.addEventListener('click', function () { generateLesson(true); });
    topicInput.addEventListener('input', updateTutorState);
    topicInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!lessonBtn.disabled) generateLesson(false);
      }
    });

    updateTokenBadge();

    // Saludo inicial (no consume tokens: es texto local).
    appendMessage('bot', 'Soy AI SEN. Pregúntame lo que quieras. ' +
      'En el modo <b>🗣 Clonar voz</b> grabas tu voz y un profesor te da ' +
      'lecciones habladas con ella: idiomas, matemáticas, preparar una ' +
      'prueba, lo que quieras aprender — con audio descargable y PDF.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
