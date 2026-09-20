/* ============================================================================
 * AI SEN — Segundo cerebro (wiki enciclopédica, patrón LLM Wiki de Karpathy)
 * ----------------------------------------------------------------------------
 * "Deja de recuperar. Empieza a compilar." — Karpathy
 *
 * ESTO ES UNA WIKI, NO UN CONTADOR. Cada concepto no es "N menciones": es una
 * ENTRADA ENCICLOPÉDICA que el motor escribe con sustancia, como Wikipedia:
 *
 *   Terzaghi → "Karl von Terzaghi, geotécnico austríaco, formuló la teoría
 *   de capacidad de carga de fundaciones. Su ecuación q_ult = c·Nc + … sigue
 *   siendo la base del diseño de cimentaciones."
 *
 * Capas (patrón de Karpathy):
 *   1. RAW    — log inmutable de conversaciones {ts, user, bot}.
 *   2. WIKI   — páginas con TEXTO desarrollado (fragmentos compilados) +
 *               wikilinks + backlinks. El contenido se densifica con cada
 *               mención (compound): reaparecer = ampliar, nunca duplicar.
 *   3. VISTA  — navegador de wiki: índice lateral + página con el contenido,
 *               sin contadores de menciones (eso no aporta nada).
 * ========================================================================== */
(function () {
  'use strict';

  const LOG_KEY = 'aisen.brain.log';
  const GRAPH_KEY = 'aisen.brain.graph';

  /* ----------------------------- ESTADO --------------------------------- */
  let log = load(LOG_KEY, []);            // {ts, user, bot}[]
  let graph = load(GRAPH_KEY, { nodes: {}, edges: {} });
  // nodes: { key: { label, count, firstSeen, lastSeen,
  //                 fragments: [párrafo, ...], mentions: [{ts, user, bot}] } }
  // edges: { "a||b": { weight } }   (co-ocurrencia → wikilinks)

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* lleno */ }
  }

  // Migración: si un nodo viene de la versión anterior (con `summary` de una
  // frase), lo convertimos a `fragments` para no perder lo ya compilado.
  function normalizeNode(n) {
    if (!n.fragments) {
      n.fragments = [];
      if (n.summary) { n.fragments.push(String(n.summary).replace(/\s+/g, ' ').trim()); delete n.summary; }
    }
    return n;
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

  /* ------------------- COMPILACIÓN ENCICLOPÉDICA ------------------------ */
  // El motor escribe una entrada de Wikipedia para cada concepto clave.
  // Formato pedido (markdown, fácil de parsear):
  //   ## Concepto
  //   párrafo desarrollado (2-4 frases, con sustancia)
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
            content:
              'Eres el editor de una wiki personal (como Wikipedia). A partir ' +
              'de esta conversación, escribe una entrada enciclopédica para ' +
              'cada concepto clave (máximo 3). No hagas listas ni cuentes ' +
              'menciones: escribe TEXTO con sustancia, como lo haría Wikipedia.\n\n' +
              'Formato exacto, un bloque por concepto:\n' +
              '## Nombre del concepto\n' +
              '2 a 4 frases explicando qué es, para qué sirve y por qué ' +
              'importa, en español.\n\n' +
              'Conversación:\nUsuario: ' + userText + '\nAI: ' + botText
          }]
        })
      });
      const data = await resp.json();
      const content = data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string' || !content) return;
      parseAndCompile(content, userText, botText);
    } catch (_) { /* motor apagado: el log queda igual */ }
  }

  // Parsea el markdown "## concepto\ncontenido" y compila cada entrada.
  function parseAndCompile(content, userText, botText) {
    const ts = new Date().toISOString();
    const seen = new Set();

    const sections = [];
    const lines = content.split(/\n/);
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h = line.match(/^#{2,3}\s+(.+)$/);
      if (h) {
        if (cur) sections.push(cur);
        cur = { title: h[1].trim(), body: [] };
      } else if (cur) {
        cur.body.push(line);
      }
    }
    if (cur) sections.push(cur);

    // Fallback: formato viejo "concepto | definición".
    if (!sections.length) {
      lines.forEach(function (line) {
        const sep = line.indexOf('|');
        if (sep >= 0) {
          sections.push({ title: line.slice(0, sep).trim(), body: [line.slice(sep + 1).trim()] });
        }
      });
    }

    sections.forEach(function (sec) {
      const label = sec.title.replace(/^[\s\d.\-–>*]+/, '').trim();
      if (label.length < 2 || label.length > 60) return;
      const key = label.toLowerCase();
      const texto = sec.body.join(' ').replace(/\s+/g, ' ').trim();
      if (!texto) return;
      seen.add(key);
      compilePage(key, label, texto, ts, userText, botText);
    });

    // co-ocurrencia → wikilinks entre conceptos que aparecen juntos.
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

  // Compound enciclopédico: si la página existe, se AMPLÍA con el texto
  // nuevo (sin repetir); si es nueva, nace con su primer fragmento.
  function compilePage(key, label, texto, ts, userText, botText) {
    let n = graph.nodes[key];
    if (!n) {
      n = graph.nodes[key] = {
        label: label,
        count: 0,
        firstSeen: ts,
        lastSeen: ts,
        fragments: [],
        mentions: []
      };
    } else {
      normalizeNode(n);
    }
    n.count++;
    n.lastSeen = ts;
    n.mentions.push({
      ts: ts,
      user: String(userText || '').slice(0, 300),
      bot: String(botText || '').slice(0, 300)
    });
    if (n.mentions.length > 20) n.mentions = n.mentions.slice(-20);

    addFragment(n, texto);
  }

  // Añade un fragmento de contenido sin duplicar (por igualdad o subcadena).
  function addFragment(n, texto) {
    const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
    if (limpio.length < 20) return;
    const ya = n.fragments.some(function (f) {
      return f === limpio || limpio.indexOf(f) >= 0 || f.indexOf(limpio) >= 0;
    });
    if (ya) return;
    n.fragments.push(limpio);
    if (n.fragments.length > 12) n.fragments = n.fragments.slice(-12);
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
    lines.push('> Wiki compilada automáticamente (patrón LLM Wiki de Karpathy).');
    lines.push('');
    lines.push('## Índice');
    lines.push('');
    keys.forEach(function (k) {
      lines.push('- [[' + graph.nodes[k].label + ']]');
    });
    lines.push('');
    keys.forEach(function (k) {
      const n = normalizeNode(graph.nodes[k]);
      const neigh = neighborsOf(k)
        .filter(function (nk) { return graph.nodes[nk]; })
        .map(function (nk) { return '[[' + graph.nodes[nk].label + ']]'; });
      lines.push('---');
      lines.push('');
      lines.push('## ' + n.label);
      lines.push('');
      n.fragments.forEach(function (f) {
        lines.push(f);
        lines.push('');
      });
      if (neigh.length) {
        lines.push('Relacionado con: ' + neigh.join(', '));
        lines.push('');
      }
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

  /* ---------------------- VISTA WIKI (no grafo) ------------------------- */
  let overlay = null;
  let view = null;

  function injectStyles() {
    if (document.getElementById('aisen-brain-style')) return;
    const s = document.createElement('style');
    s.id = 'aisen-brain-style';
    s.textContent = [
      '.brain-overlay{position:fixed;inset:0;z-index:2000;display:flex;flex-direction:column;',
      '  padding:20px 26px;background:rgba(4,6,13,.95);backdrop-filter:blur(16px)}',
      '.brain-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}',
      '.brain-title{font-size:19px;font-weight:800;color:var(--ink,#eaf2ff);',
      '  letter-spacing:.02em;margin-right:auto}',
      '.brain-sub{font-size:12.5px;color:var(--muted,#8ea3c4)}',
      '.brain-search{width:220px;max-width:30vw;background:rgba(5,8,16,.8);',
      '  border:1px solid var(--glass-line,rgba(160,220,255,.2));border-radius:10px;',
      '  padding:9px 13px;color:var(--ink,#eaf2ff);font-size:13.5px;',
      '  font-family:inherit;outline:none}',
      '.brain-search:focus{border-color:var(--accent,#5ce1e6)}',
      '.brain-dl{padding:9px 16px;border-radius:10px;border:1px solid rgba(255,212,121,.55);',
      '  background:rgba(255,212,121,.12);color:#ffd479;cursor:pointer;font-size:13px;',
      '  font-family:inherit;font-weight:700;transition:.2s}',
      '.brain-dl:hover{background:rgba(255,212,121,.26)}',
      '.brain-close{padding:9px 14px;border-radius:10px;border:1px solid rgba(255,77,141,.45);',
      '  background:rgba(255,77,141,.1);color:#ff4d8d;cursor:pointer;font-size:14px;',
      '  font-family:inherit;font-weight:700;transition:.2s}',
      '.brain-close:hover{background:rgba(255,77,141,.24)}',

      // Layout wiki: índice lateral + página
      '.brain-layout{display:flex;gap:16px;flex:1;min-height:0}',
      '.brain-index{width:250px;flex:none;border:1px solid var(--glass-line,rgba(160,220,255,.2));',
      '  border-radius:14px;background:rgba(10,16,30,.6);padding:12px;overflow-y:auto}',
      '.brain-index h4{font-size:11px;letter-spacing:.12em;text-transform:uppercase;',
      '  color:var(--muted,#8ea3c4);margin:2px 4px 10px;font-weight:700}',
      '.brain-idx-item{padding:8px 11px;border-radius:9px;cursor:pointer;font-size:13.5px;',
      '  color:var(--ink-body,#d4e0f2);transition:.15s}',
      '.brain-idx-item:hover{background:rgba(92,225,230,.1)}',
      '.brain-idx-item.on{background:rgba(92,225,230,.18);color:var(--ink,#eaf2ff);font-weight:650}',
      '.brain-empty{color:var(--muted,#8ea3c4);font-size:13px;line-height:1.6;padding:4px}',

      // Página del concepto (como entrada de Wikipedia)
      '.brain-page{flex:1;min-width:0;border:1px solid var(--glass-line,rgba(160,220,255,.2));',
      '  border-radius:14px;background:rgba(10,16,30,.55);padding:26px 30px;overflow-y:auto}',
      '.bp-breadcrumb{font-size:12px;color:var(--muted,#8ea3c4);margin-bottom:6px}',
      '.bp-breadcrumb button{background:none;border:none;color:var(--accent,#5ce1e6);',
      '  cursor:pointer;font-family:inherit;font-size:12px;padding:0}',
      '.bp-title{font-size:27px;font-weight:800;color:var(--ink,#eaf2ff);',
      '  line-height:1.2;margin-bottom:14px;border-bottom:1px solid var(--glass-line,rgba(160,220,255,.18));',
      '  padding-bottom:12px}',
      '.bp-para{font-size:15.5px;line-height:1.75;color:var(--ink-body,#d4e0f2);',
      '  margin-bottom:14px}',
      '.bp-section{margin-top:22px}',
      '.bp-section .lbl{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;',
      '  color:var(--muted,#8ea3c4);margin-bottom:9px;font-weight:700}',
      '.bp-chips{display:flex;flex-wrap:wrap;gap:7px}',
      '.bp-chip{padding:6px 13px;border-radius:999px;border:1px solid rgba(92,225,230,.45);',
      '  background:rgba(92,225,230,.1);color:var(--accent,#5ce1e6);font-size:13px;',
      '  cursor:pointer;font-family:inherit;transition:.15s}',
      '.bp-chip:hover{background:rgba(92,225,230,.3)}',
      '.bp-chip.bl{background:rgba(255,212,121,.08);border-color:rgba(255,212,121,.4);color:#ffd479}',
      '@media(max-width:720px){.brain-overlay{padding:12px}.brain-layout{flex-direction:column}',
      '  .brain-index{width:100%;max-height:32vh}.brain-page{flex:1}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderWiki() {
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'brain-overlay';

    const top = document.createElement('div');
    top.className = 'brain-top';
    top.innerHTML =
      '<span class="brain-title">🧠 Segundo cerebro</span>' +
      '<span class="brain-sub" id="brainStats"></span>' +
      '<input class="brain-search" id="brainSearch" placeholder="Buscar…">' +
      '<button class="brain-dl" id="brainDl">⬇ Wiki .md</button>' +
      '<button class="brain-close" id="brainClose" title="Cerrar (ESC)">✕</button>';
    ov.appendChild(top);

    const layout = document.createElement('div');
    layout.className = 'brain-layout';

    const index = document.createElement('div');
    index.className = 'brain-index';
    layout.appendChild(index);

    const page = document.createElement('div');
    page.className = 'brain-page';
    layout.appendChild(page);

    ov.appendChild(layout);
    document.body.appendChild(ov);
    overlay = ov;

    let currentKey = null;
    let history = [];
    let filter = '';

    function sortedKeys() {
      return Object.keys(graph.nodes).sort(function (a, b) {
        return graph.nodes[b].count - graph.nodes[a].count;
      });
    }

    function renderIndex() {
      const keys = sortedKeys().filter(function (k) {
        return !filter || graph.nodes[k].label.toLowerCase().indexOf(filter) >= 0;
      });
      if (!keys.length) {
        index.innerHTML =
          '<h4>Índice</h4><div class="brain-empty">' +
          (Object.keys(graph.nodes).length
            ? 'Sin coincidencias.'
            : 'Todavía no hay conceptos. Conversa con el chatbot: cada tema ' +
              'se vuelve una entrada de tu wiki.') + '</div>';
        return;
      }
      const items = keys.map(function (k) {
        return '<div class="brain-idx-item' + (k === currentKey ? ' on' : '') +
          '" data-key="' + esc(k) + '">' + esc(graph.nodes[k].label) + '</div>';
      }).join('');
      index.innerHTML = '<h4>Índice</h4>' + items;
      index.querySelectorAll('.brain-idx-item').forEach(function (el) {
        el.addEventListener('click', function () {
          openPage(el.getAttribute('data-key'));
        });
      });
    }

    function openPage(key, push) {
      if (!graph.nodes[key]) return;
      // Sin repetidos seguidos: si no, "atras" no lleva a ninguna parte.
      if (push !== false && history[history.length - 1] !== key) history.push(key);
      currentKey = key;
      renderIndex();
      renderPage(key);
    }

    function renderPage(key) {
      const n = normalizeNode(graph.nodes[key]);
      const neigh = neighborsOf(key).filter(function (k) { return graph.nodes[k]; });
      const html = [];

      if (history.length > 1) {
        html.push('<div class="bp-breadcrumb"><button id="bpBack">← atrás</button></div>');
      }
      html.push('<div class="bp-title">' + esc(n.label) + '</div>');

      // El contenido: los fragmentos enciclopédicos compilados.
      (n.fragments || []).forEach(function (f) {
        html.push('<p class="bp-para">' + esc(f) + '</p>');
      });
      if (!n.fragments.length) {
        html.push('<p class="bp-para" style="opacity:.6">Este concepto se ' +
          'mencionó pero aún no tiene contenido compilado. Volverá a crecer ' +
          'la próxima vez que hables de él.</p>');
      }

      if (neigh.length) {
        html.push('<div class="bp-section"><span class="lbl">Relacionado</span>' +
          '<div class="bp-chips">' +
          neigh.map(function (nk) {
            return '<button class="bp-chip" data-key="' + esc(nk) + '">' +
              esc(graph.nodes[nk].label) + '</button>';
          }).join('') + '</div></div>');
      }

      page.innerHTML = html.join('');
      page.scrollTop = 0;

      const backBtn = page.querySelector('#bpBack');
      if (backBtn) {
        backBtn.addEventListener('click', function () {
          history.pop();
          const prev = history.length ? history[history.length - 1] : null;
          if (prev) openPage(prev, false);
          else { currentKey = null; renderIndex(); renderEmptyPage(); }
        });
      }
      page.querySelectorAll('.bp-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          openPage(chip.getAttribute('data-key'));
        });
      });
    }

    function renderEmptyPage() {
      page.innerHTML =
        '<div class="bp-title" style="font-size:21px">Tu enciclopedia</div>' +
        '<p class="bp-para">Esto es una wiki viva, como una Wikipedia personal. ' +
        'Cada tema del que hablas se vuelve una entrada con su explicación, ' +
        'y cada entrada enlaza a las relacionadas. Pulsa cualquier concepto ' +
        'del índice para leerlo.</p>';
    }

    function updateStats() {
      const el = document.getElementById('brainStats');
      if (el) {
        el.textContent = Object.keys(graph.nodes).length + ' entradas · ' +
          log.length + ' conversaciones';
      }
    }

    updateStats();
    renderIndex();
    renderEmptyPage();

    const search = document.getElementById('brainSearch');
    if (search) {
      search.addEventListener('input', function () {
        filter = search.value.trim().toLowerCase();
        renderIndex();
      });
    }
    const dl = document.getElementById('brainDl');
    if (dl) dl.addEventListener('click', downloadWiki);

    function close() {
      if (escHandler) document.removeEventListener('keydown', escHandler);
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null; view = null;
    }
    const escHandler = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
    const closeBtn = document.getElementById('brainClose');
    if (closeBtn) closeBtn.addEventListener('click', close);

    view = { close: close };
  }

  function showBrain() {
    if (overlay) return;
    renderWiki();
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
    destroy: closeBrain,
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
