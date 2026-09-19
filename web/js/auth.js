/* ============================================================================
 * AI SEN — cuentas (Supabase Auth)
 * ----------------------------------------------------------------------------
 * El navegador habla directo con Supabase para registrarse y entrar. Lo único
 * que guarda es el token de sesión, que después manda a /api en cada petición.
 * La clave del motor nunca pasa por aquí: vive en el servidor.
 * ========================================================================== */
(function () {
  'use strict';

  // Marcas oficiales de los proveedores, dibujadas en línea.
  const LOGO = {
    google:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.2c-.3 1.4-1.1 2.6-2.3 3.4v2.8h3.7C21.8 18.7 23 15.8 23 12.3z"/>' +
      '<path fill="#34A853" d="M12 23c3.1 0 5.7-1 7.6-2.8l-3.7-2.8c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v2.9C3.7 20.5 7.6 23 12 23z"/>' +
      '<path fill="#FBBC05" d="M5.6 13.8c-.2-.7-.4-1.4-.4-2.3s.1-1.6.4-2.3V6.3H1.8C1 7.9.6 9.7.6 11.5s.4 3.6 1.2 5.2l3.8-2.9z"/>' +
      '<path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.7l3.3-3.3C17.7 1.3 15.1.2 12 .2 7.6.2 3.7 2.7 1.8 6.3l3.8 2.9C6.5 6.5 9 4.8 12 4.8z"/>' +
      '</svg>',
    github:
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
      '<path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.600-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.2-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.9 1.2 1.9 1.2 3.2 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/>' +
      '</svg>'
  };

  let client = null;
  let token = null;
  // Qué accesos están realmente activos en el proyecto. Se consulta al
  // arrancar: mostrar un botón de un proveedor apagado manda al usuario a
  // una página de error de Supabase, fuera de la web, sin vuelta atrás.
  let activos = { email: true, google: false, github: false };
  let user = null;
  const listeners = [];

  /* ============================== INTERFAZ ================================ */

  function injectStyles() {
    if (document.getElementById('aisen-auth-style')) return;
    const s = document.createElement('style');
    s.id = 'aisen-auth-style';
    s.textContent = [
      '.aisen-gate{position:fixed;inset:0;z-index:999;display:flex;',
      '  align-items:center;justify-content:center;padding:20px;',
      '  background:rgba(4,6,13,.72);backdrop-filter:blur(10px)}',
      '.aisen-card{width:100%;max-width:380px;background:rgba(14,22,40,.85);',
      '  border:1px solid rgba(160,220,255,.2);border-radius:20px;padding:28px;',
      '  backdrop-filter:blur(20px);box-shadow:0 20px 60px rgba(0,0,0,.5)}',
      '.aisen-card h3{margin:0 0 4px;font-size:21px;color:#eaf2ff;letter-spacing:.01em}',
      '.aisen-card p.sub{margin:0 0 20px;font-size:13.5px;color:#8ea3c4;line-height:1.5}',
      '.aisen-card input{width:100%;box-sizing:border-box;margin-bottom:10px;',
      '  background:rgba(5,8,16,.7);border:1px solid rgba(160,220,255,.18);',
      '  border-radius:11px;padding:11px 14px;color:#eaf2ff;font-size:14px;',
      '  font-family:inherit}',
      '.aisen-card input:focus{outline:none;border-color:rgba(92,225,230,.6)}',
      '.aisen-card button.go{width:100%;margin-top:6px;padding:11px;',
      '  background:linear-gradient(135deg,#5ce1e6,#7ae9ff);color:#04202a;',
      '  border:0;border-radius:11px;font-weight:700;font-size:14.5px;',
      '  cursor:pointer;font-family:inherit}',
      '.aisen-card button.go:disabled{opacity:.55;cursor:default}',
      '.aisen-oauth{display:flex;flex-direction:column;gap:9px;margin-bottom:18px}',
      '.aisen-oauth button{display:flex;align-items:center;justify-content:center;',
      '  gap:10px;width:100%;padding:11px;border-radius:11px;cursor:pointer;',
      '  font-size:14px;font-weight:600;font-family:inherit;',
      '  background:rgba(255,255,255,.95);color:#1a1f2e;border:0}',
      '.aisen-oauth button:hover{background:#fff}',
      '.aisen-oauth button.gh{background:rgba(255,255,255,.1);color:#eaf2ff;',
      '  border:1px solid rgba(160,220,255,.22)}',
      '.aisen-oauth button.gh:hover{background:rgba(255,255,255,.17)}',
      '.aisen-oauth button svg{width:17px;height:17px;flex:none}',
      '.aisen-o{display:flex;align-items:center;gap:12px;margin:0 0 16px;',
      '  color:#6f83a3;font-size:12px}',
      '.aisen-o::before,.aisen-o::after{content:"";flex:1;height:1px;',
      '  background:rgba(160,220,255,.16)}',
      '.aisen-switch{margin-top:16px;font-size:13px;color:#8ea3c4;text-align:center}',
      '.aisen-switch a{color:#5ce1e6;cursor:pointer;text-decoration:none}',
      '.aisen-msg{font-size:13px;margin:10px 0 0;line-height:1.45}',
      '.aisen-msg.bad{color:#ff4d8d}.aisen-msg.good{color:#5ce1e6}',
      '.aisen-who{display:flex;align-items:center;gap:10px;',
      '  font-size:12.5px;color:#8ea3c4;flex-wrap:wrap}',
      '.aisen-who b{color:#eaf2ff;font-weight:600}',
      '.aisen-who a{color:#8ea3c4;cursor:pointer;text-decoration:underline}',
      '.aisen-plan{background:rgba(92,225,230,.15);border:1px solid rgba(160,220,255,.2);',
      '  border-radius:999px;padding:2px 10px;color:#5ce1e6}'
    ].join('');
    document.head.appendChild(s);
  }

  function gate() {
    injectStyles();
    let mode = 'login';
    const wrap = document.createElement('div');
    wrap.className = 'aisen-gate';

    function draw() {
      const entrando = mode === 'login';
      const hayOauth = activos.google || activos.github;
      wrap.innerHTML =
        '<div class="aisen-card">' +
          '<h3>' + (entrando ? 'Entra a AI SEN' : 'Crea tu cuenta') + '</h3>' +
          '<p class="sub">' + (entrando
            ? 'Tus tokens del día te esperan.'
            : 'Gratis. Tokens diarios de regalo, sin tarjeta.') + '</p>' +
          (hayOauth
            ? '<div class="aisen-oauth">' +
                (activos.google
                  ? '<button id="ai-google">' + LOGO.google + 'Continuar con Google</button>'
                  : '') +
                (activos.github
                  ? '<button class="gh" id="ai-github">' + LOGO.github + 'Continuar con GitHub</button>'
                  : '') +
              '</div>' +
              '<div class="aisen-o">o con tu correo</div>'
            : '') +
          '<input type="email" id="ai-mail" placeholder="tu@correo.com" autocomplete="email">' +
          '<input type="password" id="ai-pass" placeholder="contraseña" ' +
            'autocomplete="' + (entrando ? 'current-password' : 'new-password') + '">' +
          '<button class="go" id="ai-go">' +
            (entrando ? 'Entrar' : 'Crear cuenta') + '</button>' +
          '<p class="aisen-msg" id="ai-msg"></p>' +
          '<div class="aisen-switch">' +
            (entrando
              ? '¿Primera vez? <a id="ai-swap">Crea una cuenta</a>'
              : '¿Ya tienes cuenta? <a id="ai-swap">Entra aquí</a>') +
          '</div>' +
        '</div>';

      const msg = wrap.querySelector('#ai-msg');
      const btn = wrap.querySelector('#ai-go');

      // OAuth: Supabase redirige al proveedor y vuelve con la sesión lista.
      // Sin contraseñas que recordar y sin correo de confirmación.
      ['google', 'github'].forEach(function (prov) {
        const b = wrap.querySelector('#ai-' + prov);
        if (!b) return;
        b.onclick = async function () {
          msg.className = 'aisen-msg';
          msg.textContent = 'Abriendo ' + prov + '…';
          const { error } = await client.auth.signInWithOAuth({
            provider: prov,
            // La barra final importa. La lista de Supabase se guarda con
            // comodín (…/**) y ese patrón no cubre el origen pelado: sin
            // barra, Supabase no halla coincidencia y manda al Site URL.
            options: { redirectTo: window.location.origin + '/' }
          });
          if (error) {
            msg.className = 'aisen-msg bad';
            msg.textContent = /provider is not enabled/i.test(error.message)
              ? 'Ese acceso aún no está activado en el proyecto.'
              : traducir(error.message);
          }
        };
      });

      wrap.querySelector('#ai-swap').onclick = function () {
        mode = entrando ? 'signup' : 'login'; draw();
      };

      async function submit() {
        const email = wrap.querySelector('#ai-mail').value.trim();
        const pass = wrap.querySelector('#ai-pass').value;
        if (!email || !pass) {
          msg.className = 'aisen-msg bad';
          msg.textContent = 'Falta el correo o la contraseña.';
          return;
        }
        btn.disabled = true;
        msg.className = 'aisen-msg';
        msg.textContent = entrando ? 'Entrando…' : 'Creando tu cuenta…';

        const { data, error } = entrando
          ? await client.auth.signInWithPassword({ email: email, password: pass })
          : await client.auth.signUp({ email: email, password: pass });

        if (error) {
          btn.disabled = false;
          msg.className = 'aisen-msg bad';
          msg.textContent = traducir(error.message);
          return;
        }
        if (!entrando && data && data.user && !data.session) {
          msg.className = 'aisen-msg good';
          msg.textContent = 'Cuenta creada. Revisa tu correo para confirmarla.';
          btn.disabled = false;
          return;
        }
        wrap.remove();
      }

      btn.onclick = submit;
      wrap.querySelectorAll('input').forEach(function (i) {
        i.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
      });
    }

    draw();
    document.body.appendChild(wrap);
  }

  // Los mensajes de Supabase vienen en inglés; los pasamos a algo humano.
  function traducir(m) {
    const t = String(m || '').toLowerCase();
    if (t.includes('invalid login')) return 'Correo o contraseña incorrectos.';
    if (t.includes('already registered')) return 'Ese correo ya tiene cuenta.';
    if (t.includes('password should be')) return 'La contraseña necesita al menos 6 caracteres.';
    if (t.includes('email not confirmed')) return 'Confirma tu correo antes de entrar.';
    if (t.includes('rate limit') || t.includes('too many')) return 'Demasiados intentos. Espera un momento.';
    return m;
  }

  function badge() {
    if (document.querySelector('.aisen-who')) return;
    const bar = document.createElement('div');
    bar.className = 'aisen-who';
    bar.innerHTML = '<b>' + (user && user.email ? user.email : '') + '</b>' +
      '<a id="ai-out">salir</a>';
    bar.querySelector('#ai-out').onclick = async function () {
      await client.auth.signOut();
      location.reload();
    };
    // En la barra superior, junto al logo — siempre visible.
    const top = document.querySelector('.top');
    const chat = document.getElementById('chatbox');
    if (top) {
      top.appendChild(bar);
    } else if (chat && chat.parentNode) {
      chat.parentNode.insertBefore(bar, chat);
    }
  }

  /* ================================ API =================================== */

  // Endpoint público de Supabase: dice qué proveedores están habilitados.
  async function cargarProveedores(url, anonKey) {
    try {
      const r = await fetch(url.replace(/\/+$/, '') + '/auth/v1/settings',
        { headers: { apikey: anonKey } });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.external) {
        activos = {
          email: j.external.email !== false,
          google: j.external.google === true,
          github: j.external.github === true
        };
      }
    } catch (_) {
      // Sin respuesta, dejamos solo el correo: es lo que siempre existe.
    }
  }

  const Auth = {
    token: function () { return token; },
    user: function () { return user; },
    onChange: function (fn) { listeners.push(fn); if (token) fn(user, token); },

    setPlan: function (label) {
      const el = document.getElementById('ai-plan');
      if (el && label) el.textContent = label;
    },

    init: async function () {
      const cfg = window.AISEN_CONFIG || {};
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        console.error('[AI SEN] Faltan supabaseUrl / supabaseAnonKey en config.js');
        return;
      }
      if (!window.supabase) {
        console.error('[AI SEN] No cargó la librería de Supabase.');
        return;
      }
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

      client.auth.onAuthStateChange(function (_event, session) {
        token = session ? session.access_token : null;
        user = session ? session.user : null;
        if (token) { badge(); }
        listeners.forEach(function (fn) { fn(user, token); });
      });

      const { data } = await client.auth.getSession();
      if (data && data.session) {
        token = data.session.access_token;
        user = data.session.user;
        badge();
        listeners.forEach(function (fn) { fn(user, token); });
      } else {
        await cargarProveedores(cfg.supabaseUrl, cfg.supabaseAnonKey);
        gate();
      }
    }
  };

  window.AisenAuth = Auth;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', Auth.init);
  } else {
    Auth.init();
  }
})();
