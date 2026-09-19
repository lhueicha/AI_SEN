# AI SEN — Motor de clonación de voz

El gancho del producto. Veinte segundos de muestra y la IA responde con esa voz.

## Por qué Chatterbox

**Chatterbox** (Resemble AI) es la única opción que cumple las tres condiciones
que necesita este negocio:

| Condición | Chatterbox |
|---|---|
| Licencia | **MIT** — uso comercial libre, sin regalías ni tope de uso |
| Clonación | **Zero-shot**: 5–20 s de muestra, sin entrenar nada |
| Costo | **$0** — self-host, corre en tu máquina |

Las alternativas quedaron fuera por licencia: XTTS-v2 (Coqui) y F5-TTS son
**no comerciales**. Usarlas para cobrar sería ilegal. ElevenLabs clona bien
pero cobra por uso, lo que rompe el margen de un plan de $5.

## Instalación (Mac, Apple Silicon)

Usamos el servidor self-host, que ya expone un endpoint compatible con OpenAI
— por eso encaja con `app.js` sin adaptadores.

```bash
git clone https://github.com/devnen/Chatterbox-TTS-Server.git
cd Chatterbox-TTS-Server
python3.10 -m venv venv && source venv/bin/activate

# Apple Silicon: PyTorch PRIMERO, si no las dependencias chocan
pip install torch torchaudio

pip install -r requirements.txt
pip install --no-deps git+https://github.com/devnen/chatterbox-v2.git@master
```

Edita `config.yaml` y pon el acelerador de Apple:

```yaml
device: mps
```

Arranca:

```bash
python server.py     # queda en http://localhost:8004
```

> Sigue la **"Option 4: Apple Silicon (MPS)"** del README del repo para las
> versiones exactas — es el paso donde más se rompe la instalación.

## Clonar una voz

1. Graba 5–20 segundos de voz limpia (sin música ni ruido), en `.wav` o `.mp3`.
2. Abre `http://localhost:8004` y súbela desde la interfaz del servidor.
3. En AI SEN, entra al modo **🗣 Voz** — la voz aparece en el selector.
4. Cada respuesta trae un botón 🔊 que la lee con esa voz.

**Regla que no se rompe:** solo voces con permiso de su dueño. Clonar la voz de
alguien sin su consentimiento es un problema legal serio, y en varios países
también penal. El consentimiento se pide y se guarda.

## CORS

El servidor tiene que aceptar el origen de la landing, o el navegador bloquea
la llamada. En `config.yaml`:

```yaml
cors_origins:
  - "http://localhost:8765"
  - "https://TU-DOMINIO.vercel.app"
```

## Dónde vive en producción — el punto importante

El motor de voz **necesita GPU para ser usable**. En CPU una frase puede tardar
entre 10 y 40 segundos, y eso mata la demo.

| Dónde | Chat (FreeLLMAPI) | Voz (Chatterbox) |
|---|---|---|
| Tu Mac (M-series, MPS) | ✅ | ✅ rápido |
| VPS Hostinger (sin GPU) | ✅ va bien | ⚠️ muy lento |
| Vercel | ❌ no corre servidores así | ❌ |

FreeLLMAPI sí funciona en el VPS: solo enruta, la inferencia pesada ocurre en
Groq/Google. La voz es distinta — ahí el cálculo es tuyo.

**Para la prueba con amigos**, la ruta barata es dejar el motor de voz en tu Mac
y exponerlo con un túnel (`cloudflared tunnel --url http://localhost:8004`),
que da una URL pública gratis. Mientras tu Mac esté encendida, la demo anda.
Si el gancho funciona y la gente paga, ahí se arrienda una GPU — y ya con
ingresos que la paguen.
