/* ============================================================================
 * AI SEN — capa de datos sobre Supabase
 * ----------------------------------------------------------------------------
 * Usa la service_role key: salta las políticas RLS, así que SOLO puede vivir
 * en el servidor. Si esta clave llega al navegador, cualquiera puede leer y
 * escribir toda la base.
 * ========================================================================== */
'use strict';

const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!URL || !SERVICE_KEY) {
  console.error('[AI SEN] Faltan SUPABASE_URL y/o SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const supabase = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

/** Planes y su límite de tokens por día. */
// La voz clonada es EL gancho del producto: si el plan gratuito no la deja
// probar, nadie llega a sentir por qué pagaría. Todos los planes la incluyen;
// quien limita es la cuota diaria de tokens, que la síntesis también consume.
// Así el gratuito la prueba, se enamora, y sube de plan por volumen — no por
// haber chocado contra una puerta cerrada.
const PLANS = {
  free:    { label: 'Gratis',   daily:  100000, voice: true },
  basico:  { label: 'Básico',   daily:  500000, voice: true },
  pro:     { label: 'Pro',      daily: 1500000, voice: true },
  premium: { label: 'Premium',  daily: 6000000, voice: true }
};

const today = () => new Date().toISOString().slice(0, 10);

/** Valida el token que el navegador obtuvo de Supabase Auth. */
async function userFromToken(token) {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

/** Lee el perfil (plan). Lo crea en 'free' si aún no existe. */
async function getProfile(userId, email) {
  const { data } = await supabase
    .from('profiles').select('*').eq('id', userId).maybeSingle();
  if (data) return data;

  const { data: created } = await supabase
    .from('profiles')
    .insert({ id: userId, email: email, plan: 'free' })
    .select().single();
  return created || { id: userId, email: email, plan: 'free' };
}

/** Tokens gastados hoy por este usuario. */
async function usedToday(userId) {
  const { data } = await supabase
    .from('usage').select('tokens')
    .eq('user_id', userId).eq('day', today()).maybeSingle();
  return data ? data.tokens : 0;
}

/** Suma consumo del día. La función SQL add_usage hace el upsert atómico. */
async function addUsage(userId, tokens) {
  const n = Math.max(0, Math.round(tokens));
  if (!n) return;
  const { error } = await supabase.rpc('add_usage', {
    p_user_id: userId, p_day: today(), p_tokens: n
  });
  if (error) console.warn('[AI SEN] no pude registrar consumo:', error.message);
}

async function quotaOf(profile) {
  const plan = PLANS[profile.plan] || PLANS.free;
  const used = await usedToday(profile.id);
  return {
    plan: profile.plan,
    planLabel: plan.label,
    voice: plan.voice,
    used: used,
    limit: plan.daily,
    remaining: Math.max(0, plan.daily - used)
  };
}

module.exports = {
  supabase, PLANS, today, userFromToken, getProfile, usedToday, addUsage, quotaOf
};
