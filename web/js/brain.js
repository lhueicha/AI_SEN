/* ============================================================================
 * AI SEN — Segundo cerebro (patrón LLM Wiki de Karpathy)
 * ----------------------------------------------------------------------------
 * "Deja de recuperar. Empieza a compilar." — Karpathy
 *
 * Capa 1 (RAW): log inmutable de cada conversación {ts, user, bot}.
 * Capa 2 (WIKI): cada concepto es una PÁGINA que el LLM mantiene y densifica:
 *   - menciones acumuladas con fecha (compound: reaparecer = actualizar,
 *     nunca duplicar el nodo),
 *   - wikilinks a conceptos vecinos.
 * Capa 3 (VISTA): grafo 3D interactivo A PANTALLA COMPLETA (overlay):
 *   - click en nodo → ficha del concepto (menciones, fechas, relacionados)
 *   - chips clicables → navegas la red de concepto en concepto
 *   - scroll = zoom · arrastrar = girar · buscador = ilumina coincidencias
 *   - letras claras: etiqueta en píldora oscura, aristas gruesas y brillantes
 *   - export a un .md con frontmatter y [[wikilinks]] listo para Obsidian
 *   - se abre desde el cerebrito 🧠 de la barra del chatbot, se cierra con
 *     ✕ o ESC; el chat queda intacto detrás.
 * ========================================================================== */
(function () {
  'use strict';

  const LOG_KEY = 'aisen.brain.log';
  const GRAPH_KEY = 'aisen.brain.graph';

  /* ----------------------------- ESTADO --------------------------------- */
  let log = load(LOG_KEY, []);            // {ts, user, bot}[]
  let graph = load(GRAPH_KEY, { nodes: {}, edges: {} });
  // nodes: { key: { label, count, firstSeen, lastSeen, x, y, z,
  //                 mentions: [{ts, user, bot}] } }
  // edges: { "a||b": { weight } }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* lleno */ }
  }

  /* --------------------------- LOG DE CHATS ----------------------------- */
  function logTurn(userText, botText) {
    if (!userText || !botText) return;
    log.push({
      ts: new Date().toISOString(),
      user: String(userText).slice(0, 2000),
      bot: String(botText).slice(0, 4000)
    });
    if (log.length > 500) log = log.slice(-500);
    save(LOG_KEY, log);
  }

  /* ----------------------- EXTRACCIÓN DE CONCEPTOS ---------------------- */
  async function extractConcepts(userText, botText) {
    const token = window.AisenAuth && window.AisenAuth.token();
    if (!token) return;
    try {
      const resp = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          model: 'auto:fast',
          stream: false,
          messages: [{
            role: 'user',
            content: 'Extrae de este texto los conceptos clave (entre 2 y 6). ' +
              'Responde SOLO los conceptos, uno por línea, sin numerar, sin explicar.\n\n' +
              'Conversación:\nUsuario: ' + userText + '\nAI: ' + botText
          }]
        })
      });
      const data = await resp.json();
      const content = data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string' || !content) return;
      const concepts = content
        .split(/\n|[|,;]/)
        .map(function (c) { return c.replace(/^[\s\d.\-–>*]+/, '').trim(); })
        .filter(function (c) { return c.length > 1 && c.length < 60; })
        .slice(0, 6);
      addConcepts(concepts, userText, botText);
    } catch (_) { /* motor apagado: el log queda igual */ }
  }

  /* ------------------- WIKI: páginas que componen ----------------------- */
  function addConcepts(concepts, userText, botText) {
    const ts = new Date().toISOString();
    const seen = new Set();
    concepts.forEach(function (c) {
      const key = c.toLowerCase();
      if (!graph.nodes[key]) {
        graph.nodes[key] = {
          label: c,
          count: 0,
          firstSeen: ts,
          lastSeen: ts,
          mentions: [],
          x: (Math.random() - 0.5) * 2,
          y: (Math.random() - 0.5) * 2,
          z: (Math.random() - 0.5) * 2
        };
      }
      const n = graph.nodes[key];
      n.count++;
      n.lastSeen = ts;
      // compound: la página acumula menciones (no se duplica el nodo)
      n.mentions.push({
        ts: ts,
        user: String(userText || '').slice(0, 300),
        bot: String(botText || '').slice(0, 300)
      });
      if (n.mentions.length > 20) n.mentions = n.mentions.slice(-20);
      seen.add(key);
    });
    const keys = Array.from(seen);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const edgeKey = [keys[i], keys[j]].sort().join('||');
        if (!graph.edges[edgeKey]) graph.edges[edgeKey] = { weight: 1 };
        else graph.edges[edgeKey].weight++;
      }
    }
    save(GRAPH_KEY, graph);
  }

  function neighborsOf(key) {
    return Object.keys(graph.edges)
      .filter(function (ek) { return ek.split('||').indexOf(key) >= 0; })
      .map(function (ek) {
        const parts = ek.split('||');
        return parts[0] === key ? parts[1] : parts[0];
      });
  }

  /* ----------------------- EXPORT OBSIDIAN (.md) ------------------------ */
  function buildWikiMarkdown() {
    const keys = Object.keys(graph.nodes);
    const lines = [];
    const now = new Date().toISOString().slice(0, 10);
    lines.push('---');
    lines.push('title: Segundo Cerebro — AI SEN');
    lines.push('source: conversaciones del chatbot');
    lines.push('updated: ' + now);
    lines.push('---');
    lines.push('');
    lines.push('# 🧠 Segundo Cerebro');
    lines.push('');
    lines.push('> Wiki generada automáticamente por AI SEN (patrón LLM Wiki de Karpathy).');
    lines.push('> ' + keys.length + ' conceptos · ' + Object.keys(graph.edges).length +
      ' conexiones · ' + log.length + ' conversaciones.');
    lines.push('');
    lines.push('## Índice');
    lines.push('');
    keys.forEach(function (k) {
      lines.push('- [[' + graph.nodes[k].label + ']]');
    });
    lines.push('');
    lines.push('## Red de conexiones');
    lines.push('');
    Object.keys(graph.edges).forEach(function (ek) {
      const parts = ek.split('||');
      const a = graph.nodes[parts[0]] ? graph.nodes[parts[0]].label : parts[0];
      const b = graph.nodes[parts[1]] ? graph.nodes[parts[1]].label : parts[1];
      lines.push('- [[' + a + ']] ↔ [[' + b + ']]');
    });
    lines.push('');
    keys.forEach(function (k) {
      const n = graph.nodes[k];
      const neigh = neighborsOf(k)
        .filter(function (nk) { return graph.nodes[nk]; })
        .map(function (nk) { return '[[' + graph.nodes[nk].label + ']]'; });
      lines.push('---');
      lines.push('');
      lines.push('## ' + n.label);
      lines.push('');
      lines.push('tags: [concepto]');
      lines.push('created: ' + (n.firstSeen || '').slice(0, 10) +
        ' · updated: ' + (n.lastSeen || '').slice(0, 10));
      lines.push('menciones: ' + n.count);
      if (neigh.length) {
        lines.push('');
        lines.push('Relacionado con: ' + neigh.join(', '));
      }
      lines.push('');
      lines.push('### Registro');
      lines.push('');
      (n.mentions || []).forEach(function (m) {
        lines.push('- **' + (m.ts || '').slice(0, 10) + '** — "' + m.user.slice(0, 120) + '"');
        if (m.bot) lines.push('  → ' + m.bot.slice(0, 140));
      });
      lines.push('');
    });
    return lines.join('\n');
  }

  function downloadWiki() {
    const md = buildWikiMarkdown();
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aisen-segundo-cerebro.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 100);
  }

  /* ------------------- VISTA 3D A PANTALLA COMPLETA --------------------- */
  let overlay = null;
  let view = null;

  function injectStyles() {
    if (document.getElementById('aisen-brain-style')) return;
    const s = document.createElement('style');
    s.id = 'aisen-brain-style';
    s.textContent = [
      '.brain-overlay{position:fixed;inset:0;z-index:2000;display:flex;flex-direction:column;',
      '  padding:20px 26px;background:rgba(4,6,13,.93);backdrop-filter:blur(16px)}',
      '.brain-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}',
      '.brain-title{font-size:19px;font-weight:800;color:var(--ink,#eaf2ff);',
      '  letter-spacing:.02em;margin-right:auto}',
      '.brain-sub{font-size:13px;color:var(--muted,#8ea3c4)}',
      '.brain-search{width:210px;max-width:34vw;background:rgba(5,8,16,.8);',
      '  border:1px solid var(--glass-line,rgba(160,220,255,.2));border-radius:10px;',
      '  padding:9px 13px;color:var(--ink,#eaf2ff);font-size:13.5px;',
      '  font-family:inherit;outline:none}',
      '.brain-search:focus{border-color:var(--accent,#5ce1e6)}',
      '.brain-dl{padding:9px 16px;border-radius:10px;border:1px solid rgba(255,212,121,.55);',
      '  background:rgba(255,212,121,.12);color:#ffd479;cursor:pointer;font-size:13.5px;',
      '  font-family:inherit;font-weight:700;transition:.2s}',
      '.brain-dl:hover{background:rgba(255,212,121,.26)}',
      '.brain-close{padding:9px 14px;border-radius:10px;border:1px solid rgba(255,77,141,.45);',
      '  background:rgba(255,77,141,.1);color:#ff4d8d;cursor:pointer;font-size:14px;',
      '  font-family:inherit;font-weight:700;transition:.2s}',
      '.brain-close:hover{background:rgba(255,77,141,.24)}',
      '.brain-layout{display:flex;gap:16px;flex:1;min-height:0}',
      '.brain-left{flex:1;min-width:0;position:relative}',
      '.brain-canvas{width:100%;height:100%;border-radius:16px;',
      '  border:1px solid var(--glass-line,rgba(160,220,255,.2));',
      '  background:rgba(5,8,16,.6);cursor:grab;display:block}',
      '.brain-canvas:active{cursor:grabbing}',
      '.brain-tip{position:absolute;z-index:10;background:rgba(14,22,40,.97);',
      '  border:1px solid rgba(92,225,230,.5);border-radius:10px;padding:9px 13px;',
      '  font-size:13px;color:var(--ink,#eaf2ff);pointer-events:none;max-width:280px;',
      '  box-shadow:0 8px 26px rgba(0,0,0,.55)}',
      '.brain-tip b{color:var(--accent,#5ce1e6)}',
      '.brain-panel{width:320px;flex:none;border:1px solid var(--glass-line,rgba(160,220,255,.2));',
      '  border-radius:16px;background:rgba(10,16,30,.7);padding:18px;overflow-y:auto}',
      '.brain-panel .bp-empty{color:var(--muted,#8ea3c4);font-size:13.5px;line-height:1.65}',
      '.brain-panel .bp-title{font-size:19px;font-weight:800;color:var(--ink,#eaf2ff);',
      '  margin-bottom:5px;line-height:1.3}',
      '.brain-panel .bp-meta{font-size:12px;color:var(--muted,#8ea3c4);margin-bottom:12px}',
      '.brain-panel .bp-chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}',
      '.brain-panel .bp-chip{padding:6px 12px;border-radius:999px;',
      '  border:1px solid rgba(92,225,230,.45);background:rgba(92,225,230,.1);',
      '  color:var(--accent,#5ce1e6);font-size:12.5px;cursor:pointer;',
      '  font-family:inherit;transition:.15s}',
      '.brain-panel .bp-chip:hover{background:rgba(92,225,230,.3)}',
      '.brain-panel .bp-mention{border-left:2px solid rgba(255,77,141,.45);',
      '  padding:5px 0 5px 12px;margin-bottom:10px;font-size:13px;',
      '  color:var(--muted,#8ea3c4);line-height:1.55}',
      '.brain-panel .bp-mention b{color:var(--ink,#eaf2ff);font-weight:700}',
      '.brain-hint{font-size:12.5px;color:var(--muted,#8ea3c4);opacity:.8;margin-top:10px}',
      '@media(max-width:720px){.brain-overlay{padding:12px}.brain-layout{flex-direction:column}',
      '  .brain-panel{width:100%;max-height:34vh}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render3D() {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'brain-overlay';

    const top = document.createElement('div');
    top.className = 'brain-top';
    top.innerHTML =
      '<span class="brain-title">🧠 Segundo cerebro</span>' +
      '<span class="brain-sub" id="brainStats"></span>' +
      '<input class="brain-search" id="brainSearch" placeholder="Buscar concepto…">' +
      '<button class="brain-dl" id="brainDl">⬇ Wiki .md (Obsidian)</button>' +
      '<button class="brain-close" id="brainClose" title="Cerrar (ESC)">✕ Cerrar</button>';
    ov.appendChild(top);

    const layout = document.createElement('div');
    layout.className = 'brain-layout';

    const left = document.createElement('div');
    left.className = 'brain-left';
    const canvas = document.createElement('canvas');
    canvas.className = 'brain-canvas';
    left.appendChild(canvas);
    const tip = document.createElement('div');
    tip.className = 'brain-tip';
    tip.style.display = 'none';
    left.appendChild(tip);
    layout.appendChild(left);

    const panel = document.createElement('div');
    panel.className = 'brain-panel';
    panel.innerHTML = '<div class="bp-empty">Haz clic en un nodo para ver su ' +
      'conocimiento: menciones con fecha y conceptos conectados. Los chips te ' +
      'llevan de concepto en concepto. ⬇ descarga la wiki completa para Obsidian.</div>';
    layout.appendChild(panel);

    const hint = document.createElement('div');
    hint.className = 'brain-hint';
    hint.textContent = 'click = ficha del concepto · scroll = zoom · arrastrar = girar · ✕ o ESC = cerrar';
    ov.appendChild(layout);
    ov.appendChild(hint);

    document.body.appendChild(ov);
    overlay = ov;

    const ctx = canvas.getContext('2d');
    const keys = Object.keys(graph.nodes);
    const nodes = keys.map(function (k) { return graph.nodes[k]; });

    let rotY = 0, rotX = -0.25, dist = 4.6;
    let drag = false, moved = 0, lastX = 0, lastY = 0;
    let hoverIdx = -1;
    let selectedKey = null;
    let filter = '';
    let alive = true;
    let resizeHandler = null, escHandler = null;

    function size() {
      const w = left.clientWidth || 800;
      const h = left.clientHeight || 500;
      canvas.width = Math.round(w * (window.devicePixelRatio || 1));
      canvas.height = Math.round(h * (window.devicePixelRatio || 1));
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    size();
    requestAnimationFrame(size); // segunda pasada con el layout ya resuelto
    resizeHandler = function () { size(); };
    window.addEventListener('resize', resizeHandler);

    if (nodes.length && graph.nodes[keys[0]]._placed === undefined) {
      const golden = Math.PI * (3 - Math.sqrt(5));
      nodes.forEach(function (n, i) {
        const t = i / Math.max(1, nodes.length - 1);
        const phi = Math.acos(1 - 2 * t);
        const theta = golden * i;
        n.x = 1.5 * Math.sin(phi) * Math.cos(theta);
        n.y = 1.5 * Math.sin(phi) * Math.sin(theta);
        n.z = 1.5 * Math.cos(phi);
        n._placed = true;
      });
      save(GRAPH_KEY, graph);
    }

    function project(n) {
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      let x = n.x * cosY - n.z * sinY;
      let z = n.x * sinY + n.z * cosY;
      let y = n.y * cosX - z * sinX;
      z = n.y * sinX + z * cosX;
      const s = dist / (dist + z);
      const cw = canvas.width / (window.devicePixelRatio || 1);
      const ch = canvas.height / (window.devicePixelRatio || 1);
      return { x: cw / 2 + x * s * cw * 0.34, y: ch / 2 + y * s * ch * 0.34, s: s };
    }

    function matched(key) {
      if (!filter) return true;
      return graph.nodes[key].label.toLowerCase().indexOf(filter) >= 0;
    }

    function isNeighbor(key) {
      if (!selectedKey) return true;
      if (key === selectedKey) return true;
      const set = new Set(neighborsOf(selectedKey));
      return set.has(key);
    }

    function nodeAlpha(key) {
      if (!matched(key)) return 0.06;
      if (selectedKey && !isNeighbor(key)) return 0.12;
      return 1;
    }

    // Píldora redondeada detrás de cada etiqueta: letras claras sobre el fondo.
    function pill(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function draw() {
      if (!alive) return;
      const cw = canvas.width / (window.devicePixelRatio || 1);
      const ch = canvas.height / (window.devicePixelRatio || 1);
      ctx.clearRect(0, 0, cw, ch);
      const bg = ctx.createRadialGradient(cw / 2, ch / 2, 40, cw / 2, ch / 2, cw * 0.62);
      bg.addColorStop(0, 'rgba(92,225,230,.06)');
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cw, ch);

      if (!keys.length) {
        ctx.fillStyle = '#8ea3c4';
        ctx.font = '600 15px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Todavía no hay conceptos.', cw / 2, ch / 2 - 8);
        ctx.fillText('Conversa con el chatbot y vuelve a abrir el cerebro.', cw / 2, ch / 2 + 16);
        return;
      }

      const proj = nodes.map(project);
      const selNeighbors = selectedKey ? new Set(neighborsOf(selectedKey)) : null;
      const showAllLabels = keys.length <= 50;

      Object.keys(graph.edges).forEach(function (ek) {
        const parts = ek.split('||');
        const ia = keys.indexOf(parts[0]);
        const ib = keys.indexOf(parts[1]);
        if (ia < 0 || ib < 0) return;
        const e = graph.edges[ek];
        let alpha = Math.min(0.9, 0.25 + e.weight * 0.1);
        let width = Math.min(4.5, 1 + e.weight * 0.6);
        let color = '150,235,255';
        if (selectedKey) {
          const touches = parts[0] === selectedKey || parts[1] === selectedKey;
          if (touches) { alpha = 0.95; width = Math.min(5, width + 1.4); color = '255,77,141'; }
          else if (!(selNeighbors.has(parts[0]) || selNeighbors.has(parts[1]))) {
            alpha = 0.05;
          }
        }
        if (!matched(parts[0]) && !matched(parts[1])) alpha = 0.03;
        ctx.strokeStyle = 'rgba(' + color + ',' + alpha.toFixed(2) + ')';
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(proj[ia].x, proj[ia].y);
        ctx.lineTo(proj[ib].x, proj[ib].y);
        ctx.stroke();
      });

      proj.forEach(function (p, i) {
        const n = nodes[i];
        const key = keys[i];
        const alpha = nodeAlpha(key);
        if (alpha < 0.1) return;
        const radius = (4 + Math.min(10, n.count * 1.6)) * p.s;
        const selected = key === selectedKey;
        const hovered = i === hoverIdx && !selectedKey;
        const glowColor = selected ? '255,77,141' : (hovered ? '255,212,121' : '92,225,230');
        ctx.globalAlpha = alpha;
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 3);
        glow.addColorStop(0, 'rgba(' + glowColor + ',.85)');
        glow.addColorStop(1, 'rgba(92,225,230,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = selected ? '#ff4d8d' : '#5ce1e6';
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
        if (selected) {
          ctx.strokeStyle = 'rgba(255,77,141,.9)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, radius + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Etiqueta clara: píldora oscura + texto brillante.
        const showLabel = selected || hovered || n.count >= 2 || showAllLabels;
        if (showLabel) {
          const label = n.label.slice(0, 26);
          const fs = selected ? 15 : (hovered ? 14 : 12.5);
          ctx.font = '700 ' + fs + 'px Inter, system-ui, sans-serif';
          const tw = ctx.measureText(label).width;
          const cx = p.x;
          const cy = p.y - radius - 12;
          pill(cx - tw / 2 - 8, cy - fs - 2, tw + 16, fs + 6, 8);
          ctx.fillStyle = 'rgba(5,8,16,.88)';
          ctx.fill();
          ctx.strokeStyle = selected ? 'rgba(255,77,141,.6)' : 'rgba(92,225,230,.3)';
          ctx.lineWidth = 1;
          pill(cx - tw / 2 - 8, cy - fs - 2, tw + 16, fs + 6, 8);
          ctx.stroke();
          ctx.fillStyle = '#eaf2ff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, cx, cy + 1);
        }
        ctx.globalAlpha = 1;
      });

      if (!drag) rotY += 0.0012;
      if (alive) requestAnimationFrame(draw);
    }
    draw();

    function pick(e) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const proj = nodes.map(project);
      let best = -1, bestDist = 1e9;
      proj.forEach(function (p, i) {
        const d = Math.hypot(p.x - mx, p.y - my);
        const radius = (4 + Math.min(10, nodes[i].count * 1.6)) * p.s;
        if (d < Math.max(radius * 3, 16) && d < bestDist) { bestDist = d; best = i; }
      });
      return best;
    }

    function updatePanel() {
      if (!selectedKey) {
        panel.innerHTML = '<div class="bp-empty">Haz clic en un nodo para ver su ' +
          'conocimiento: menciones con fecha y conceptos conectados. Los chips te ' +
          'llevan de concepto en concepto. ⬇ descarga la wiki completa para Obsidian.</div>';
        return;
      }
      const n = graph.nodes[selectedKey];
      const neigh = neighborsOf(selectedKey).filter(function (k) { return graph.nodes[k]; });
      const html = ['<div class="bp-title">' + esc(n.label) + '</div>',
        '<div class="bp-meta">' + n.count + ' menciones · desde ' +
        (n.firstSeen || '').slice(0, 10) + ' · última ' + (n.lastSeen || '').slice(0, 10) + '</div>'];
      if (neigh.length) {
        html.push('<div class="bp-chips">');
        neigh.forEach(function (nk) {
          html.push('<button class="bp-chip" data-key="' + esc(nk) + '">' +
            esc(graph.nodes[nk].label) + '</button>');
        });
        html.push('</div>');
      }
      (n.mentions || []).slice(-4).reverse().forEach(function (m) {
        html.push('<div class="bp-mention"><b>' + (m.ts || '').slice(0, 10) + '</b><br>' +
          esc(m.user.slice(0, 140)) + '</div>');
      });
      panel.innerHTML = html.join('');
      panel.querySelectorAll('.bp-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          selectNode(chip.getAttribute('data-key'));
        });
      });
    }

    function selectNode(key) {
      selectedKey = (selectedKey === key) ? null : key;
      updatePanel();
    }

    function updateStats() {
      const el = document.getElementById('brainStats');
      if (el) {
        el.textContent = keys.length + ' conceptos · ' +
          Object.keys(graph.edges).length + ' conexiones · ' + log.length + ' conversaciones';
      }
    }
    updateStats();

    canvas.addEventListener('mousemove', function (e) {
      if (drag) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        rotY += dx * 0.006;
        rotX += dy * 0.006;
        rotX = Math.max(-1.2, Math.min(1.2, rotX));
        lastX = e.clientX; lastY = e.clientY;
        return;
      }
      const idx = pick(e);
      hoverIdx = idx;
      if (idx >= 0 && !selectedKey) {
        const n = nodes[idx];
        tip.innerHTML = '<b>' + esc(n.label) + '</b> · ' + n.count + ' menciones';
        tip.style.display = 'block';
        tip.style.left = (e.clientX - canvas.getBoundingClientRect().left + 16) + 'px';
        tip.style.top = (e.clientY - canvas.getBoundingClientRect().top - 10) + 'px';
      } else {
        tip.style.display = 'none';
      }
    });

    canvas.addEventListener('mousedown', function (e) {
      drag = true; moved = 0;
      lastX = e.clientX; lastY = e.clientY;
    });

    window.addEventListener('mouseup', function (e) {
      if (drag && moved < 6) {
        const idx = pick(e);
        if (idx >= 0) selectNode(keys[idx]);
        else if (e.target === canvas) selectNode(null);
      }
      drag = false;
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      dist = Math.max(2.4, Math.min(8, dist + e.deltaY * 0.004));
    }, { passive: false });

    canvas.addEventListener('mouseleave', function () {
      tip.style.display = 'none'; hoverIdx = -1;
    });

    canvas.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        drag = true; moved = 0;
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (e.touches.length === 1) {
        const dx = e.touches[0].clientX - lastX;
        const dy = e.touches[0].clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        rotY += dx * 0.006;
        rotX += dy * 0.006;
        rotX = Math.max(-1.2, Math.min(1.2, rotX));
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
        e.preventDefault();
      }
    }, { passive: false });
    canvas.addEventListener('touchend', function (e) {
      if (drag && moved < 6 && e.changedTouches.length) {
        const idx = pick(e.changedTouches[0]);
        if (idx >= 0) selectNode(keys[idx]);
      }
      drag = false;
    });

    const search = document.getElementById('brainSearch');
    if (search) {
      search.addEventListener('input', function () {
        filter = search.value.trim().toLowerCase();
      });
    }
    const dl = document.getElementById('brainDl');
    if (dl) dl.addEventListener('click', downloadWiki);

    function close() {
      alive = false;
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      if (escHandler) document.removeEventListener('keydown', escHandler);
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null; view = null;
    }
    escHandler = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
    const closeBtn = document.getElementById('brainClose');
    if (closeBtn) closeBtn.addEventListener('click', close);

    view = { close: close };
  }

  function showBrain() {
    if (overlay) return; // ya está abierta
    render3D();
  }

  function closeBrain() {
    if (view && view.close) view.close();
  }

  /* ----------------------------- API PÚBLICA ---------------------------- */
  window.AisenBrain = {
    logTurn: logTurn,
    extractConcepts: extractConcepts,
    show: showBrain,
    close: closeBrain,
    destroy: closeBrain, // alias: compatibilidad con llamadas anteriores
    exportMarkdown: downloadWiki,
    buildMarkdown: buildWikiMarkdown,
    graphStats: function () {
      return {
        concepts: Object.keys(graph.nodes).length,
        connections: Object.keys(graph.edges).length,
        chats: log.length
      };
    }
  };
})();
