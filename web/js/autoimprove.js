/* ============================================================================
 * AI SEN — Autorecurrencia (auto-mejora, patrón "auto research loop" de Karpathy)
 * ----------------------------------------------------------------------------
 * El chatbot no solo responde: APRENDE del usuario en cada interacción.
 *
 * Loop de Karpathy aplicado:
 *   1. ACTUAR  — el usuario habla; la respuesta se genera con lo ya aprendido.
 *   2. OBSERVAR — cada intercambio queda en un registro de observación.
 *   3. REFLEXIONAR — cada N intercambios, el LLM revisa las conversaciones
 *      recientes y extrae hechos del usuario (preferencias, contexto, términos
 *      que usa, temas recurrentes). El perfil se actualiza.
 *   4. MEJORAR — ese perfil se inyecta como contexto en la siguiente
 *      conversación: las respuestas se vuelven más ajustadas a la persona.
 *
 * Todo local (localStorage). El usuario nunca ve la maquinaria; solo nota
 * que el chatbot lo entiende cada vez mejor.
 * ========================================================================== */
(function () {
  'use strict';

  const KEY = 'aisen.autorecurrence';
  const REFLECT_EVERY = 4;   // reflexionar cada N intercambios

  /* ----------------------------- ESTADO --------------------------------- */
  let profile = load({
    version: 1,
    interactions: 0,        // intercambios vistos (contador del loop)
    facts: [],              // [{ fact, firstSeen, lastSeen, uses }]
    pending: []             // observaciones aún no reflexionadas {ts, user, bot}
  });

  function load(fallback) {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch (_) { /* lleno */ }
  }

  /* ------------------------- OBSERVAR (por turno) ----------------------- */
  function observe(userText, botText) {
    if (!userText) return;
    profile.interactions++;
    profile.pending.push({
      ts: new Date().toISOString(),
      user: String(userText).slice(0, 400),
      bot: String(botText || '').slice(0, 400)
    });
    if (profile.pending.length > 12) profile.pending = profile.pending.slice(-12);
    save();
  }

  /* ---------------------- REFLEXIONAR (periódico) ----------------------- */
  async function reflectMaybe() {
    if (profile.pending.length < REFLECT_EVERY) return;
    const token = window.AisenAuth && window.AisenAuth.token();
    if (!token) return;
    const batch = profile.pending;
    profile.pending = [];
    save();

    const transcript = batch.map(function (o) {
      return 'U: ' + o.user + '\nA: ' + o.bot;
    }).join('\n\n');

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
              'Revisa estos intercambios recientes con un usuario. Extrae entre ' +
              '2 y 5 hechos DURADEROS sobre el usuario (cómo prefiere que le ' +
              'respondan, su contexto, temas que le importan, términos que usa). ' +
              'Responde SOLO los hechos, uno por línea, sin numerar.\n\n' + transcript
          }]
        })
      });
      const data = await resp.json();
      const content = data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string' || !content) return;
      const facts = content
        .split(/\n/)
        .map(function (f) { return f.replace(/^[\s\d.\-–>*]+/, '').trim(); })
        .filter(function (f) { return f.length > 8 && f.length < 160; })
        .slice(0, 5);
      mergeFacts(facts);
    } catch (_) {
      // reflexión fallida: devolver las observaciones para la próxima ronda
      profile.pending = batch.concat(profile.pending).slice(-12);
      save();
    }
  }

  function mergeFacts(newFacts) {
    const now = new Date().toISOString();
    newFacts.forEach(function (f) {
      const found = profile.facts.find(function (x) {
        return x.fact.toLowerCase() === f.toLowerCase();
      });
      if (found) {
        found.uses++;
        found.lastSeen = now;
      } else {
        profile.facts.push({ fact: f, firstSeen: now, lastSeen: now, uses: 1 });
      }
    });
    if (profile.facts.length > 30) profile.facts = profile.facts.slice(-30);
    save();
  }

  /* ----------------------- MEJORAR (contexto) --------------------------- */
  function systemContext() {
    if (!profile.facts.length) return null;
    const top = profile.facts
      .slice()
      .sort(function (a, b) { return b.uses - a.uses; })
      .slice(0, 8)
      .map(function (f) { return '- ' + f.fact; })
      .join('\n');
    return 'Contexto aprendido sobre el usuario (auto-mejora). Adáptate a esto ' +
      'sin mencionarlo explícitamente:\n' + top;
  }

  /* ----------------------------- API PÚBLICA ---------------------------- */
  window.AisenAuto = {
    observe: observe,
    reflectMaybe: reflectMaybe,
    systemContext: systemContext,
    stats: function () {
      return { facts: profile.facts.length, interactions: profile.interactions };
    }
  };
})();
