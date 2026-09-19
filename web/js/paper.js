/* ============================================================================
 * AI SEN — Documento (paper.js)
 * ----------------------------------------------------------------------------
 * Convierte la respuesta del modelo en un documento de libro de texto.
 *
 * Nada de sintaxis a la vista: ni asteriscos, ni almohadillas, ni pipes.
 * Lo que el markdown marca, aquí se convierte en tipografía real.
 *
 * Aplica convenciones APA (7ª ed.) donde corresponde:
 *   · Tablas   — rótulo ARRIBA ("Tabla 1" en negrita, título en cursiva),
 *                solo líneas horizontales, jamás verticales.
 *   · Figuras  — rótulo ARRIBA, nota explicativa DEBAJO en cuerpo menor.
 *   · Ecuaciones — centradas y numeradas a la derecha: (1), (2)…
 *   · Citas    — sangría francesa en la lista de referencias; las citas en
 *                el texto (Autor, 2024) se respetan tal cual.
 *
 * El numerado de tablas, figuras y ecuaciones es automático y correlativo.
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
      html = window.katex.renderToString(src.trim(), {
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
  // El orden importa: primero el código (protege su contenido), después
  // negrita, cursiva y enlaces.
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, function (m, c) { return '<code>' + c + '</code>'; })
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '')   // las imágenes se tratan aparte
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
        '<a href="$2">$1</a><span class="url-impresa"> ($2)</span>');
  }

  /* ------------------------------ Tablas --------------------------------- */
  // APA: rótulo arriba, solo reglas horizontales, sin rejilla.
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

    // 2. Ecuaciones en bloque (numeradas)
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, function (m, f) {
      nEc++; return guardar(tex(f, true, nEc));
    });

    // 3. Imágenes → figura con rótulo APA
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, url) {
      nFig++;
      return guardar(
        '<figure class="figura">' +
        '<div class="rotulo"><b>Figura ' + nFig + '</b></div>' +
        '<img src="' + esc(url) + '" alt="' + esc(alt) + '">' +
        (alt ? '<figcaption><i>Nota.</i> ' + inline(esc(alt)) + '</figcaption>' : '') +
        '</figure>');
    });

    // 4. Tablas (con su título en la línea previa si la hay)
    t = t.replace(/(?:^|\n)((?:[^\n]*\|[^\n]*\n)+)/g, function (m, bloque) {
      var ls = bloque.trim().split('\n').filter(function (l) { return l.indexOf('|') >= 0; });
      if (ls.length < 2) return m;
      nTab++;
      return '\n' + guardar(tabla(ls, nTab, '')) + '\n';
    });

    // 5. Ecuaciones en línea
    t = t.replace(/\$([^\n$]+?)\$/g, function (m, f) { return guardar(tex(f, false)); });

    // 6. Estructura por líneas
    var lineas = esc(t).split('\n');
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
        var nivel = Math.min(enc[1].length + 1, 5);
        var texto = enc[2].trim();
        enRef = /^(referencias|bibliograf)/i.test(texto.replace(/[*_#]/g, '').trim());
        out.push('<h' + nivel + '>' + inline(texto) + '</h' + nivel + '>');
        continue;
      }
      // Ojo: el escapado ya convirtió ">" en "&gt;", así que hay que
      // reconocer las dos formas o las citas se pierden.
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
      // En la sección de referencias, cada línea es una entrada con
      // sangría francesa — así lo pide APA.
      if (enRef && l.trim()) {
        cerrarParrafo(); cerrarLista();
        out.push('<p class="referencia">' + inline(l.trim()) + '</p>');
        continue;
      }
      cerrarLista(); cerrarCitas();
      parrafo.push(l.trim());
    }
    cerrarTodo();

    return out.join('\n').replace(/\u0000(\d+)\u0000/g, function (m, i) {
      return bodega[+i];
    });
  }

  /* ------------------------------- Estilos ------------------------------- */
  function estilos() {
    return [
      '@page{margin:22mm 20mm}',
      'html{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
      'body{font-family:"Iowan Old Style",Georgia,"Times New Roman",serif;',
      '  color:#14181f;background:#fff;max-width:17cm;margin:0 auto;',
      '  padding:26px 34px 40px;font-size:11.6pt;line-height:1.62;',
      '  hyphens:auto;-webkit-hyphens:auto}',
      // Portada
      '.doc-cabecera{display:flex;justify-content:space-between;align-items:flex-end;',
      '  border-bottom:2.2px solid #14181f;padding-bottom:11px;margin-bottom:28px}',
      '.doc-cabecera .marca{font-size:23px;font-weight:700;letter-spacing:.05em}',
      '.doc-cabecera .meta{font-size:9.6pt;color:#5a6472;text-align:right;line-height:1.45}',
      // Jerarquía de títulos: saltos claros, como en un libro
      'h2{font-size:16.5pt;margin:26px 0 9px;line-height:1.24;font-weight:700;',
      '  border-bottom:.6px solid #c8cdd6;padding-bottom:5px}',
      'h3{font-size:13.4pt;margin:20px 0 6px;line-height:1.3;font-weight:700}',
      'h4{font-size:11.9pt;margin:15px 0 4px;font-weight:700;font-style:italic}',
      'h5{font-size:11.6pt;margin:12px 0 3px;font-weight:600}',
      'h2,h3,h4,h5{break-after:avoid;page-break-after:avoid}',
      // Texto
      'p{margin:0 0 9px;text-align:justify;orphans:3;widows:3}',
      'p+p{text-indent:1.1em}',              // sangría de continuación, como libro
      'strong{font-weight:700}em{font-style:italic}',
      'ul,ol{margin:9px 0 11px 1.5em;padding:0}li{margin:3px 0}',
      'hr{border:none;border-top:.6px solid #d3d8e0;margin:20px 0}',
      // Citas textuales: APA las quiere en bloque sin comillas
      'blockquote{margin:12px 0 12px 1.2cm;padding:0;color:#2b3340;font-size:11pt}',
      'blockquote p{text-indent:0;margin:0 0 6px}',
      // Referencias: sangría francesa
      '.referencia{padding-left:1.27cm;text-indent:-1.27cm;text-align:left;',
      '  margin:0 0 8px;font-size:11pt}',
      // Tablas APA: rótulo arriba, solo reglas horizontales
      '.tabla-bloque{margin:18px 0;break-inside:avoid;page-break-inside:avoid}',
      '.tabla-bloque .rotulo{font-size:10.6pt;margin-bottom:6px;line-height:1.4}',
      'table{width:100%;border-collapse:collapse;font-size:10.4pt}',
      'thead th{border-top:1.1px solid #14181f;border-bottom:.7px solid #14181f;',
      '  padding:7px 9px;text-align:left;font-weight:700}',
      'tbody td{border-bottom:.4px solid #d3d8e0;padding:6px 9px;vertical-align:top}',
      'tbody tr:last-child td{border-bottom:1.1px solid #14181f}',
      // Figuras
      '.figura{margin:18px 0;break-inside:avoid;page-break-inside:avoid;text-align:center}',
      '.figura .rotulo{font-size:10.6pt;text-align:left;margin-bottom:6px}',
      '.figura img{max-width:100%;height:auto;border:.4px solid #d3d8e0}',
      '.figura figcaption{font-size:9.8pt;color:#3d4757;text-align:left;margin-top:6px;',
      '  line-height:1.45}',
      // Ecuaciones numeradas
      '.ecuacion{display:flex;align-items:center;gap:12px;margin:14px 0;',
      '  break-inside:avoid;page-break-inside:avoid}',
      '.ecuacion .ec-cuerpo{flex:1;text-align:center;overflow-x:auto}',
      '.ecuacion .ec-num{flex:none;font-size:10.6pt;color:#14181f;min-width:2.4em;',
      '  text-align:right}',
      '.katex{font-size:1.04em}.katex-display{margin:0}',
      '.tex-crudo{font-family:Menlo,monospace;font-size:10pt;color:#8a3a3a}',
      // Código
      'code{font-family:Menlo,Consolas,monospace;font-size:9.8pt;background:#f2f4f7;',
      '  padding:1px 4px;border-radius:3px}',
      '.bloque-codigo{background:#f7f8fa;border:.5px solid #d8dde5;border-radius:5px;',
      '  padding:11px 13px;overflow-x:auto;font-size:9.6pt;line-height:1.5;',
      '  break-inside:avoid;page-break-inside:avoid;margin:12px 0}',
      '.bloque-codigo code{background:transparent;padding:0}',
      'a{color:#14181f;text-decoration:none;border-bottom:.5px solid #9aa4b2}',
      '.url-impresa{display:none}',
      // Pie
      '.doc-pie{margin-top:34px;padding-top:11px;border-top:.6px solid #c8cdd6;',
      '  font-size:9.4pt;color:#5a6472;display:flex;justify-content:space-between}',
      '@media print{',
      '  body{padding:0;max-width:none}',
      '  .doc-pie{position:running(pie)}',
      '  .url-impresa{display:inline;color:#5a6472;font-size:9pt}',  // en papel el enlace no se puede pulsar
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

    win.document.write(
      '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">' +
      '<title>' + esc(titulo || 'AI SEN — Documento') + '</title>' +
      '<link rel="stylesheet" href="' + base + '/assets/katex/katex.min.css">' +
      '<style>' + estilos() + '</style>' +
      '</head><body>' +
      '<header class="doc-cabecera">' +
        '<div class="marca">AI SEN</div>' +
        '<div class="meta">Documento generado<br>' + esc(fecha) + '</div>' +
      '</header>' +
      '<main id="doc"></main>' +
      '<footer class="doc-pie"><span>AI SEN</span><span>' + esc(fecha) + '</span></footer>' +
      '<script src="' + base + '/assets/katex/katex.min.js"><\/script>' +
      '<script>window.__fuente = ' + JSON.stringify(String(rawText || '')) + ';<\/script>' +
      '<script src="' + base + '/js/paper.js"><\/script>' +
      '<script>' +
      'window.addEventListener("load", function(){' +
      '  document.getElementById("doc").innerHTML =' +
      '    window.AisenPaper.aHtml(window.__fuente);' +
      '  setTimeout(function(){ window.print(); }, 450);' +
      '});' +
      '<\/script>' +
      '</body></html>'
    );
    win.document.close();
  }

  window.AisenPaper = { aHtml: toHtml, abrir: abrir, estilos: estilos };
})();
