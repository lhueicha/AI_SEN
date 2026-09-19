/* ============================================================================
 * AI SEN — render.js
 * Renderizado ligero de la salida del chatbot: markdown mínimo + LaTeX (KaTeX).
 * ----------------------------------------------------------------------------
 * - Sin dependencias externas: KaTeX se sirve local desde /assets/katex/.
 * - Markdown soportado: **negrita**, *cursiva*, `codigo`, ```bloques```,
 *   listas con -, encabezados # ## ###, TABLAS |...|, saltos de línea.
 * - Matemáticas: $...$ (inline) y $$...$$ (bloque) se renderizan con KaTeX.
 * - Todo el HTML se escapa primero: seguro contra inyección.
 * ========================================================================== */

/* ---------- Mini renderizador markdown (escape-then-format) ---------- */
function mdEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdInline(s) {
  // orden: codigo, negrita, cursiva
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// Construye una tabla HTML a partir de lineas markdown ya escapadas.
// lines: ['| A | B |', '|---|---|', '| 1 | 2 |', ...]
function tableToHtml(tableLines) {
  const parseRow = (raw) =>
    raw.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
      .map(function (c) { return mdInline(c.trim()); });
  const isSep = (raw) => /^\s*\|[\s:\-|]+\|\s*$/.test(raw) && /-/.test(raw);

  const headerRaw = tableLines[0];
  const headers = parseRow(headerRaw);
  const rows = [];
  for (let i = 1; i < tableLines.length; i++) {
    if (isSep(tableLines[i])) continue;
    rows.push(parseRow(tableLines[i]));
  }
  const maxCols = Math.max(headers.length, ...rows.map(function (r) { return r.length; }));
  const html = ['<div class="md-table"><table>'];
  if (headers.length) {
    html.push('<thead><tr>');
    for (let c = 0; c < maxCols; c++) {
      html.push('<th>' + (headers[c] || '') + '</th>');
    }
    html.push('</tr></thead>');
  }
  html.push('<tbody>');
  rows.forEach(function (r) {
    html.push('<tr>');
    for (let c = 0; c < maxCols; c++) {
      html.push('<td>' + (r[c] || '') + '</td>');
    }
    html.push('</tr>');
  });
  html.push('</tbody></table></div>');
  return html.join('');
}

function renderMarkdown(src) {
  // 1. Extraer bloques de codigo, matematicas y TABLAS para que no los toque
  //    el parser línea a línea.
  const vault = [];
  const stash = (html) => { vault.push(html); return '\u0000' + (vault.length - 1) + '\u0000'; };

  let text = src;
  // bloques de codigo ```...```
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) =>
    stash('<pre class="md-code"><code>' + mdEscape(code) + '</code></pre>'));
  // matematicas en bloque $$...$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => stash(texToHtml(tex, true)));
  // matematicas inline $...$ (no codicioso, evita $$ ya consumidos)
  text = text.replace(/\$([^\n$]+?)\$/g, (m, tex) => stash(texToHtml(tex, false)));

  // Tablas: bloques de líneas | ... | que incluyan un separador ---
  const rawLines = text.split('\n');
  const merged = [];
  let i = 0;
  while (i < rawLines.length) {
    const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    if (isTableRow(rawLines[i])) {
      // junta líneas de tabla contiguas
      const block = [];
      while (i < rawLines.length && isTableRow(rawLines[i])) {
        block.push(rawLines[i]);
        i++;
      }
      const hasSep = block.some(function (l) { return /^\s*\|[\s:\-|]+\|\s*$/.test(l) && /-/.test(l); });
      if (hasSep && block.length >= 2) {
        merged.push(stash(tableToHtml(block.map(mdEscape))));
        continue;
      }
      // no era tabla real: devolver las líneas como texto
      block.forEach(function (l) { merged.push(l); });
      continue;
    }
    merged.push(rawLines[i]);
    i++;
  }
  text = merged.join('\n');

  // 2. Procesar lineas: encabezados, listas, parrafos
  const lines = text.split('\n');
  const out = [];
  let inList = false;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + mdInline(para.join('<br>')) + '</p>');
      para = [];
    }
  };
  const flushList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    // Bloque guardado (tabla, código, matemática): va suelto, nunca dentro de <p>.
    if (/^\u0000\d+\u0000$/.test(line)) { flushPara(); flushList(); out.push(line); continue; }
    if (/^###\s/.test(line)) { flushPara(); flushList(); out.push('<h4>' + mdInline(line.slice(4)) + '</h4>'); continue; }
    if (/^##\s/.test(line))  { flushPara(); flushList(); out.push('<h3>' + mdInline(line.slice(3)) + '</h3>'); continue; }
    if (/^#\s/.test(line))   { flushPara(); flushList(); out.push('<h2>' + mdInline(line.slice(2)) + '</h2>'); continue; }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + mdInline(line.replace(/^[-*]\s+/, '')) + '</li>');
      continue;
    }
    if (line === '') { flushPara(); flushList(); continue; }
    para.push(line);
  }
  flushPara(); flushList();

  // 3. Restaurar bloques guardados (codigo, $$, $ y tablas ya renderizados)
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (m, idx) => vault[+idx]);
}

/* ---------- LaTeX via KaTeX (con fallback a texto plano) ---------- */
function texToHtml(tex, displayMode) {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode: displayMode,
      throwOnError: false,
      output: 'html',
      strict: false
    });
  } catch (e) {
    return '<code class="md-tex-raw">' + mdEscape(tex) + '</code>';
  }
}

/* ---------- API publica ---------- */
/* Renderiza markdown+LaTeX dentro de un elemento del chat.
 * Se llama tras insertar cada respuesta del bot. */
function renderAisen(el) {
  if (!el) return;
  const raw = el.getAttribute('data-raw');
  if (raw == null) return;
  el.innerHTML = renderMarkdown(raw);
}

/* Expone para app.js */
window.AisenRender = { renderMarkdown, renderAisen };
