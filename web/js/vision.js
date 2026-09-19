/* ============================================================================
 * AI SEN — Modo Visión (pizarra + computer vision)
 * ----------------------------------------------------------------------------
 * Un copiloto de pizarra:
 *   - el usuario dibuja (a mano o con el mouse) una suma, una integral,
 *     una viga, una fundación, una casa…
 *   - el modo captura la pizarra y la manda a un modelo de VISIÓN del motor
 *     FreeLLMAPI (image_url content part, API estándar /chat/completions).
 *   - el modelo interpreta y resuelve: matemática paso a paso en LaTeX,
 *     geometría técnica con dimensiones estimadas.
 *   - la respuesta se ve renderizada (KaTeX), se puede guardar como PDF
 *     elegante en LaTeX, la pizarra se descarga como imagen PNG, y si el
 *     dibujo es técnico se genera una macro de FreeCAD para modelarlo en 3D
 *     y exportar STL (imprimir en 3D / BIM). También genera memoria/EETT.
 * ========================================================================== */
(function () {
  'use strict';

  // Cadena de failover: SOLO modelos de visión con key cargada en el motor.
  // (glm/zhipu, reka y cohere devuelven 503 "sin key configurada"; no entran.)
  const VISION_MODELS = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.1-flash-lite',
    'gemma-4-31b-it'
  ];

  const PAPER_MODEL = 'auto:smart'; // texto largo (memoria, macro FreeCAD)

  let view = null;        // { close }
  let savedChat = null;
  let lastAnswer = '';    // último análisis (para FreeCAD / memoria)

  // Estado compartido de la herramienta de dibujo (mouse Y cámara).
  let curTool = 'pen';
  let curColor = '#5ce1e6';
  let curWidth = 4;

  const PALETTE = [
    { c: '#5ce1e6', t: 'Cian' }, { c: '#ff4d8d', t: 'Rosa' },
    { c: '#ffd479', t: 'Dorado' }, { c: '#eaf2ff', t: 'Blanco' },
    { c: '#7ae9ff', t: 'Celeste' }, { c: '#b48cff', t: 'Violeta' }
  ];
  const TOOLS = [
    { id: 'pen', t: '✏️ Lápiz' },
    { id: 'line', t: '📏 Línea' },
    { id: 'rect', t: '▭ Rectángulo' },
    { id: 'ellipse', t: '⬭ Elipse' },
    { id: 'eraser', t: '🧽 Borrar' }
  ];

  /* ----------------------------- UTILIDADES ------------------------------ */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function injectStyles() {
    if (document.getElementById('aisen-vision-style')) return;
    const s = document.createElement('style');
    s.id = 'aisen-vision-style';
    s.textContent = [
      '.vision-wrap{display:flex;flex-direction:column;gap:12px}',
      '.vision-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.vision-title{font-size:15px;font-weight:700;color:var(--ink);margin-right:auto}',
      '.vision-sub{font-size:12px;color:var(--muted)}',
      '.vision-tools{display:flex;gap:8px;flex-wrap:wrap}',
      '.vision-tool{padding:6px 12px;border-radius:999px;border:1px solid rgba(92,225,230,.4);' +
        'background:rgba(92,225,230,.08);color:var(--accent);font-size:12.5px;cursor:pointer;' +
        'font-family:inherit;transition:.15s}',
      '.vision-tool:hover{background:rgba(92,225,230,.2)}',
      '.vision-tool.on{background:rgba(92,225,230,.35);border-color:var(--accent);' +
        'color:#031018;font-weight:700}',
      '.vision-cam-btn{padding:6px 12px;border-radius:999px;border:1px solid rgba(255,212,121,.55);' +
        'background:rgba(255,212,121,.12);color:#ffd479;font-size:12.5px;cursor:pointer;' +
        'font-family:inherit;font-weight:700;transition:.15s}',
      '.vision-cam-btn:hover{background:rgba(255,212,121,.26)}',
      '.vision-cam-btn.on{background:rgba(255,77,141,.25);border-color:#ff4d8d;color:#ff4d8d;' +
        'animation:mic-pulse 1.2s infinite}',
      '.vision-guide{width:100%;max-width:720px;display:block;border-radius:12px;' +
        'border:1px solid var(--glass-line)}',
      '.vision-colors{display:flex;gap:6px;align-items:center}',
      '.vision-color{width:20px;height:20px;border-radius:50%;border:2px solid transparent;' +
        'cursor:pointer;transition:.15s}',
      '.vision-color.on{border-color:var(--ink);transform:scale(1.15)}',
      '.vision-widths{display:flex;gap:6px;align-items:center}',
      '.vision-width{width:26px;height:26px;border-radius:50%;border:1px solid var(--glass-line);' +
        'background:rgba(5,8,16,.6);color:var(--muted);font-size:11px;cursor:pointer;' +
        'font-family:inherit;display:inline-flex;align-items:center;justify-content:center}',
      '.vision-width.on{border-color:var(--accent);color:var(--accent)}',
      '.vision-canvas-wrap{position:relative;border:1px solid var(--glass-line);' +
        'border-radius:14px;background:rgba(5,8,16,.7);overflow:hidden}',
      '.vision-canvas{display:block;width:100%;cursor:crosshair;touch-action:none}',
      '.vision-overlay{position:absolute;inset:0;pointer-events:none;display:block;z-index:1}',
      '.vision-cam{position:absolute;bottom:12px;right:12px;width:230px;max-width:42%;' +
        'border-radius:12px;border:2.5px solid rgba(255,212,121,.7);transform:scaleX(-1);' +
        'opacity:.97;background:#000;z-index:2;display:block;' +
        'box-shadow:0 8px 28px rgba(0,0,0,.55);transition:border-color .2s}',
      '.vision-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.vision-btn{padding:8px 14px;border-radius:11px;border:1px solid var(--glass-line);' +
        'background:rgba(92,225,230,.1);color:var(--ink);cursor:pointer;font-size:13px;' +
        'font-family:inherit;font-weight:600;transition:.2s}',
      '.vision-btn:hover{border-color:var(--accent);background:rgba(92,225,230,.22)}',
      '.vision-btn.primary{border:none;background:linear-gradient(135deg,var(--accent),#2ea8d8);' +
        'color:#031018}',
      '.vision-btn.primary:disabled{opacity:.5;cursor:not-allowed}',
      '.vision-btn.gold{border:1px solid rgba(255,212,121,.5);background:rgba(255,212,121,.1);' +
        'color:#ffd479}',
      '.vision-btn.pink{border:1px solid rgba(255,77,141,.45);background:rgba(255,77,141,.1);' +
        'color:#ff4d8d}',
      '.vision-ask{display:flex;gap:10px;margin-top:2px}',
      '.vision-ask input{flex:1;background:rgba(5,8,16,.6);border:1px solid var(--glass-line);' +
        'border-radius:11px;padding:9px 13px;color:var(--ink);font-size:13.5px;' +
        'font-family:inherit;outline:none}',
      '.vision-ask input:focus{border-color:var(--accent)}',
      '.vision-hint{font-size:11.5px;color:var(--muted);opacity:.8}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* --------------------------- VISTA PRINCIPAL --------------------------- */
  function renderVision(container) {
    container.innerHTML = '';
    injectStyles();
    const wrap = document.createElement('div');
    wrap.className = 'vision-wrap';

    // Cabecera
    const head = document.createElement('div');
    head.className = 'vision-head';
    head.innerHTML =
      '<span class="vision-title">👁 Pizarra inteligente</span>' +
      '<span class="vision-sub">dibuja y el modelo de visión lo entiende</span>';
    wrap.appendChild(head);

    // Herramientas: el botón Webcam va PRIMERO, antes del lápiz.
    const tools = document.createElement('div');
    tools.className = 'vision-tools';
    const camToggle = document.createElement('button');
    camToggle.type = 'button';
    camToggle.id = 'visCam';
    camToggle.className = 'vision-cam-btn';
    camToggle.textContent = '📹 Webcam';
    camToggle.title = 'Conecta la cámara: dibuja con tu dedo índice';
    tools.appendChild(camToggle);
    TOOLS.forEach(function (t) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vision-tool' + (t.id === 'pen' ? ' on' : '');
      b.textContent = t.t;
      b.setAttribute('data-tool', t.id);
      tools.appendChild(b);
    });
    const colors = document.createElement('div');
    colors.className = 'vision-colors';
    PALETTE.forEach(function (p, i) {
      const c = document.createElement('span');
      c.className = 'vision-color' + (i === 0 ? ' on' : '');
      c.style.background = p.c;
      c.title = p.t;
      c.setAttribute('data-color', p.c);
      colors.appendChild(c);
    });
    const widths = document.createElement('div');
    widths.className = 'vision-widths';
    [2, 4, 7].forEach(function (w, i) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vision-width' + (i === 1 ? ' on' : '');
      b.textContent = '●';
      b.style.fontSize = (9 + w * 2.2) + 'px';
      b.setAttribute('data-width', w);
      widths.appendChild(b);
    });
    tools.appendChild(colors);
    tools.appendChild(widths);
    wrap.appendChild(tools);

    // Guía visual: iniciar → dibujar → guardar → seguir → guardar.
    const guide = document.createElement('img');
    guide.className = 'vision-guide';
    guide.src = '/assets/guia-camara.svg';
    guide.alt = 'Guía de la cámara pizarra: iniciar la webcam, dibujar con el dedo, guardar la página, seguir dibujando y guardar de nuevo';
    wrap.appendChild(guide);

    // Canvas (pizarra) + overlay (indicador del dedo) + video (cámara).
    const cwrap = document.createElement('div');
    cwrap.className = 'vision-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'vision-canvas';
    const overlay = document.createElement('canvas');
    overlay.className = 'vision-overlay';
    const video = document.createElement('video');
    video.className = 'vision-cam';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.display = 'none';
    cwrap.appendChild(canvas);
    cwrap.appendChild(overlay);
    cwrap.appendChild(video);
    wrap.appendChild(cwrap);

    // Acciones
    const actions = document.createElement('div');
    actions.className = 'vision-actions';
    actions.innerHTML =
      '<button class="vision-btn primary" id="visAnalyze">📷 Analizar pizarra</button>' +
      '<button class="vision-btn" id="visSolve">🧮 Resolver matemática</button>' +
      '<button class="vision-btn" id="visAskGo">💬 Preguntar</button>' +
      '<button class="vision-btn gold" id="visPdf">📄 PDF LaTeX</button>' +
      '<button class="vision-btn" id="visImg">🖼 Descargar imagen</button>' +
      '<button class="vision-btn pink" id="visCad">🧊 FreeCAD → STL</button>' +
      '<button class="vision-btn" id="visMem">📐 Memoria/EETT</button>' +
      '<button class="vision-btn" id="visClear">🗑 Limpiar</button>';
    wrap.appendChild(actions);

    // Pregunta libre
    const ask = document.createElement('div');
    ask.className = 'vision-ask';
    ask.innerHTML =
      '<input id="visAskInput" placeholder="Pregunta sobre tu dibujo (ej: ¿cuánto vale esta integral?)">' +
      '<button class="vision-btn" id="visAskSend">Enviar</button>';
    wrap.appendChild(ask);

    const hint = document.createElement('div');
    hint.className = 'vision-hint';
    hint.textContent =
      '📹 Conecta la webcam y dibuja con tu dedo índice · el modelo de visión lee la pizarra y responde con LaTeX';
    wrap.appendChild(hint);

    container.appendChild(wrap);
    initCanvas(canvas, overlay, tools, colors, widths);
    initButtons();
  }

  /* ------------------------------ PIZARRA -------------------------------- */
  // La pizarra acepta DOS punteros: el mouse/touch Y el dedo índice de la
  // cámara (MediaPipe). Ambos usan el mismo estado (curTool/curColor/curWidth)
  // y las mismas primitivas de trazo, así que el resultado es idéntico.
  function initCanvas(canvas, overlayEl, toolsEl, colorsEl, widthsEl) {
    const ctx = canvas.getContext('2d');
    const octx = overlayEl.getContext('2d');
    let drawing = false, startX = 0, startY = 0, moved = 0;
    let lastX = 0, lastY = 0;
    let snapshot = null; // para vista previa de lineas/rect/elipse

    function size() {
      const w = canvas.parentNode.clientWidth || 600;
      const h = Math.max(320, Math.min(420, w * 0.52));
      const dpr = window.devicePixelRatio || 1;
      const old = ctx.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      overlayEl.width = canvas.width;
      overlayEl.height = canvas.height;
      overlayEl.style.width = w + 'px';
      overlayEl.style.height = h + 'px';
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // restaurar dibujo al redimensionar
      if (old && old.width > 0) {
        const tmp = document.createElement('canvas');
        tmp.width = old.width; tmp.height = old.height;
        tmp.getContext('2d').putImageData(old, 0, 0);
        ctx.drawImage(tmp, 0, 0, w, h);
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.clearRect(0, 0, w, h);
      }
    }
    size();
    window.addEventListener('resize', function () { size(); });

    /* ---- primitivas de trazo (compartidas por mouse y cámara) ---- */
    function beginStroke(x, y) {
      drawing = true; moved = 0;
      startX = x; startY = y; lastX = x; lastY = y;
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (curTool === 'pen' || curTool === 'eraser') {
        ctx.strokeStyle = curTool === 'eraser' ? 'rgba(0,0,0,0)' : curColor;
        ctx.globalCompositeOperation = curTool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.lineWidth = curTool === 'eraser' ? curWidth * 5 : curWidth;
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
    }
    function strokeTo(x, y) {
      if (!drawing) return;
      moved += Math.abs(x - lastX) + Math.abs(y - lastY);
      if (curTool === 'pen' || curTool === 'eraser') {
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        preview();
        drawShape(x, y, false);
      }
      lastX = x; lastY = y;
    }
    function endStroke() {
      if (!drawing) return;
      drawing = false;
      if (curTool !== 'pen' && curTool !== 'eraser' && moved === 0) {
        preview(); drawShape(startX + 30, startY + 30, true);
      }
      ctx.globalCompositeOperation = 'source-over';
      snapshot = null;
    }
    function preview() {
      if (!snapshot) return;
      ctx.putImageData(snapshot, 0, 0);
    }
    function drawShape(x, y, commit) {
      if (commit) ctx.putImageData(snapshot, 0, 0);
      ctx.strokeStyle = curColor;
      ctx.lineWidth = curWidth;
      ctx.beginPath();
      if (curTool === 'line') {
        ctx.moveTo(startX, startY);
        ctx.lineTo(x, y);
      } else if (curTool === 'rect') {
        ctx.rect(Math.min(startX, x), Math.min(startY, y),
          Math.abs(x - startX), Math.abs(y - startY));
      } else if (curTool === 'ellipse') {
        ctx.ellipse((startX + x) / 2, (startY + y) / 2,
          Math.abs(x - startX) / 2, Math.abs(y - startY) / 2, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    /* ---- puntero clásico: mouse y touch ---- */
    function pos(e) {
      const rect = canvas.getBoundingClientRect();
      const t = e.touches && e.touches.length ? e.touches[0] : e;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }
    canvas.addEventListener('mousedown', function (e) {
      const p = pos(e);
      beginStroke(p.x, p.y);
    });
    canvas.addEventListener('mousemove', function (e) {
      const p = pos(e);
      strokeTo(p.x, p.y);
    });
    window.addEventListener('mouseup', function () { endStroke(); });
    canvas.addEventListener('touchstart', function (e) {
      e.preventDefault();
      const p = pos(e);
      beginStroke(p.x, p.y);
    }, { passive: false });
    canvas.addEventListener('touchmove', function (e) {
      e.preventDefault();
      const p = pos(e);
      strokeTo(p.x, p.y);
    }, { passive: false });
    canvas.addEventListener('touchend', function (e) {
      e.preventDefault();
      endStroke();
    }, { passive: false });

    // herramientas
    toolsEl.querySelectorAll('.vision-tool').forEach(function (b) {
      b.addEventListener('click', function () {
        curTool = b.getAttribute('data-tool');
        toolsEl.querySelectorAll('.vision-tool').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    });
    colorsEl.querySelectorAll('.vision-color').forEach(function (c) {
      c.addEventListener('click', function () {
        curColor = c.getAttribute('data-color');
        colorsEl.querySelectorAll('.vision-color').forEach(function (x) { x.classList.remove('on'); });
        c.classList.add('on');
      });
    });
    widthsEl.querySelectorAll('.vision-width').forEach(function (w) {
      w.addEventListener('click', function () {
        curWidth = parseInt(w.getAttribute('data-width'), 10);
        widthsEl.querySelectorAll('.vision-width').forEach(function (x) { x.classList.remove('on'); });
        w.classList.add('on');
      });
    });

    canvas.clear = function () {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    // API para el dedo de la cámara (mismas primitivas que el mouse).
    canvas.beginStroke = beginStroke;
    canvas.strokeTo = strokeTo;
    canvas.endStroke = endStroke;
    // Huesos de la mano (índices del modelo de MediaPipe): pulgar, índice,
    // medio, anular, meñique y la palma que los une.
    const HUESOS = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],
      [0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],
      [5,9],[9,13],[13,17]
    ];

    // Se dibuja la mano ENTERA sobre la pizarra. Ver el esqueleto moverse es
    // lo que le dice al usuario "te estoy viendo" — un punto suelto no basta
    // para saber si la cámara te encontró o está perdida.
    canvas.drawHand = function (lm, cssW, cssH, pintando) {
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);
      octx.clearRect(0, 0, w, h);
      if (!lm || !lm.length) return;
      const px = function (p) { return [(1 - p.x) * cssW, p.y * cssH]; };
      const color = pintando ? '#5ce1e6' : 'rgba(255,212,121,.75)';

      octx.lineWidth = 2.5;
      octx.strokeStyle = pintando ? 'rgba(92,225,230,.55)' : 'rgba(255,212,121,.4)';
      HUESOS.forEach(function (par) {
        const a = lm[par[0]], b = lm[par[1]];
        if (!a || !b) return;
        const p1 = px(a), p2 = px(b);
        octx.beginPath();
        octx.moveTo(p1[0], p1[1]);
        octx.lineTo(p2[0], p2[1]);
        octx.stroke();
      });

      octx.fillStyle = color;
      lm.forEach(function (p, i) {
        const q = px(p);
        octx.beginPath();
        octx.arc(q[0], q[1], i === 8 ? 5 : 3, 0, Math.PI * 2);
        octx.fill();
      });

      // La punta del índice: el lápiz. Se marca más fuerte, y en cian
      // cuando está pintando, para que el gesto se entienda solo.
      const tip = lm[8];
      if (tip) {
        const q = px(tip);
        octx.beginPath();
        octx.arc(q[0], q[1], pintando ? 15 : 11, 0, Math.PI * 2);
        octx.fillStyle = pintando ? 'rgba(92,225,230,.28)' : 'rgba(255,212,121,.2)';
        octx.fill();
        octx.strokeStyle = color;
        octx.lineWidth = 2;
        octx.stroke();
      }
    };

    canvas.drawPointer = function (x, y) {
      // indicador del dedo sobre el overlay
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);
      octx.clearRect(0, 0, w, h);
      octx.beginPath();
      octx.arc(x, y, 12, 0, Math.PI * 2);
      octx.fillStyle = 'rgba(255,212,121,.35)';
      octx.fill();
      octx.strokeStyle = '#ffd479';
      octx.lineWidth = 1.5;
      octx.stroke();
      octx.beginPath();
      octx.arc(x, y, 3, 0, Math.PI * 2);
      octx.fillStyle = '#ffd479';
      octx.fill();
    };
    canvas.clearPointer = function () {
      const w = canvas.width / (window.devicePixelRatio || 1);
      const h = canvas.height / (window.devicePixelRatio || 1);
      octx.clearRect(0, 0, w, h);
    };
    canvas.toDataURL = canvas.toDataURL.bind(canvas);
  }

  /* ------------------------- CÁMARA PIZARRA ------------------------------ */
  // El dedo índice de la mano se rastrea con MediaPipe Hands (corre 100% en
  // el navegador, modelos locales en /assets/mediapipe). MediaPipe NO es un
  // LLM: solo detecta la posición del dedo; el análisis de la pizarra sigue
  // siendo de los modelos de visión de FreeLLMAPI.
  let cam = null; // { stream, handLandmarker, raf, active }
  let camGesture = false; // dedo "abajo" (pulgar pegado a la palma)

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

  async function loadHandLandmarker() {
    if (window.__aisenHandLandmarker) return window.__aisenHandLandmarker;
    const mp = await cargarMediaPipe();
    if (!mp.HandLandmarker) throw new Error('MediaPipe cargó sin HandLandmarker.');
    const fileset = await mp.FilesetResolver.forVisionTasks('/assets/mediapipe/wasm');
    const landmarker = await mp.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/assets/mediapipe/hand_landmarker.task' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    window.__aisenHandLandmarker = landmarker;
    return landmarker;
  }


  // Geometría de la palma: ¿el índice está "extendido"? La pintura se activa
  // cuando la punta del índice está bien por delante del nudillo medio (dedo
  // apuntando). Así la palma abierta NO pinta; solo apuntar con el índice.
  function indexExtended(lm) {
    const tip = lm[8], pip = lm[6], mcp = lm[5];
    if (!tip || !pip || !mcp) return false;
    const d1 = Math.hypot(tip.x - mcp.x, tip.y - mcp.y);
    const d2 = Math.hypot(pip.x - mcp.x, pip.y - mcp.y);
    return d1 > d2 * 1.35; // la punta claramente más lejos que la 2ª falange
  }

  async function startCamera() {
    const canvas = document.querySelector('.vision-canvas');
    const video = document.querySelector('.vision-cam');
    const btn = document.getElementById('visCam');
    if (!canvas || !video) return;
    if (cam && cam.active) { stopCamera(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      const landmarker = await loadHandLandmarker();
      cam = { stream: stream, landmarker: landmarker, active: true };
      video.style.display = 'block';
      if (btn) { btn.classList.add('on'); btn.textContent = '📹 Webcam: encendida'; }
      appendUser('📹 <b>Cámara pizarra encendida</b>: levanta la mano, apunta con tu dedo índice y dibuja en el aire.');
      loopCamera();
    } catch (e) {
      if (cam && cam.stream) {
        cam.stream.getTracks().forEach(function (t) { t.stop(); });
        cam = null;
      }
      appendBotStream().parentNode.innerHTML =
        'AI SEN: <span class="aisen-err">📹 ' + esc(e.message || e) +
        ' (la cámara pide permiso: permite el acceso en el navegador)</span>';
      if (btn) btn.classList.remove('on');
    }
  }

  function stopCamera() {
    if (cam && cam.stream) {
      cam.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    if (cam && cam.raf) cancelAnimationFrame(cam.raf);
    cam = null;
    camGesture = false;
    const video = document.querySelector('.vision-cam');
    const canvas = document.querySelector('.vision-canvas');
    const btn = document.getElementById('visCam');
    if (video) video.style.display = 'none';
    if (canvas && canvas.clearPointer) canvas.clearPointer();
    if (btn) { btn.classList.remove('on'); btn.textContent = '📹 Webcam'; }
  }

  // Sin este aviso, una cámara que no encuentra la mano y una cámara apagada
  // se ven exactamente igual: nada pasa y el usuario no sabe por qué.
  function estadoCamara(modo) {
    const v = document.querySelector('.vision-cam');
    const b = document.getElementById('visCam');
    if (!v || !b) return;
    if (modo === 'dibujando') {
      v.style.borderColor = '#5ce1e6';
      b.textContent = '✍️ Dibujando';
    } else if (modo === 'mano') {
      v.style.borderColor = 'rgba(255,212,121,.9)';
      b.textContent = '✋ Mano detectada';
    } else {
      v.style.borderColor = 'rgba(255,107,157,.7)';
      b.textContent = '🔍 Buscando tu mano…';
    }
  }

  function loopCamera() {
    if (!cam || !cam.active) return;
    cam.raf = requestAnimationFrame(loopCamera);
    const video = document.querySelector('.vision-cam');
    const canvas = document.querySelector('.vision-canvas');
    if (!video || video.readyState < 2 || !canvas) return;
    const now = performance.now();
    if (cam.lastTs && now - cam.lastTs < 33) return; // ~30 fps
    cam.lastTs = now;
    try {
      const res = cam.landmarker.detectForVideo(video, now);
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (res && res.landmarks && res.landmarks.length) {
        const lm = res.landmarks[0];
        const tip = lm[8];
        // La cámara es espejo: x se invierte para que dibujar en el aire
        // coincida con lo que se ve en el mini-video.
        const x = (1 - tip.x) * cssW;
        const y = tip.y * cssH;
        const paint = indexExtended(lm);
        canvas.drawHand(lm, cssW, cssH, paint);
        estadoCamara(paint ? 'dibujando' : 'mano');
        if (paint) {
          if (!camGesture) { canvas.beginStroke(x, y); camGesture = true; }
          else { canvas.strokeTo(x, y); }
        } else {
          if (camGesture) { canvas.endStroke(); camGesture = false; }
        }
      } else {
        canvas.clearPointer();
        estadoCamara('buscando');
        if (camGesture) { canvas.endStroke(); camGesture = false; }
      }
    } catch (e) { /* frame perdido, el loop sigue */ }
  }

  /* ------------------------------ API LLM -------------------------------- */
  function token() {
    return window.AisenAuth && window.AisenAuth.token();
  }
  function apiUrl(path) {
    return '/api/v1' + path;
  }

  function updateQuotaBadge(data) {
    if (!data || !data.aisen_quota) return;
    const el = document.querySelector('.aisen-tokens');
    if (el) {
      el.textContent = 'Tienes ' + Number(data.aisen_quota.remaining).toLocaleString('es-CL') + ' tokens hoy';
    }
  }

  // Manda la pizarra a un modelo de visión. Devuelve el texto de la respuesta.
  async function askVision(prompt, dataUrl) {
    const t = token();
    if (!t) throw new Error('Inicia sesión para usar la visión.');
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }];
    const lastErrors = [];
    for (const model of VISION_MODELS) {
      try {
        const resp = await fetch(apiUrl('/chat/completions'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
          body: JSON.stringify({ model: model, messages: messages, stream: false })
        });
        if (!resp.ok) {
          let d = '';
          try {
            const j = await resp.json();
            d = j && j.error
              ? (typeof j.error === 'string' ? j.error :
                 (j.error.message || JSON.stringify(j.error)))
              : (j.detail ? JSON.stringify(j.detail) : '');
          } catch (_) { /* no json */ }
          lastErrors.push(model + ': HTTP ' + resp.status + (d ? ' ' + String(d).slice(0, 60) : ''));
          continue;
        }
        const data = await resp.json();
        const content = data.choices && data.choices[0] &&
          data.choices[0].message && data.choices[0].message.content;
        if (typeof content === 'string' && content) {
          updateQuotaBadge(data);
          return content;
        }
        lastErrors.push(model + ': respuesta vacía');
      } catch (e) {
        lastErrors.push(model + ': ' + (e.message || e));
      }
    }
    throw new Error('Todos los modelos de visión fallaron: ' + lastErrors.join(' | '));
  }

  // Pide texto largo al motor (memoria, macro FreeCAD).
  async function askText(prompt) {
    const t = token();
    if (!t) throw new Error('Inicia sesión.');
    const resp = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
      body: JSON.stringify({
        model: PAPER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const content = data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string' || !content) throw new Error('Respuesta vacía del motor.');
    updateQuotaBadge(data);
    return content;
  }

  /* ------------------------------ UI CHAT -------------------------------- */
  function chatbox() { return document.getElementById('chatbox'); }

  function appendUser(html) {
    const line = document.createElement('div');
    line.className = 'line user';
    const uname = document.createElement('span');
    uname.className = 'uname';
    uname.textContent = 'Tú';
    const span = document.createElement('span');
    span.innerHTML = html;
    line.appendChild(uname);
    line.appendChild(span);
    chatbox().appendChild(line);
    chatbox().scrollTop = chatbox().scrollHeight;
    return line;
  }

  function appendBotStream() {
    const line = document.createElement('div');
    line.className = 'line bot';
    line.innerHTML = '<span class="aisen-label">AI SEN</span> ' +
      '<span class="aisen-out"></span><span class="cursor"></span>';
    chatbox().appendChild(line);
    chatbox().scrollTop = chatbox().scrollHeight;
    return line.querySelector('.aisen-out');
  }

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
    chatbox().appendChild(line);
    if (window.AisenRender && window.AisenRender.renderAisen) {
      window.AisenRender.renderAisen(body);
    } else if (window.AisenRender && window.AisenRender.renderMarkdown) {
      body.innerHTML = window.AisenRender.renderMarkdown(rawText);
    } else {
      body.innerHTML = esc(rawText).replace(/\n/g, '<br>');
    }
    addPdfButton(line, rawText);
    chatbox().scrollTop = chatbox().scrollHeight;
    return line;
  }

  // PDF LaTeX elegante (mismo estilo paper del chat).
  function addPdfButton(lineEl, rawText) {
    const wrap = document.createElement('span');
    wrap.className = 'aisen-speak-wrap';
    const btn = document.createElement('button');
    btn.className = 'aisen-speak';
    btn.textContent = '📄 PDF';
    btn.title = 'Guardar como PDF en LaTeX';
    btn.addEventListener('click', function () { openPaper(rawText); });
    wrap.appendChild(btn);
    lineEl.appendChild(wrap);
  }

  // El documento lo arma paper.js: tipografía de libro, sin sintaxis a la
  // vista, con tablas, figuras y ecuaciones numeradas según APA.
  function openPaper(rawText) {
    if (window.AisenPaper) {
      window.AisenPaper.abrir(rawText, 'AI SEN — Análisis de pizarra');
      return;
    }
    alert('El generador de documentos no cargó. Recarga la página.');
  }

  function downloadText(content, name, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 100);
  }

  /* ------------------------------ ACCIONES ------------------------------- */
  const PROMPTS = {
    analyze:
      'Eres un copiloto de pizarra. Mira la imagen: es una pizarra dibujada a mano. ' +
      '1) Describe brevemente qué ves. 2) Si hay matemática (sumas, restas, integrales, ' +
      'derivadas, ecuaciones, matrices), resuélvela paso a paso con LaTeX (usa $...$ y ' +
      '$$...$$). 3) Si es un dibujo técnico (viga, fundación, casa, plano), interpreta la ' +
      'geometría y propón dimensiones razonables. Responde en español, markdown limpio.',
    solve:
      'Resuelve TODA la matemática visible en esta pizarra, paso a paso, con LaTeX ' +
      '($...$ y $$...$$). Si hay sumas, integrales, derivadas o ecuaciones, da el ' +
      'resultado final destacado. Responde en español, markdown limpio.',
    describe:
      'Describe esta pizarra con detalle técnico: qué se dibujó, qué dimensiones ' +
      'aparentes tiene, y para qué serviría (estructura, plano, matemática). ' +
      'Responde en español, markdown limpio.'
  };

  function isBlank(dataUrl) {
    // PNG en blanco: decodificamos a canvas pequeño y miramos alfa.
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 3; i < d.length; i += 40) if (d[i] > 10) lit++;
        resolve(lit < 3);
      };
      img.onerror = function () { resolve(false); };
      img.src = dataUrl;
    });
  }

  function capture() {
    const canvas = document.querySelector('.vision-canvas');
    if (!canvas) throw new Error('Pizarra no disponible.');
    return canvas.toDataURL('image/png');
  }

  async function runAnalysis(prompt, label, withImage) {
    // La pizarra se captura y se valida ANTES de escribir en el chat, para
    // que el orden quede natural: pregunta del usuario, luego respuesta.
    let dataUrl;
    try {
      dataUrl = capture();
    } catch (e) {
      appendBotStream().parentNode.innerHTML =
        'AI SEN: <span class="aisen-err">👁 ' + esc(e.message || e) + '</span>';
      return;
    }
    if (await isBlank(dataUrl)) {
      appendBotStream().parentNode.innerHTML =
        'AI SEN: <span class="aisen-err">👁 La pizarra está vacía. Dibuja algo primero.</span>';
      return;
    }
    if (withImage) {
      appendUser('👁 ' + esc(label));
    }
    const out = appendBotStream();
    try {
      const full = await askVision(prompt, dataUrl);
      const rendered = appendBotRendered(full);
      out.parentNode.replaceWith(rendered);
      lastAnswer = full;
      // El segundo cerebro también aprende del dibujo.
      if (window.AisenBrain) {
        window.AisenBrain.logTurn('Pizarra: ' + label, full);
        window.AisenBrain.extractConcepts('Pizarra: ' + label, full);
      }
    } catch (e) {
      const cursor = out.parentNode.querySelector('.cursor');
      if (cursor) cursor.remove();
      // Mensaje corto: la muralla técnica queda en la consola, no en el chat.
      const m = String(e.message || e);
      out.parentNode.innerHTML =
        'AI SEN: <span class="aisen-err">👁 ' + esc(
          m.indexOf('Todos los modelos') >= 0
            ? 'No pude analizar la pizarra ahora (cuota de visión agotada). Inténtalo en unos minutos.'
            : m
        ) + '</span>';
    }
  }

  function initButtons() {
    const analyze = document.getElementById('visAnalyze');
    const solve = document.getElementById('visSolve');
    const pdf = document.getElementById('visPdf');
    const img = document.getElementById('visImg');
    const cad = document.getElementById('visCad');
    const mem = document.getElementById('visMem');
    const clear = document.getElementById('visClear');
    const camBtn = document.getElementById('visCam');
    const askInput = document.getElementById('visAskInput');
    const askSend = document.getElementById('visAskSend');
    const askGo = document.getElementById('visAskGo');

    function busy(b) {
      [analyze, solve, cad, mem, askSend].forEach(function (x) { x.disabled = b; });
    }

    // 📹 Cámara pizarra: el dedo índice se vuelve el lápiz.
    camBtn.addEventListener('click', startCamera);

    analyze.addEventListener('click', function () {
      busy(true);
      runAnalysis(PROMPTS.analyze, 'Análisis de la pizarra', true)
        .finally(function () { busy(false); });
    });
    solve.addEventListener('click', function () {
      busy(true);
      runAnalysis(PROMPTS.solve, 'Resolver la matemática', true)
        .finally(function () { busy(false); });
    });

    function doAsk() {
      const q = askInput.value.trim();
      if (!q) return;
      busy(true);
      runAnalysis(
        'Responde esta pregunta sobre la pizarra con LaTeX donde aplique: ' + q,
        q, true
      ).finally(function () { busy(false); });
      askInput.value = '';
    }
    askSend.addEventListener('click', doAsk);
    askGo.addEventListener('click', function () { askInput.focus(); });
    askInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doAsk();
    });

    // PDF LaTeX: del último análisis, o pide una descripción al vuelo.
    pdf.addEventListener('click', async function () {
      if (lastAnswer) {
        openPaper(lastAnswer);
        return;
      }
      const dataUrl = capture();
      if (await isBlank(dataUrl)) {
        alert('Dibuja algo primero, y luego genera el PDF.');
        return;
      }
      busy(true);
      const out = appendBotStream();
      try {
        const full = await askVision(PROMPTS.describe, dataUrl);
        lastAnswer = full;
        appendBotRendered(full);
        out.parentNode.remove();
        openPaper(full);
      } catch (e) {
        out.parentNode.innerHTML =
          'AI SEN: <span class="aisen-err">👁 ' + esc(e.message || e) + '</span>';
      } finally {
        busy(false);
      }
    });

    // Descargar la pizarra como imagen PNG.
    img.addEventListener('click', function () {
      try {
        const dataUrl = capture();
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = 'aisen-pizarra.png';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); }, 100);
      } catch (e) {
        alert('No pude descargar la pizarra: ' + (e.message || e));
      }
    });

    // FreeCAD: macro Python del dibujo + instrucciones STL/BIM.
    cad.addEventListener('click', async function () {
      const dataUrl = capture();
      if (await isBlank(dataUrl)) {
        alert('Dibuja una pieza o estructura primero (viga, fundación, casa).');
        return;
      }
      busy(true);
      const out = appendBotStream();
      try {
        if (!lastAnswer) lastAnswer = await askVision(PROMPTS.describe, dataUrl);
        const code = await askText(
          'A partir de esta descripción de un dibujo técnico, escribe SOLO código ' +
          'Python válido para una MACRO de FreeCAD (workbench Part) que modele la ' +
          'pieza en 3D con sólidos simples (cajas, cilindros, vigas, extrusión de ' +
          'bocetos). Al final del código añade: import Mesh; Mesh.export([shape], ' +
          '"modelo_aisen.stl"). Sin explicaciones fuera del código.\n\n' +
          'Descripción del dibujo:\n' + lastAnswer.slice(0, 2500)
        );
        const m = code.match(/```(?:python)?\s*([\s\S]*?)```/);
        const py = m ? m[1] : code;
        downloadText(py, 'aisen_freecad.py', 'text/x-python');
        const rendered = appendBotRendered(
          '## 🧊 FreeCAD\n\nTu dibujo se convirtió en una macro de FreeCAD ' +
          '(descargada: `aisen_freecad.py`).\n\n' +
          '### Cómo obtener el STL (imprimir en 3D) o BIM\n' +
          '1. Abre FreeCAD.\n' +
          '2. Menú **Macro → Macros… → Crear**, pega el código y ejecútalo.\n' +
          '3. La macro ya exporta `modelo_aisen.stl` al ejecutarla.\n' +
          '   (Alternativa: selecciona el sólido → **Archivo → Exportar → STL**.)\n' +
          '4. Para BIM: menú **Arquitectura/BIM**, importa el sólido como muro/losa.\n\n' +
          '> El STL se imprime directo en 3D; el IFC de FreeCAD se lleva a Revit/BIM.'
        );
        out.parentNode.replaceWith(rendered);
        lastAnswer = rendered.getAttribute
          ? (rendered.querySelector('.aisen-body') || {}).getAttribute('data-raw') || lastAnswer
          : lastAnswer;
      } catch (e) {
        const cursor = out.parentNode.querySelector('.cursor');
        if (cursor) cursor.remove();
        out.parentNode.innerHTML =
          'AI SEN: <span class="aisen-err">🧊 ' + esc(e.message || e) + '</span>';
      } finally {
        busy(false);
      }
    });

    // Memoria / EETT.
    mem.addEventListener('click', async function () {
      const dataUrl = capture();
      if (await isBlank(dataUrl)) {
        alert('Dibuja algo primero (estructura o plano).');
        return;
      }
      busy(true);
      const out = appendBotStream();
      try {
        if (!lastAnswer) lastAnswer = await askVision(PROMPTS.describe, dataUrl);
        const doc = await askText(
          'Genera una MEMORIA DE CÁLCULO técnica breve (estilo EETT chileno) en ' +
          'markdown para este elemento dibujado a mano. Incluye: 1) Descripción, ' +
          '2) Dimensiones asumidas, 3) Materiales típicos, 4) Cargas consideradas, ' +
          '5) Verificación básica con fórmulas LaTeX ($...$), 6) Recomendaciones. ' +
          'Sé honesto: esto es un predimensionado preliminar, no un cálculo definitivo.\n\n' +
          'Dibujo:\n' + lastAnswer.slice(0, 2500)
        );
        const rendered = appendBotRendered(doc);
        out.parentNode.replaceWith(rendered);
        lastAnswer = doc;
        openPaper(doc);
      } catch (e) {
        const cursor = out.parentNode.querySelector('.cursor');
        if (cursor) cursor.remove();
        out.parentNode.innerHTML =
          'AI SEN: <span class="aisen-err">📐 ' + esc(e.message || e) + '</span>';
      } finally {
        busy(false);
      }
    });

    clear.addEventListener('click', function () {
      const canvas = document.querySelector('.vision-canvas');
      if (canvas && canvas.clear) canvas.clear();
    });
  }

  /* ------------------------------ MOSTRAR -------------------------------- */
  function showVision() {
    const cb = chatbox();
    if (!cb) return;
    destroyView();
    injectStyles();
    if (savedChat === null) savedChat = cb.innerHTML;
    renderVision(cb);
    view = {
      close: function () {
        if (savedChat !== null) {
          cb.innerHTML = savedChat;
          savedChat = null;
        }
        view = null;
      }
    };
  }

  function destroyView() {
    stopCamera(); // apaga la webcam si estaba encendida
    if (view && view.close) view.close();
  }

  window.AisenVision = {
    show: showVision,
    destroy: destroyView
  };
})();
