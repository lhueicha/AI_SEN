/* ============================================================================
 * AI SEN — Lectura de labios (boquita 👄)
 * ----------------------------------------------------------------------------
 * La cámara "lee los labios" con MediaPipe Face Landmarker (corre 100% en el
 * navegador, modelo local en /assets/mediapipe). MediaPipe NO es un LLM: solo
 * detecta la apertura de la boca.
 *
 * Flujo:
 *   1. La cámara frontal + el micrófono se encienden.
 *   2. El detector mide la apertura de la boca en cada frame. Boca abierta
 *      y moviéndose = el usuario está HABLANDO.
 *   3. Cuando los labios quedan quietos/cerrados por una pausa (~1.2 s),
 *      el algoritmo determina que TERMINÓ — igual que la detección de pausa
 *      de la voz.
 *   4. El audio de ese lapso se transcribe con el motor FreeLLMAPI
 *      (whisper de Groq, el mismo del botón micrófono). La lectura de labios
 *      aporta la señal de habla/pausa; la transcripción de las palabras es
 *      del motor, como todo LLM de AI SEN.
 *
 * Honestidad técnica: no existe un modelo gratuito de lip-reading (labios →
 * texto sin audio) que corra en el navegador. Por eso los labios deciden
 * cuándo se habla y cuándo se terminó, y el motor transcribe el audio.
 * ========================================================================== */
(function () {
  'use strict';

  // Apertura de boca (ratio vertical/comisuras): arriba de OPEN = hablando,
  // abajo de CLOSED = silencio (histeresis para no parpadear entre estados).
  const MOUTH_OPEN = 0.17;
  const MOUTH_CLOSED = 0.12;
  const PAUSE_MS = 1200;  // labios quietos este tiempo => terminó
  const MAX_MS = 25000;   // techo de seguridad

  let session = null;     // { stream, landmarker, recorder, chunks, raf, ... }
  let ui = null;          // { wrap, video, label }

  /* ------------------------- DETECTOR DE CARA ---------------------------- */
  // El bundle de MediaPipe es un módulo ESM: expone sus clases como exports
  // con nombre, NO las cuelga de window. Hay que quedarse con el espacio de
  // nombres que devuelve import() — descartarlo y leer window.FilesetResolver
  // da undefined y revienta con TypeError en cada intento.
  async function cargarMediaPipe() {
    if (window.__aisenMediaPipe) return window.__aisenMediaPipe;
    let mod;
    try {
      mod = await import('/assets/mediapipe/vision_bundle.js');
    } catch (e) {
      throw new Error('No pude cargar MediaPipe desde /assets/mediapipe/. ' +
        'Detalle: ' + (e && e.message ? e.message : e));
    }
    const mp = {
      FilesetResolver: mod.FilesetResolver || window.FilesetResolver,
      HandLandmarker: mod.HandLandmarker || window.HandLandmarker,
      FaceLandmarker: mod.FaceLandmarker || window.FaceLandmarker
    };
    if (!mp.FilesetResolver) throw new Error('MediaPipe cargó sin FilesetResolver.');
    window.__aisenMediaPipe = mp;
    return mp;
  }

  async function loadFaceLandmarker() {
    if (window.__aisenFaceLandmarker) return window.__aisenFaceLandmarker;
    const mp = await cargarMediaPipe();
    if (!mp.FaceLandmarker) throw new Error('MediaPipe cargó sin FaceLandmarker.');
    const fileset = await mp.FilesetResolver.forVisionTasks('/assets/mediapipe/wasm');
    const landmarker = await mp.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/assets/mediapipe/face_landmarker.task' },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false
    });
    window.__aisenFaceLandmarker = landmarker;
    return landmarker;
  }


  // Ratio de apertura de la boca: distancia vertical entre el centro del
  // labio superior (13) e inferior (14), sobre la distancia entre comisuras
  // (61 y 291). Independiente de qué tan cerca esté la cara de la cámara.
  function mouthRatio(lm) {
    const up = lm[13], down = lm[14], left = lm[61], right = lm[291];
    if (!up || !down || !left || !right) return 0;
    const vert = Math.hypot(up.x - down.x, up.y - down.y);
    const horiz = Math.hypot(left.x - right.x, left.y - right.y) || 1e-6;
    return vert / horiz;
  }

  /* ----------------------------- UI FLOTANTE ----------------------------- */
  function injectStyles() {
    if (document.getElementById('aisen-lip-style')) return;
    const s = document.createElement('style');
    s.id = 'aisen-lip-style';
    s.textContent = [
      '.lip-wrap{position:fixed;right:18px;bottom:18px;z-index:1500;display:flex;',
      '  flex-direction:column;align-items:center;gap:6px}',
      '.lip-video{width:150px;border-radius:12px;border:2px solid rgba(255,212,121,.5);',
      '  transform:scaleX(-1);background:#000;transition:border-color .25s}',
      '.lip-video.speaking{border-color:rgba(92,225,230,.9);box-shadow:0 0 18px rgba(92,225,230,.35)}',
      '.lip-label{font-size:11px;color:#eaf2ff;background:rgba(4,6,13,.75);',
      '  padding:3px 10px;border-radius:999px;border:1px solid rgba(160,220,255,.2)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function makeUi(stream) {
    injectStyles();
    if (ui) { removeUi(); }
    const wrap = document.createElement('div');
    wrap.className = 'lip-wrap';
    const video = document.createElement('video');
    video.className = 'lip-video';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    const label = document.createElement('span');
    label.className = 'lip-label';
    label.textContent = '👄 Escuchando tus labios…';
    wrap.appendChild(video);
    wrap.appendChild(label);
    document.body.appendChild(wrap);
    ui = { wrap: wrap, video: video, label: label };
    video.srcObject = stream;
    return video.play();
  }

  function removeUi() {
    if (ui && ui.wrap && ui.wrap.parentNode) ui.wrap.parentNode.removeChild(ui.wrap);
    ui = null;
  }

  function setSpeaking(speaking) {
    if (!ui) return;
    ui.video.classList.toggle('speaking', speaking);
    ui.label.textContent = speaking ? '🔊 Hablando…' : '👄 Escuchando tus labios…';
  }

  /* ----------------------------- AUDIO ----------------------------------- */
  // El blob del MediaRecorder (webm/opus) se decodifica con AudioContext y
  // se re-encodifica a WAV PCM, que es lo que acepta el motor de voz.
  async function webmToWav(blob) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    const pcm = audio.getChannelData(0);
    const sampleRate = audio.sampleRate;
    const numCh = 1, bytesPerSample = 2;
    const dataLen = pcm.length * bytesPerSample;
    const ab = new ArrayBuffer(44 + dataLen);
    const v = new DataView(ab);
    const writeStr = function (off, s) {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
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
    return new Blob([ab], { type: 'audio/wav' });
  }

  // Transcribe con el motor FreeLLMAPI (whisper), igual que el micrófono.
  async function transcribe(wavBlob) {
    const buf = await wavBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const token = window.AisenAuth && window.AisenAuth.token();
    const resp = await fetch('/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (token || '')
      },
      body: JSON.stringify({
        dataBase64: btoa(bin),
        filename: 'labios_' + Date.now() + '.wav'
      })
    });
    if (!resp.ok) {
      const j = await resp.json().catch(function () { return null; });
      throw new Error(j && (j.error || j.detail) ? String(j.error || j.detail) : 'HTTP ' + resp.status);
    }
    const data = await resp.json();
    return data.text || '';
  }

  /* ------------------------------ SESIÓN --------------------------------- */
  function hardStop() {
    if (!session) return;
    if (session.raf) cancelAnimationFrame(session.raf);
    session.stream.getTracks().forEach(function (t) { t.stop(); });
    try { if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop(); } catch (_) { /* ya parado */ }
    session = null;
    setSpeaking(false);
    removeUi();
  }

  async function start(onResult) {
    if (session) { hardStop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true
      });
      const landmarker = await loadFaceLandmarker();
      let mime = '';
      try { mime = 'audio/webm;codecs=opus'; new MediaRecorder(stream, { mimeType: mime }); }
      catch (_) { mime = ''; }
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      recorder.start(250);
      await makeUi(stream);
      session = {
        stream: stream, landmarker: landmarker, recorder: recorder,
        chunks: chunks, raf: null, speaking: false, silentMs: 0,
        startedAt: performance.now(), lastTs: 0, onResult: onResult
      };
      loop();
    } catch (e) {
      hardStop();
      if (onResult) onResult({ text: null, error: String(e.message || e) });
    }
  }

  function loop() {
    if (!session) return;
    session.raf = requestAnimationFrame(loop);
    const video = ui && ui.video;
    if (!video || video.readyState < 2) return;
    const now = performance.now();
    if (now - session.lastTs < 33) return; // ~30 fps
    session.lastTs = now;
    try {
      const res = session.landmarker.detectForVideo(video, now);
      const lm = res && res.faceLandmarks && res.faceLandmarks.length
        ? res.faceLandmarks[0] : null;
      const hablando = lm ? mouthRatio(lm) > MOUTH_OPEN : false;
      if (hablando) {
        if (!session.speaking) setSpeaking(true);
        session.speaking = true;
        session.silentMs = 0;
      } else if (session.speaking) {
        session.silentMs += 33;
        if (session.silentMs >= PAUSE_MS) { finish(); return; }
      }
      if (now - session.startedAt >= MAX_MS) { finish(); return; }
    } catch (e) { /* frame perdido, el loop sigue */ }
  }

  async function finish() {
    const s = session;
    if (!s) return;
    s.raf && cancelAnimationFrame(s.raf);
    session = null;
    setSpeaking(false);
    try {
      if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
      const blob = await new Promise(function (resolve) {
        if (s.chunks.length) resolve(new Blob(s.chunks, { type: s.chunks[0].type || 'audio/webm' }));
        else resolve(null);
      });
      s.stream.getTracks().forEach(function (t) { t.stop(); });
      removeUi();
      if (!blob || blob.size < 1000) {
        s.onResult({ text: null, error: 'No escuché nada. Habla mirando a la cámara.' });
        return;
      }
      const wav = await webmToWav(blob);
      const texto = await transcribe(wav);
      s.onResult(texto ? { text: texto, error: null } : { text: null, error: 'No entendí. Inténtalo de nuevo.' });
    } catch (e) {
      if (s.stream) s.stream.getTracks().forEach(function (t) { t.stop(); });
      removeUi();
      s.onResult({ text: null, error: String(e.message || e) });
    }
  }

  /* ------------------------------ API ------------------------------------ */
  window.AisenLip = {
    start: start,
    stop: hardStop,
    active: function () { return !!session; }
  };
})();
