/* ============================================================================
 * AI SEN — Pet (tamagotchi de cristal)
 * ----------------------------------------------------------------------------
 * Inspirado en el sistema de pets de Hermes (estados mapeados a la actividad),
 * pero minimalista y estático: no se desplaza. Solo está ahí, abriendo los
 * ojos, reaccionando a lo que pasa en el chat.
 *
 * Gamificación:
 *   - Bloqueado al entrar: un huevo de cristal dormido.
 *   - Se REGALA (eclosiona) cuando el usuario demuestra enganche:
 *       1. envió al menos un mensaje al chatbot, Y
 *       2. usó el clonador de voz al menos una vez.
 *   - Una vez vivo: parpadea (abre/cierra ojos), sigue la conversación
 *     (piensa, trabaja, celebra) y suelta corazones si le dices algo cariñoso.
 *   - Todo local en esta fase gratis: no hay cobros en la interfaz.
 *
 * API pública (la consume app.js):
 *   AisenPet.think()      → estado pensando (ojos entrecerrados)
 *   AisenPet.work()       → estado trabajando (ojos abiertos, pulso)
 *   AisenPet.celebrate()  → saltito de alegría
 *   AisenPet.failed()     → susto breve
 *   AisenPet.affection()  → corazones flotantes
 *   AisenPet.activity()   → registrar uso (chat/clonador) para la gamificación
 *   AisenPet.unlocked()   → ¿ya está vivo?
 * ========================================================================== */
(function () {
  'use strict';

  /* ----------------------------- ESTADO ------------------------------- */
  let alive = false;          // eclosionado o aún huevo
  let usedChat = false;       // gamificación: usó el chatbot
  let usedVoice = false;      // gamificación: usó el clonador
  const KEY = 'aisen.pet.v1';

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ alive, usedChat, usedVoice }));
    } catch (_) { /* sin storage */ }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        alive = !!d.alive;
        usedChat = !!d.usedChat;
        usedVoice = !!d.usedVoice;
      }
    } catch (_) { /* empieza de huevo */ }
  }

  /* ------------------------------- DOM -------------------------------- */
  const host = document.createElement('div');
  host.className = 'aisen-pet';

  function injectStyles() {
    if (document.getElementById('aisen-pet-style')) return;
    const s = document.createElement('style');
    s.id = 'aisen-pet-style';
    s.textContent = [
      '.aisen-pet{position:fixed;right:34px;bottom:34px;z-index:900;',
      '  width:76px;height:76px;cursor:pointer;user-select:none;',
      '  filter:drop-shadow(0 0 14px rgba(255,212,121,.35))}',
      '.aisen-pet svg{width:100%;height:100%;display:block}',
      // huevo dormido (bloqueado)
      '.aisen-pet .egg{animation:pet-float 5s ease-in-out infinite}',
      // criatura viva
      '.aisen-pet .body{animation:pet-breathe 4s ease-in-out infinite;transform-origin:50% 90%}',
      '.aisen-pet .eye{animation:pet-blink 5s infinite}',
      '.aisen-pet.think .eye{animation:pet-squint 1.2s ease-in-out infinite}',
      '.aisen-pet.work .body{animation:pet-breathe 1.6s ease-in-out infinite}',
      '.aisen-pet.celebrate .body{animation:pet-jump .8s ease-in-out}',
      '.aisen-pet.failed .body{animation:pet-startle .4s ease-in-out}',
      '@keyframes pet-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
      '@keyframes pet-breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.05)}}',
      '@keyframes pet-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.06)}}',
      '@keyframes pet-squint{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(.12)}}',
      '@keyframes pet-jump{0%{transform:translateY(0)}30%{transform:translateY(-16px) scaleY(.96)}60%{transform:translateY(0) scaleY(1.04)}100%{transform:translateY(0)}}',
      '@keyframes pet-startle{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}',
      // burbuja de mensaje
      '.aisen-pet .bubble{position:absolute;top:-44px;left:50%;transform:translateX(-50%);',
      '  background:rgba(14,22,40,.9);border:1px solid rgba(160,220,255,.25);',
      '  border-radius:12px;padding:6px 11px;font-size:11.5px;color:#eaf2ff;',
      '  white-space:nowrap;opacity:0;pointer-events:none;',
      '  transition:opacity .25s, transform .25s;font-family:inherit}',
      '.aisen-pet .bubble.show{opacity:1;transform:translateX(-50%) translateY(-4px)}',
      // corazones
      '.aisen-pet .heart{position:absolute;bottom:60px;left:50%;font-size:16px;',
      '  animation:pet-heart 1.6s ease-out forwards;pointer-events:none}',
      '@keyframes pet-heart{0%{opacity:0;transform:translate(-50%,0) scale(.6)}',
      '  20%{opacity:1}100%{opacity:0;transform:translate(-50%,-46px) scale(1.15)}}',
      // eclosión
      '.aisen-pet.hatch .egg{animation:pet-hatch .9s ease-out forwards}',
      '@keyframes pet-hatch{0%{transform:scale(1)}40%{transform:scale(1.15) rotate(-6deg)}',
      '  70%{transform:scale(1.08) rotate(5deg)}100%{transform:scale(1.3);opacity:0}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ---------------------------- DIBUJO -------------------------------- */
  // Huevo de cristal (bloqueado): tríada de color con la UI.
  // El acento de la página es cian (#5ce1e6) y magenta (#ff4d8d); el tercero
  // de la rueda de colores es el ámbar. Huevo cálido dorado→magenta, halo cian.
  function eggSVG() {
    return '<svg viewBox="0 0 100 100" class="egg" aria-label="Huevo de AI SEN">' +
      '<defs>' +
        '<linearGradient id="eggG" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="rgba(255,212,121,.75)"/>' +
          '<stop offset=".5" stop-color="rgba(255,150,102,.55)"/>' +
          '<stop offset="1" stop-color="rgba(255,77,141,.5)"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="M50 14 C70 14 82 34 82 52 C82 72 68 86 50 86 C32 86 18 72 18 52 C18 34 30 14 50 14 Z" ' +
        'fill="url(#eggG)" stroke="rgba(255,212,121,.55)" stroke-width="1.6"/>' +
      '<path d="M50 14 L50 40 M50 40 L46 52 M50 40 L55 55 M50 40 L50 62" ' +
        'stroke="rgba(255,247,224,.75)" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".65"/>' +
      '<circle cx="50" cy="50" r="5" fill="rgba(255,236,179,.75)">' +
        '<animate attributeName="r" values="5;6.5;5" dur="3s" repeatCount="indefinite"/>' +
        '<animate attributeName="opacity" values=".6;.85;.6" dur="3s" repeatCount="indefinite"/>' +
      '</circle>' +
    '</svg>';
  }

  // La criatura: una gota de cristal (blobatar) con dos ojos que parpadean.
  function petSVG() {
    return '<svg viewBox="0 0 100 100" aria-label="Mascota de AI SEN">' +
      '<defs>' +
        '<linearGradient id="petG" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#7ae9ff"/>' +
          '<stop offset=".5" stop-color="#5ce1e6"/>' +
          '<stop offset="1" stop-color="#2ea8d8"/>' +
        '</linearGradient>' +
        '<radialGradient id="petShine" cx=".35" cy=".3" r=".5">' +
          '<stop offset="0" stop-color="rgba(255,255,255,.55)"/>' +
          '<stop offset="1" stop-color="rgba(255,255,255,0)"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<g class="body">' +
        '<path d="M50 8 C72 8 88 30 88 56 C88 78 72 92 50 92 C28 92 12 78 12 56 C12 30 28 8 50 8 Z" ' +
          'fill="url(#petG)" stroke="rgba(160,220,255,.4)" stroke-width="1.4"/>' +
        '<ellipse cx="36" cy="28" rx="14" ry="9" fill="url(#petShine)"/>' +
        // ojos
        '<g fill="#04121f">' +
          '<ellipse class="eye" cx="38" cy="48" rx="5.4" ry="7" style="transform-origin:38px 48px"/>' +
          '<ellipse class="eye" cx="62" cy="48" rx="5.4" ry="7" style="transform-origin:62px 48px"/>' +
        '</g>' +
        '<circle cx="40" cy="45.5" r="1.7" fill="#fff" opacity=".85"/>' +
        '<circle cx="64" cy="45.5" r="1.7" fill="#fff" opacity=".85"/>' +
        // sonrisa
        '<path d="M43 62 Q50 68 57 62" stroke="#04121f" stroke-width="2.2" fill="none" stroke-linecap="round"/>' +
        // mejillas
        '<circle cx="32" cy="59" r="4" fill="rgba(255,77,141,.28)"/>' +
        '<circle cx="68" cy="59" r="4" fill="rgba(255,77,141,.28)"/>' +
      '</g>' +
    '</svg>';
  }

  function draw() {
    host.innerHTML = (alive ? petSVG() : eggSVG()) +
      '<div class="bubble"></div>';
  }

  function bubble(text, ms) {
    const b = host.querySelector('.bubble');
    if (!b) return;
    b.textContent = text;
    b.classList.add('show');
    setTimeout(function () { b.classList.remove('show'); }, ms || 2400);
  }

  function hearts(n) {
    for (let i = 0; i < (n || 3); i++) {
      const h = document.createElement('div');
      h.className = 'heart';
      h.textContent = Math.random() < 0.5 ? '💙' : '✨';
      h.style.animationDelay = (i * 0.18) + 's';
      h.style.marginLeft = ((Math.random() * 34) - 17) + 'px';
      host.appendChild(h);
      setTimeout(function () { h.remove(); }, 2200);
    }
  }

  /* -------------------------- GAMIFICACIÓN ---------------------------- */
  function activity(kind) {
    if (alive) return;
    if (kind === 'chat') usedChat = true;
    if (kind === 'voice') usedVoice = true;
    persist();
    if (usedChat && usedVoice) hatch();
  }

  function hatch() {
    if (alive) return;
    alive = true;
    persist();
    host.classList.add('hatch');
    bubble('¡Has despertado a tu SEN! 🎉', 3400);
    setTimeout(function () {
      host.classList.remove('hatch');
      draw();
      hearts(5);
    }, 900);
  }

  function withPet(fn) {
    if (!alive) return;
    const prev = host.className;
    host.className = 'aisen-pet ' + fn;
    setTimeout(function () {
      if (host.className === 'aisen-pet ' + fn) host.className = prev;
    }, 900);
  }

  /* ------------------------------ INICIO ------------------------------ */
  function init() {
    restore();
    injectStyles();
    draw();
    host.title = alive
      ? 'Tu SEN · te acompaña'
      : 'Tu SEN duerme en su huevo. Usa el chat y el clonador para despertarlo.';
    host.addEventListener('click', function () {
      if (alive) {
        hearts(2);
        bubble(['hola 🙂', 'estoy aquí', '¿hablamos?'][Math.floor(Math.random() * 3)], 1800);
      } else {
        bubble('Usa el chat y tu voz para despertarme', 2600);
      }
    });
    document.body.appendChild(host);
    // Fidelización: si el usuario ya usó chat + clonador en sesiones
    // anteriores, el huevo se abre solo al entrar (no vuelve a estar
    // bloqueado nunca más). Tras el montaje, para que la eclosión se vea.
    if (!alive && usedChat && usedVoice) {
      setTimeout(hatch, 400);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* --------------------------- API PÚBLICA ---------------------------- */
  window.AisenPet = {
    activity: activity,
    unlocked: function () { return alive; },
    think: function () { withPet('think'); },
    work: function () { withPet('work'); },
    celebrate: function () { if (alive) { withPet('celebrate'); hearts(3); } },
    failed: function () { withPet('failed'); },
    affection: function () { if (alive) hearts(4); }
  };
})();
