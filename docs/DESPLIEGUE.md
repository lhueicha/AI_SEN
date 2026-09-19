# AI SEN — desplegar en el VPS

Todo en Docker. Una sola puerta al exterior (Caddy), HTTPS automático, y la
clave del motor viviendo solo en el servidor.

```
                    internet
                       │  443
              ┌────────▼────────┐
              │  caddy          │  TLS automático + sirve la web
              └───┬─────────┬───┘
                  │ /api/*  │ estático
          ┌───────▼──────┐  └─► index.html, app.js, assets
          │  aisen-api   │  guarda ENGINE_KEY · valida sesión · cuota
          └───┬──────┬───┘
              │      └──────────► chatterbox   (voz, perfil opcional)
              ▼
         freellmapi                (motor: 700+ modelos gratis)

    Supabase (afuera) ─── cuentas, login, tabla de consumo
```

Solo Caddy tiene puertos publicados. El motor y la API no son alcanzables
desde internet ni aunque alguien sepa la IP.

---

## Paso 0 — Cerrar la puerta (hazlo primero)

Tu VPS acepta root por contraseña desde cualquier parte de internet, y esa
contraseña estuvo en un chat. Antes que nada:

```bash
ssh root@145.223.92.190
passwd                        # contraseña nueva, larga
```

Luego pasa a llave SSH, que es lo que de verdad cierra la puerta. **Desde tu
Mac**, no desde el servidor:

```bash
ssh-keygen -t ed25519 -C "aisen"          # Enter a todo
ssh-copy-id root@145.223.92.190
ssh root@145.223.92.190                   # debe entrar sin pedir contraseña
```

Recién cuando eso funcione, apaga el acceso por contraseña **en el servidor**:

```bash
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

> Deja **otra terminal abierta y conectada** mientras haces esto. Si algo sale
> mal, esa sesión es tu única forma de volver a entrar.

Y el cortafuegos:

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

---

## Paso 1 — Supabase (5 minutos)

1. Entra a [supabase.com](https://supabase.com) y crea un proyecto gratis.
2. **SQL Editor → New query**: pega entero `supabase-schema.sql` y dale **Run**.
3. **Project Settings → API**, copia tres cosas:
   - Project URL → `SUPABASE_URL`
   - `anon public` → `SUPABASE_ANON_KEY` (pública, va en el navegador)
   - `service_role` → `SUPABASE_SERVICE_KEY` (**secreta, solo en el servidor**)
4. **Authentication → Providers → Email**: para la prueba con amigos, apaga
   *Confirm email*. Así entran al toque sin esperar el correo — el plan
   gratuito de Supabase manda pocos correos por hora y frenaría el registro.

---

## Paso 2 — Subir los archivos

Desde tu Mac:

```bash
cd ~/Desktop
rsync -av --exclude '_to_delete' --exclude '*.log' --exclude '.env' \
      ISEN/ root@145.223.92.190:/opt/aisen/ISEN/
rsync -av freellmapi/ root@145.223.92.190:/opt/aisen/freellmapi/
```

---

## Paso 3 — Configurar

En el servidor:

```bash
cd /opt/aisen/ISEN/deploy
cp .env.example .env
nano .env
```

Rellena:

| Variable | De dónde sale |
|---|---|
| `DOMAIN` | `145-223-92-190.sslip.io` (gratis, con HTTPS) |
| `ENGINE_KEY` | dashboard de FreeLLMAPI → Keys |
| `SUPABASE_URL` | paso 1 |
| `SUPABASE_SERVICE_KEY` | paso 1 — **secreta** |
| `SUPABASE_ANON_KEY` | paso 1 |

Y la parte pública, en `/opt/aisen/ISEN/config.js`:

```js
supabaseUrl: 'https://tu-proyecto.supabase.co',
supabaseAnonKey: 'eyJ...',     // la anon, NUNCA la service_role
```

---

## Paso 4 — Levantar

```bash
cd /opt/aisen/ISEN/deploy
docker compose up -d --build
docker compose ps
```

Caddy pide el certificado solo. Tarda unos segundos la primera vez.

### Aprovisionar el motor sin tocar el panel

En vez de crear la cuenta y pegar las claves a mano en el dashboard:

```bash
set -a && source .env && set +a
node provision-engine.mjs
```

Crea la cuenta admin, carga OpenRouter / Groq / Google, prueba cada clave
contra su proveedor real, y te imprime la `ENGINE_KEY` lista para el `.env`.

Como las claves anteriores pasaron por un chat, regenera la unificada de paso:

```bash
REGENERATE=1 node provision-engine.mjs
```

Pega la `ENGINE_KEY` que imprime en `.env` y recarga la API:

```bash
docker compose up -d aisen-api
```

### Conectar el MCP del motor

El motor expone un servidor MCP en `POST /mcp`, autenticado con la misma
unified key. Sirve para preguntarle en vivo: qué modelos gratis hay usables
ahora mismo, cómo está la salud de cada proveedor, qué estrategia de routing
está activa y cuánto ha ahorrado el caché.

| Herramienta | Qué responde |
|---|---|
| `list_models` | modelos servibles ahora, con contexto y parámetros |
| `provider_health` | estado de cada clave: healthy / rate_limited / invalid |
| `routing_info` | estrategia activa y cadena de respaldo |
| `set_routing_strategy` | cambia entre balanced / smartest / fastest / reliable |
| `usage_summary` | peticiones, tokens, tasa de éxito, modelos top |
| `cache_stats` · `compression_stats` | tokens ahorrados |

Para conectarlo desde Claude, agrégalo como servidor MCP remoto:

```
URL:  https://145-223-92-190.sslip.io/mcp
Auth: Bearer <ENGINE_KEY>
```

**Comprobar que quedó bien:**

```bash
curl https://145-223-92-190.sslip.io/api/health        # {"ok":true}
curl -I https://145-223-92-190.sslip.io/               # 200, con HTTPS

# Lo más importante: que los secretos NO salgan
curl -s -o /dev/null -w "%{http_code}\n" https://145-223-92-190.sslip.io/deploy/.env   # 404
curl -s https://145-223-92-190.sslip.io/ | grep -c "freellmapi-"                        # 0
```

Ese último tiene que dar **0**. Si da otra cosa, la clave del motor está
saliendo al navegador: para todo y revisa `config.js`.

---

## Paso 5 — Pasarle el link a tus amigos

```
https://145-223-92-190.sslip.io
```

Crean su cuenta con correo y contraseña, y entran con 100.000 tokens al día.

Cuando ya estén todos dentro, cierra el registro en Supabase
(**Authentication → Providers → Email → Allow new users: off**) para que nadie
más se cuele a gastar tus tokens.

Para subirle el plan a alguien, en el SQL Editor de Supabase:

```sql
update profiles set plan = 'pro' where email = 'tu.amigo@correo.com';
```

---

## La voz

No la levantes todavía en el VPS. Chatterbox sin GPU tarda entre 10 y 40
segundos por frase, y esa demora mata justo el efecto que queremos provocar.

```bash
docker compose --profile voz up -d     # solo cuando haya GPU
```

Para la prueba con amigos, déjala corriendo en tu Mac y expónla con un túnel:

```bash
cloudflared tunnel --url http://localhost:8004
```

Te da una URL pública gratis. La pones como `VOICE_URL` en el `.env` del
servidor y la voz anda rápido mientras tu Mac esté encendida. Detalles en
`../VOZ.md`.

---

## Actualizar después de un cambio

```bash
# desde tu Mac
rsync -av --exclude '_to_delete' --exclude '.env' ISEN/ root@145.223.92.190:/opt/aisen/ISEN/
# en el servidor
cd /opt/aisen/ISEN/deploy && docker compose up -d --build
```

Los archivos estáticos se toman al instante; la API solo si cambió su código.
