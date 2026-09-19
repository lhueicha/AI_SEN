# AI SEN

Chatbot con modelos de lenguaje **gratuitos**, voz clonada y pizarra con visión.
Cuentas por correo o GitHub, cuota diaria por usuario y planes de pago bajos.

> La clave del motor nunca llega al navegador. El frontend habla con `/api`,
> y es el backend quien añade la credencial antes de llamar al motor.

---

## Estructura

```
ISEN/
├── web/              Frontend estático (lo único que se publica)
│   ├── index.html
│   ├── config.js     URLs y clave pública de Supabase
│   ├── js/           Módulos: chat, auth, cerebro, visión, voz…
│   └── assets/       KaTeX y modelos de MediaPipe (locales, sin CDN)
├── api/              Backend Node: sesión, cuota y proxy al motor
├── infra/            Docker Compose, Caddy y aprovisionamiento
├── db/               Esquema SQL de Supabase
├── docs/             Despliegue, OAuth, voz, negocio
└── _archivo/         Versiones antiguas (no se usa en ejecución)
```

## Arquitectura

```
navegador ──HTTPS──► caddy ──┬── /api/*  ──► aisen-api ──┬──► freellmapi ──► modelos gratis
                             │                           └──► chatterbox  ──► voz clonada
                             └── estático ──► web/
                                                Supabase ──► cuentas y cuota
```

Solo Caddy publica puertos. El motor y la API no existen desde internet.

| Pieza | Qué hace | Dónde |
|---|---|---|
| `web/` | interfaz | servida por Caddy |
| `api/` | valida la sesión, cuenta la cuota, esconde la clave | contenedor |
| `freellmapi` | unifica cientos de modelos gratuitos | contenedor (o nativo en local) |
| `chatterbox` | clona la voz | contenedor, perfil `voz` |
| Supabase | cuentas, planes y consumo | servicio externo |

## Arrancar

### Local (Mac con Docker Desktop)

```bash
cp .env.example infra/.env     # y rellena las claves
cd infra
docker compose -f docker-compose.local.yml up -d --build
```

→ **http://localhost:8899**

Reutiliza el motor FreeLLMAPI que corre nativo en el puerto 3001.
Detalle en [`docs/LOCAL.md`](docs/LOCAL.md).

### Producción (VPS)

```bash
cd infra
docker compose up -d --build
node provision-engine.mjs      # carga las claves de proveedor en el motor
```

Paso a paso en [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md).

## Variables de entorno

Todas en `.env.example`. Las que **no pueden** salir del servidor:

| Variable | Riesgo si se filtra |
|---|---|
| `ENGINE_KEY` | acceso libre a tu motor y a tu cuota |
| `SUPABASE_SERVICE_KEY` | lectura y escritura de toda la base, saltándose RLS |

La clave *publicable* de Supabase (`sb_publishable_…`) sí va en `web/config.js`:
está diseñada para el navegador y la limitan las políticas RLS de `db/schema.sql`.

## Funciones

- **Chatbot** — enrutado automático entre modelos gratuitos, con failover.
  Aprende del usuario y ajusta sus respuestas (`js/autoimprove.js`).
- **Segundo cerebro** — cada conversación alimenta una red de conceptos
  navegable, exportable a Markdown con wikilinks para Obsidian (`js/brain.js`).
- **Clonar voz** — un tutor que enseña hablando con la voz del propio usuario
  (`js/app.js` + Chatterbox). Ver [`docs/VOZ.md`](docs/VOZ.md).
- **Visión** — pizarra que el modelo interpreta: resuelve matemáticas en LaTeX,
  entiende croquis técnicos, exporta PDF, imagen y macros de FreeCAD
  (`js/vision.js`). Se dibuja con el mouse o con el dedo frente a la webcam.

## Documentación

| Archivo | Contenido |
|---|---|
| [`docs/BITACORA.md`](docs/BITACORA.md) | **Empieza aquí**: estado, historial, errores y pendientes |
| [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md) | VPS paso a paso, con verificación de seguridad |
| [`docs/LOCAL.md`](docs/LOCAL.md) | levantar todo en la Mac |
| [`docs/OAUTH.md`](docs/OAUTH.md) | entrar con Google o GitHub |
| [`docs/VOZ.md`](docs/VOZ.md) | motor de clonación de voz y sus límites |
| [`docs/NEGOCIO.md`](docs/NEGOCIO.md) | planes, precios y estrategia |
