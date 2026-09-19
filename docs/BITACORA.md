# AI SEN — Bitácora del proyecto

**Última actualización:** 19 de septiembre de 2026
**Para:** quien continúe el trabajo (persona o agente) en Antigravity u otro entorno.

Este documento existe para que no tengas que reconstruir el contexto leyendo
código. Dice qué hay, qué está probado, qué está roto y por qué se tomó cada
decisión. Lo marcado como **verificado** se comprobó ejecutando, no leyendo.

---

## 1. Qué es

Chatbot web sobre modelos de lenguaje **gratuitos**, con tres modos:

| Modo | Qué hace | Archivo |
|---|---|---|
| Chatbot | conversa; aprende del usuario y ajusta sus respuestas | `web/js/app.js`, `autoimprove.js` |
| Clonar voz | tutor que enseña hablando con la voz del propio usuario | `web/js/app.js` + Chatterbox |
| Visión | pizarra que el modelo interpreta: matemáticas, croquis, PDF, FreeCAD | `web/js/vision.js` |

Extras: **segundo cerebro** (red de conceptos exportable a Obsidian,
`brain.js`), **lectura de labios** (`lipread.js`) y una mascota (`pet.js`).

Monetización: cuota diaria de tokens por usuario, planes de 5/10/20 USD.
Ver `NEGOCIO.md`.

---

## 2. Estado actual — qué funciona

**Verificado ejecutando, el 19/09/2026, en el stack local (`localhost:8899`):**

| Pieza | Evidencia |
|---|---|
| Sesión con GitHub | usuario creado vía OAuth, perfil `free` generado por el trigger |
| API tras Caddy | `/api/health` → `{"ok":true}` |
| Cuota por usuario | `/api/me` → plan, límite, usados, restantes; descuenta al conversar |
| Chat con modelos gratis | respuesta real de `dots-3-note-preview:free` vía AtlasCloud |
| Seguridad de la clave | la `ENGINE_KEY` no aparece en ningún archivo publicado |
| Rechazo sin sesión | `/api/v1/chat/completions` sin token → 401. **Falla cerrado.** |
| Voz clonada | `200 · audio/wav · 116 KB · 7 s` por la cadena completa |
| Documento PDF | 6/6 controles: sin sintaxis cruda, tabla, ecuación numerada, cita, APA |
| Detectores MediaPipe | mano y cara se crean en 491 ms, con modelos locales |
| Esqueleto de la mano | 21 puntos y 23 huesos dibujados; cambia de color al pintar |

**No verificado, y no se puede desde un agente:** la captura real de cámara y
micrófono. El panel del navegador de Claude las bloquea a nivel de plataforma,
y el control de escritorio concede navegadores **solo en modo lectura**. Todo
lo que dependa de `getUserMedia` (grabar voz, leer labios, cámara-pizarra) lo
tiene que probar una persona en un navegador real.

---

## 3. Arquitectura

```
navegador ──HTTPS──► caddy ──┬── /api/*  ──► aisen-api ──┬──► freellmapi ──► modelos gratis
                             │                           └──► chatterbox  ──► voz clonada
                             └── estático ──► web/
                                                Supabase ──► cuentas y cuota
```

**La regla que no se rompe:** la clave del motor vive solo en `infra/.env` y
dentro del contenedor `aisen-api`. El navegador nunca la ve; pide a `/api` con
su sesión de Supabase y es el backend quien añade la credencial.

La cuota se cuenta **en el servidor**. El contador del navegador es un reflejo:
se burla borrando el `localStorage`, así que no sirve para cobrar.

---

## 4. Historial

### Construido con Hermes (perfil Morfeo)
- Landing y estética cyberpunk con vidrio esmerilado.
- Motor **FreeLLMAPI** instalado y aprovisionado (OpenRouter, Groq, Google).
- **Segundo cerebro** (`brain.js`) siguiendo el patrón *LLM Wiki* de Karpathy:
  log crudo inmutable → páginas wiki que se densifican → grafo 3D interactivo
  → exportación `.md` con `[[wikilinks]]` para Obsidian.
- **Autorecurrencia** (`autoimprove.js`): observa, reflexiona cada 4
  intercambios, extrae hechos del usuario y los inyecta como contexto.
- **Modo visión** (`vision.js`): pizarra, análisis con modelos de visión,
  PDF, imagen, macro de FreeCAD → STL, memoria de cálculo.
- **Tutor de voz**: lección pedagógica hablada con la voz clonada.
- **Lectura de labios** (`lipread.js`) y mascota (`pet.js`).

### Construido con Claude (Cowork)
- Backend `api/` (sesión, cuota, ocultamiento de la clave).
- Cuentas en **Supabase**: esquema, RLS, trigger de perfil, OAuth con GitHub.
- Infraestructura Docker: Caddy con TLS automático, compose de producción y
  de desarrollo, `provision-engine.mjs` para cargar las claves sin panel.
- Reorganización a estructura profesional (`web/ api/ infra/ db/ docs/`).
- Pase de diseño visual sobre jerarquía, color semántico y negrita.
- `paper.js`: documento con tipografía de libro y normas APA.

---

## 5. Errores encontrados y su causa raíz

Vale la pena leerlos: varios eran invisibles para un `node --check`.

**MediaPipe nunca arrancaba.** El bundle es un módulo ESM que exporta
`FilesetResolver` y `HandLandmarker` como exports con nombre. El código hacía
`await import(...)`, **descartaba el resultado** y leía `window.FilesetResolver`
— que un ESM nunca define. `TypeError` en cada intento, cámara muerta.
→ Hay que quedarse con el espacio de nombres que devuelve `import()`.

**El chat devolvía "respuesta vacía".** El backend fuerza `stream:false` para
contar tokens exactos, pero el cliente leía la respuesta como flujo SSE. De un
JSON no saca ninguna línea `data:`.
→ Guiarse por el `content-type` real, no por lo que se pidió.

**El PDF imprimía markdown crudo.** Tras mover las carpetas, la ventana del
documento seguía pidiendo `/render.js`, que pasó a `/js/render.js`.
→ Un 404 silencioso; el código caía a texto plano sin avisar.

**La voz daba 402.** Un muro de pago bloqueaba la síntesis en el plan gratuito,
pero la interfaz dejaba grabar igual y fallaba al final. Peor: la voz es el
gancho del producto.
→ Todos los planes la incluyen; limita la cuota diaria.

**MP3 devolvía 500.** Esta instalación de Chatterbox no trae codificador de
MP3: responde *"Failed to encode audio"*. Comprobado: `wav 200 · opus 200 ·
mp3 500`.
→ Pedir siempre WAV.

**El OAuth volvía al dominio equivocado.** `redirectTo` usaba
`window.location.origin` sin barra final, y la lista de Supabase se guarda con
comodín (`…/**`), que no cubre el origen pelado. Al no coincidir, Supabase cae
al Site URL.
→ Añadir la barra y registrar también las URL exactas.

**Docker servía archivos viejos.** Montar archivos sueltos ata el montaje a su
inodo; al guardar, el editor reemplaza el archivo y el contenedor sigue viendo
el anterior.
→ Montar la carpeta. Y `Cache-Control: no-store` en desarrollo, o persigues
errores ya corregidos.

**Caddy montaba la carpeta entera.** Habría publicado `.env` en internet.
→ Solo existe `web/`, y ahí dentro no hay secretos. Protección estructural,
no una lista de excepciones que alguien olvida actualizar.

---

## 6. Pendiente

**Antes de publicar:**

1. **Rotar todas las credenciales.** Pasaron por una conversación de chat: la
   contraseña de root del VPS, las claves de Groq / Gemini / OpenRouter, la
   unified key del motor y la contraseña de la base de Supabase.
2. **Cerrar el VPS**: llave SSH y apagar el acceso por contraseña
   (`DESPLIEGUE.md`, paso 0).
3. **Puertos 80/443 del VPS**: hay algo escuchando. Comprobar con
   `ss -tlnp | grep -E ':(80|443)\b'` — si es nginx o Apache, Caddy no podrá
   levantar.

**Funcional:**

4. Probar con micrófono y cámara reales los tres modos que los usan.
5. Google OAuth: falta el proyecto en Google Cloud (`OAUTH.md`). Ojo con el
   modo *Testing*: solo entran los correos agregados a mano.
6. Voz en producción: Chatterbox sin GPU tarda 10-40 s por frase. Para la
   prueba con amigos, túnel desde la Mac (`VOZ.md`).
7. Entrada basura en las Redirect URLs de Supabase (una URL concatenada larga).
   Inofensiva, pero conviene borrarla.

**Deuda técnica:**

8. `autoimprove.js` gasta tokens por su cuenta: cada 4 intercambios pide una
   reflexión al modelo. Medir cuánto consume antes de abrirlo a usuarios.
9. La etiqueta del plan en la barra superior queda en `…` hasta la primera
   respuesta del servidor.

---

## 7. Cómo arrancar

### Local (Mac con Docker Desktop)

Requiere el motor FreeLLMAPI corriendo nativo en el puerto 3001.

```bash
cd ~/Desktop/ISEN/infra
docker compose -f docker-compose.local.yml up -d --build
```
→ http://localhost:8899

Los archivos de `web/` se sirven en vivo: editar y recargar basta. Solo hay que
reconstruir cuando cambia `api/`:

```bash
docker compose -f docker-compose.local.yml up -d --build aisen-api
```

### Producción (VPS)

```bash
cd infra && docker compose up -d --build && node provision-engine.mjs
```

Paso a paso en `DESPLIEGUE.md`.

---

## 8. Advertencia sobre agentes en paralelo

Durante el desarrollo, **Hermes y Claude editaron los mismos archivos a la
vez**. Un agente guardaba y el otro revertía; las verificaciones pasaban porque
se miraba el archivo justo después de escribirlo, antes de que lo pisaran. Se
perdió alrededor de una hora hasta que la fecha de modificación lo delató.

Si vas a trabajar con más de un agente sobre esta carpeta: que solo uno escriba
a la vez, o repártanse archivos sin solaparse. Y ante un comportamiento que no
cuadra, lo primero es mirar `ls -la` — la fecha dice la verdad.

---

## 9. Criterios de diseño

Están escritos como comentario dentro de `web/index.html` para que no se
deshagan sin querer:

1. **Tamaño = jerarquía.** La escala salta (15 → 19 → 27 → 44). Si dos cosas
   miden casi igual, el ojo no sabe cuál importa.
2. **Color = significado.** Cian es el usuario y lo accionable; rosa es *solo*
   error. Un color que grita siempre pierde la capacidad de avisar.
3. **Negrita = guía de lectura.** Marca el término que el lector debe llevarse.
   Si todo resalta, nada resalta.

En los documentos exportados manda APA: tablas con rótulo arriba y solo líneas
horizontales, figuras con nota debajo, ecuaciones numeradas, referencias con
sangría francesa.
