/* ============================================================================
 * AI SEN — Documento (paper.js)
 * ----------------------------------------------------------------------------
 * Convierte la respuesta del modelo en un documento académico tipo paper
 * (estilo Elsevier / Imperial College): portada, resumen, secciones
 * numeradas, ecuaciones numeradas, tablas y figuras con rótulo, referencias.
 *
 * ORDEN DE PROCESADO (crítico — el LaTeX se compila ANTES que el markdown):
 *   1. Bloques de código ```...```
 *   2. Ecuaciones en bloque: $$...$$  y  \[...\]   (numeradas)
 *   3. Imágenes → figuras con rótulo
 *   4. LaTeX inline: \(...\)  y  $...$   (compilado, guardado en bodega)
 *   5. Tablas (sus celdas ya llevan el LaTeX como marcadores)
 *   6. Estructura por líneas + marcado inline (negrita, cursiva, enlaces)
 *
 * Al compilar el LaTeX primero, los asteriscos y subrayados que usa el
 * markdown (**, *) jamás tocan el interior de las fórmulas.
 * ========================================================================== */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------------- LaTeX: inline y ecuación ----------------------- */
  function tex(src, display, numero) {
    var html;
    try {
      html = window.katex.renderToString(String(src).trim(), {
        displayMode: !!display, throwOnError: false, strict: false
      });
    } catch (e) {
      html = '<span class="tex-crudo">' + esc(src) + '</span>';
    }
    if (!display) return html;
    // Ecuación numerada: la fórmula centrada, el número pegado al margen.
    return '<div class="ecuacion"><div class="ec-cuerpo">' + html + '</div>' +
           '<div class="ec-num">(' + numero + ')</div></div>';
  }

  /* --------------------------- Marcado en línea -------------------------- */
  // El LaTeX inline ya se compiló y vive como marcador \u0000N\u0000 en el
  // texto que llega aquí. inline() solo hace markdown de texto.
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, function (m, c) { return '<code>' + c + '</code>'; })
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
        '<a href="$2">$1</a><span class="url-impresa"> ($2)</span>');
  }

  /* ------------------------------ Tablas --------------------------------- */
  // Estilo paper: rótulo arriba, solo reglas horizontales.
  function tabla(lineas, n, titulo) {
    var filas = lineas.map(function (l) {
      return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
              .map(function (c) { return c.trim(); });
    });
    var sep = /^[\s:|-]+$/;
    var cab = filas[0];
    var cuerpo = filas.filter(function (f, i) {
      return i > 0 && !sep.test(f.join('|'));
    });
    var h = '<div class="tabla-bloque">' +
      '<div class="rotulo"><b>Tabla ' + n + '</b>' +
      (titulo ? '<br><i>' + inline(esc(titulo)) + '</i>' : '') + '</div>' +
      '<table><thead><tr>' +
      cab.map(function (c) { return '<th>' + inline(esc(c)) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      cuerpo.map(function (f) {
        return '<tr>' + f.map(function (c) {
          return '<td>' + inline(esc(c)) + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      '</tbody></table></div>';
    return h;
  }

  /* --------------------------- Documento completo ------------------------ */
  function toHtml(src) {
    var bodega = [];
    var guardar = function (html) {
      bodega.push(html);
      return '\u0000' + (bodega.length - 1) + '\u0000';
    };

    var nFig = 0, nTab = 0, nEc = 0;
    var t = String(src || '');

    // 1. Bloques de código
    t = t.replace(/```(\w*)\n([\s\S]*?)```/g, function (m, lang, code) {
      return guardar('<pre class="bloque-codigo"><code>' + esc(code) + '</code></pre>');
    });

    // 2. Ecuaciones en bloque: $$...$$  y  \[...\]  (numeradas)
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, function (m, f) {
      nEc++; return guardar(tex(f, true, nEc));
    });
    t = t.replace(/\\\[([\s\S]+?)\\\]/g, function (m, f) {
      nEc++; return guardar(tex(f, true, nEc));
    });

    // 3. Imágenes → figura con rótulo
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, url) {
      nFig++;
      return guardar(
        '<figure class="figura">' +
        '<div class="rotulo"><b>Figura ' + nFig + '</b></div>' +
        '<img src="' + esc(url) + '" alt="' + esc(alt) + '">' +
        (alt ? '<figcaption><i>Nota.</i> ' + inline(esc(alt)) + '</figcaption>' : '') +
        '</figure>');
    });

    // 4. LaTeX inline: \(...\)  y  $...$   — ANTES de las tablas y del
    //    marcado, para que sus * _ ^ nunca se confundan con markdown.
    t = t.replace(/\\\(([\s\S]+?)\\\)/g, function (m, f) { return guardar(tex(f, false)); });
    t = t.replace(/\$([^\n$]+?)\$/g, function (m, f) { return guardar(tex(f, false)); });

    // 5. Tablas (sus celdas ya traen el LaTeX como marcadores).
    //    Se captura cada bloque de filas con pipe, incluso la última fila
    //    sin salto de línea final.
    t = t.replace(/(?:^|\n)((?:[^\n]*\|[^\n]*(?:\n|$))+)/g, function (m, bloque) {
      var ls = bloque.trim().split('\n').filter(function (l) { return l.indexOf('|') >= 0; });
      if (ls.length < 2) return m;
      nTab++;
      return '\n' + guardar(tabla(ls, nTab, '')) + '\n';
    });

    // 6. Estructura por líneas
    var lineas = esc(t).split('\n');

    // Numeracion de secciones: el encabezado mas alto que use el texto es el
    // nivel 1 (1., 2., 3.) y el siguiente son subsecciones (1.1, 1.2). Las
    // partes que en un paper no llevan numero quedan sin el.
    var SIN_NUMERO = /^(resumen|abstract|referencias|bibliograf|anexo|ap.ndice|agradecim)/i;
    var minH = 9;
    for (var q = 0; q < lineas.length; q++) {
      var mh = lineas[q].match(/^(#{1,6})\s+\S/);
      if (mh) minH = Math.min(minH, mh[1].length);
    }
    var nSec = 0, nSub = 0;
    var out = [], lista = null, parrafo = [], enCitas = false, enRef = false;

    function cerrarParrafo() {
      if (parrafo.length) {
        out.push('<p>' + inline(parrafo.join(' ')) + '</p>');
        parrafo = [];
      }
    }
    function cerrarLista() {
      if (lista) { out.push('</' + lista + '>'); lista = null; }
    }
    function cerrarCitas() {
      if (enCitas) { out.push('</blockquote>'); enCitas = false; }
    }
    function cerrarTodo() { cerrarParrafo(); cerrarLista(); cerrarCitas(); }

    for (var i = 0; i < lineas.length; i++) {
      var l = lineas[i].replace(/\s+$/, '');

      if (/^\s*\u0000\d+\u0000\s*$/.test(l)) {          // bloque guardado
        cerrarTodo(); out.push(l.trim()); continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {      // regla horizontal
        cerrarTodo(); out.push('<hr>'); continue;
      }
      if (/^\s*$/.test(l)) { cerrarParrafo(); cerrarLista(); cerrarCitas(); continue; }

      var enc = l.match(/^(#{1,6})\s+(.*)$/);
      if (enc) {
        cerrarTodo();
        var hash = enc[1].length;
        var nivel = Math.min(hash + 1, 5);
        var texto = enc[2].trim();
        var plano = texto.replace(/[*_#]/g, '').trim();
        enRef = /^(referencias|bibliograf)/i.test(plano);
        var num = '';
        if (!SIN_NUMERO.test(plano)) {
          if (hash === minH) { nSec++; nSub = 0; num = nSec + '. '; }
          else if (hash === minH + 1 && nSec) { nSub++; num = nSec + '.' + nSub + ' '; }
        }
        out.push('<h' + nivel + '>' + num + inline(texto) + '</h' + nivel + '>');
        continue;
      }
      if (/^\s*(?:&gt;|>)\s?/.test(l)) {
        cerrarParrafo(); cerrarLista();
        if (!enCitas) { out.push('<blockquote>'); enCitas = true; }
        out.push('<p>' + inline(l.replace(/^\s*(?:&gt;|>)\s?/, '')) + '</p>');
        continue;
      }
      var vi = l.match(/^\s*[-*+]\s+(.*)$/);
      var vn = l.match(/^\s*\d+[.)]\s+(.*)$/);
      if (vi || vn) {
        cerrarParrafo(); cerrarCitas();
        var quiero = vi ? 'ul' : 'ol';
        if (lista && lista !== quiero) cerrarLista();
        if (!lista) { out.push('<' + quiero + '>'); lista = quiero; }
        out.push('<li>' + inline((vi || vn)[1]) + '</li>');
        continue;
      }
      if (enRef && l.trim()) {
        cerrarParrafo(); cerrarLista();
        out.push('<p class="referencia">' + inline(l.trim()) + '</p>');
        continue;
      }
      cerrarLista(); cerrarCitas();
      parrafo.push(l.trim());
    }
    cerrarTodo();

    // Restauración ITERATIVA: los marcadores pueden anidarse (el LaTeX
    // inline dentro de una celda de tabla vive dentro del marcador de la
    // tabla). Una sola pasada de regex no re-escanea el HTML recién
    // insertado; con bucle, se resuelven todos los niveles.
    var resultado = out.join('\n');
    var previo;
    do {
      previo = resultado;
      resultado = resultado.replace(/\u0000(\d+)\u0000/g, function (m, i) {
        return bodega[+i];
      });
    } while (resultado !== previo);
    return resultado;
  }

  /* ------------------------------- Estilos ------------------------------- */
  // Formato de paper académico: una columna, tipografía serif, resumen
  // destacado, secciones numeradas, ecuaciones numeradas al margen.
  function estilos() {
    return [
      '@page{margin:24mm 22mm}',
      '@page:first{margin-top:30mm}',
      'html{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
      'body{font-family:"Iowan Old Style",Georgia,"Times New Roman",serif;',
      '  color:#161a20;background:#fff;max-width:16.5cm;margin:0 auto;',
      '  padding:30px 36px 44px;font-size:11.2pt;line-height:1.6;',
      '  hyphens:auto;-webkit-hyphens:auto}',

      // ---- Portada (estilo paper: título centrado, autores, resumen) ----
      '.doc-cabecera{text-align:center;border-bottom:2.5px solid #161a20;',
      '  padding-bottom:20px;margin-bottom:26px}',
      '.doc-cabecera .marca{font-size:11pt;letter-spacing:.28em;text-transform:uppercase;',
      '  color:#5a6472;margin-bottom:10px}',
      '.doc-cabecera .titulo{font-size:21pt;font-weight:700;line-height:1.18;',
      '  letter-spacing:-.01em;color:#161a20;margin:0 0 8px}',
      '.doc-cabecera .autores{font-size:11pt;color:#3d4757;margin-bottom:4px}',
      '.doc-cabecera .meta{font-size:9.4pt;color:#8a93a3;margin-top:6px}',

      // ---- Resumen (abstract) ----
      '.abstract{margin:0 0 24px;padding:16px 20px;background:#f5f7fa;',
      '  border-left:3px solid #161a20;font-size:10.4pt}',
      '.abstract b{font-size:10.8pt;letter-spacing:.04em;text-transform:uppercase}',
      '.abstract p{margin:8px 0 0;text-align:justify}',
      '.keywords{margin-top:8px;font-size:9.8pt;color:#3d4757}',
      '.keywords b{font-weight:700}',

      // ---- Jerarquía: secciones numeradas, como en un journal ----
      'h2{font-size:13.5pt;margin:26px 0 9px;line-height:1.25;font-weight:700;',
      '  border-bottom:.7px solid #c8cdd6;padding-bottom:5px}',
      'h3{font-size:12pt;margin:19px 0 6px;line-height:1.3;font-weight:700}',
      'h4{font-size:11.2pt;margin:14px 0 4px;font-weight:700;font-style:italic}',
      'h5{font-size:11.2pt;margin:12px 0 3px;font-weight:600}',
      'h2,h3,h4,h5{break-after:avoid;page-break-after:avoid}',

      // ---- Texto ----
      'p{margin:0 0 9px;text-align:justify;orphans:3;widows:3}',
      'p+p{text-indent:1.1em}',
      'strong{font-weight:700}em{font-style:italic}',
      'ul,ol{margin:9px 0 11px 1.5em;padding:0}li{margin:3px 0}',
      'hr{border:none;border-top:.6px solid #d3d8e0;margin:20px 0}',

      // ---- Citas ----
      'blockquote{margin:12px 0 12px 1.2cm;padding:0;color:#2b3340;font-size:10.8pt}',
      'blockquote p{text-indent:0;margin:0 0 6px}',

      // ---- Referencias (sangría francesa) ----
      '.referencia{padding-left:1.27cm;text-indent:-1.27cm;text-align:left;',
      '  margin:0 0 8px;font-size:10.4pt}',

      // ---- Tablas (rótulo arriba, reglas horizontales) ----
      '.tabla-bloque{margin:18px 0;break-inside:avoid;page-break-inside:avoid}',
      '.tabla-bloque .rotulo{font-size:10.2pt;margin-bottom:6px;line-height:1.4}',
      'table{width:100%;border-collapse:collapse;font-size:9.9pt}',
      'thead th{border-top:1.2px solid #161a20;border-bottom:.8px solid #161a20;',
      '  padding:7px 9px;text-align:left;font-weight:700}',
      'tbody td{border-bottom:.4px solid #d3d8e0;padding:6px 9px;vertical-align:top}',
      'tbody tr:last-child td{border-bottom:1.2px solid #161a20}',

      // ---- Figuras ----
      '.figura{margin:18px 0;break-inside:avoid;page-break-inside:avoid;text-align:center}',
      '.figura .rotulo{font-size:10.2pt;text-align:left;margin-bottom:6px}',
      '.figura img{max-width:100%;height:auto;border:.4px solid #d3d8e0}',
      '.figura figcaption{font-size:9.4pt;color:#3d4757;text-align:left;margin-top:6px;',
      '  line-height:1.45}',

      // ---- Ecuaciones numeradas ----
      '.ecuacion{display:flex;align-items:center;gap:12px;margin:14px 0;',
      '  break-inside:avoid;page-break-inside:avoid}',
      '.ecuacion .ec-cuerpo{flex:1;text-align:center;overflow-x:auto}',
      '.ecuacion .ec-num{flex:none;font-size:10.2pt;color:#161a20;min-width:2.4em;',
      '  text-align:right}',
      '.katex{font-size:1.05em}.katex-display{margin:0}',
      '.tex-crudo{font-family:Menlo,monospace;font-size:9.6pt;color:#8a3a3a}',

      // ---- Código ----
      'code{font-family:Menlo,Consolas,monospace;font-size:9.4pt;background:#f2f4f7;',
      '  padding:1px 4px;border-radius:3px}',
      '.bloque-codigo{background:#f7f8fa;border:.5px solid #d8dde5;border-radius:5px;',
      '  padding:11px 13px;overflow-x:auto;font-size:9.2pt;line-height:1.5;',
      '  break-inside:avoid;page-break-inside:avoid;margin:12px 0}',
      '.bloque-codigo code{background:transparent;padding:0}',
      'a{color:#161a20;text-decoration:none;border-bottom:.5px solid #9aa4b2}',
      '.url-impresa{display:none}',

      // ---- Pie ----
      '.doc-pie{margin-top:34px;padding-top:11px;border-top:.6px solid #c8cdd6;',
      '  font-size:9pt;color:#5a6472;display:flex;justify-content:space-between}',
      '@media print{',
      '  body{padding:0;max-width:none}',
      '  .url-impresa{display:inline;color:#5a6472;font-size:8.6pt}',
      '  a{border-bottom:none}',
      '}'
    ].join('\n');
  }

  /* ------------------------------- Público -------------------------------- */
  function abrir(rawText, titulo) {
    var win = window.open('', '_blank');
    if (!win) {
      alert('Tu navegador bloqueó la ventana del documento. Permite las ventanas emergentes.');
      return;
    }
    var base = window.location.origin;
    var fecha = new Date().toLocaleDateString('es-CL',
      { day: 'numeric', month: 'long', year: 'numeric' });

    // Título: si el texto abre con un encabezado, ese es el título del
    // documento y se quita del cuerpo para no imprimirlo dos veces.
    var cuerpo = String(rawText || '').replace(/^\uFEFF/, '');
    var tit = (titulo || '').trim();
    var enc1 = cuerpo.match(/^\s*#{1,3}\s+(.+?)\s*(?:\n|$)/);
    if (!tit && enc1) {
      tit = enc1[1].replace(/[*_`#]/g, '').trim();
      cuerpo = cuerpo.slice(enc1[0].length);
    }
    if (!tit) tit = 'Documento técnico';

    win.document.write(
      '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">' +
      '<title>' + esc(tit) + ' — AI SEN</title>' +
      '<link rel="stylesheet" href="' + base + '/assets/katex/katex.min.css">' +
      '<style>' + estilos() + '</style>' +
      '</head><body>' +
      '<header class="doc-cabecera">' +
        '<div class="marca">AI SEN · Nota técnica</div>' +
        '<div class="titulo">' + esc(tit) + '</div>' +
        '<div class="autores">AI SEN</div>' +
        '<div class="meta">' + esc(fecha) + '</div>' +
      '</header>' +
      '<div class="abstract"><b>Resumen</b>' +
        '<p id="resumen"></p>' +
      '</div>' +
      '<main id="doc"></main>' +
      '<footer class="doc-pie"><span>AI SEN · Documento generado por IA</span>' +
        '<span>' + esc(fecha) + '</span></footer>' +
      '<script src="' + base + '/assets/katex/katex.min.js"><\/script>' +
      '<script>window.__fuente = ' + JSON.stringify(cuerpo) + ';' +
      'window.__titulo = ' + JSON.stringify(tit) + ';<\/script>' +
      '<script src="' + base + '/js/paper.js"><\/script>' +
      '<script>' +
      'window.addEventListener("load", function(){' +
      '  var doc = document.getElementById("doc");' +
      '  doc.innerHTML = window.AisenPaper.aHtml(window.__fuente);' +
      // Resumen: el primer párrafo del cuerpo PASA a ser el abstract y se
      // quita de abajo, para que el lector no lea lo mismo dos veces. Si no
      // hay un párrafo de entrada decente, el bloque de resumen desaparece.
      '  var caja = document.querySelector(".abstract");' +
      '  var p1 = doc.querySelector(":scope > p");' +
      '  if (p1 && p1.textContent.trim().length > 60) {' +
      '    document.getElementById("resumen").textContent = p1.textContent.trim();' +
      '    p1.parentNode.removeChild(p1);' +
      '  } else if (caja) { caja.parentNode.removeChild(caja); }' +
      '  setTimeout(function(){ window.print(); }, 500);' +
      '});' +
      '<\/script>' +
      '</body></html>'
    );
    win.document.close();
  }

  window.AisenPaper = { aHtml: toHtml, abrir: abrir, estilos: estilos };
})();
