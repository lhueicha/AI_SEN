/* ============================================================================
 * AI SEN — configuración del navegador
 * ----------------------------------------------------------------------------
 * Aquí NO hay secretos. La clave del motor vive en el servidor, detrás de /api.
 * La anon key de Supabase es pública por diseño: sirve para el login y está
 * limitada por las políticas RLS de la base.
 * ========================================================================== */
window.AISEN_CONFIG = {
  // Todo pasa por el backend, en el mismo dominio. No hay CORS ni claves.
  baseUrl: '/api/v1',
  apiKey: null,

  // El motor de voz también entra por /api: la cuota se cuenta en el servidor.
  voice: { baseUrl: '/api/v1' },

  // Supabase → Project Settings → API
  supabaseUrl: 'https://nqonojwcvmhzwxqsqffd.supabase.co',
  supabaseAnonKey: 'sb_publishable_xL4OFxl2GtXP8o6OoDRLJw__t31ZsPz',

  dailyTokenLimit: 100000
};
