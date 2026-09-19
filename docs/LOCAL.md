# AI SEN — probar todo el stack en tu Mac

Antes de tocar el VPS, esto levanta el sistema completo en tu máquina.
Reutiliza el motor FreeLLMAPI que ya corre nativo en el puerto 3001, así que
no hay que volver a cargar las claves de los proveedores.

## 1. El archivo .env

En `~/Desktop/ISEN/deploy/`, crea `.env` con esto:

```bash
ENGINE_KEY=<la unified key de tu motor>
SUPABASE_URL=https://nqonojwcvmhzwxqsqffd.supabase.co
SUPABASE_SERVICE_KEY=<la secret key de Supabase>
```

**La `ENGINE_KEY`** sale del panel de tu motor: `http://localhost:3001` → Keys.

**La `SUPABASE_SERVICE_KEY`** es la clave secreta (`sb_secret_…`) de
Supabase → Project Settings → API. Es la única que hay que pegar a mano, y
la que nunca debe salir del servidor.

## 2. Levantar

```bash
cd ~/Desktop/ISEN/deploy
docker compose -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.local.yml ps
```

## 3. Abrir

```
http://localhost:8080
```

Entras con GitHub y el chat responde de verdad, con los modelos gratis.

## 4. Si algo falla

```bash
docker compose -f docker-compose.local.yml logs aisen-api --tail 40
docker compose -f docker-compose.local.yml logs caddy --tail 20
```

| Síntoma | Causa probable |
|---|---|
| `aisen-api` se reinicia en bucle | falta `SUPABASE_SERVICE_KEY` o `ENGINE_KEY` en `.env` |
| El chat dice "no pude alcanzar el motor" | FreeLLMAPI no está corriendo en el 3001 de tu Mac |
| Vuelves a una página en blanco tras entrar | falta `http://localhost:8080/` en las Redirect URLs de Supabase |
| `port is already allocated` | algo más ocupa el 8080 |

## Diferencia con producción

En el VPS se usa solo `docker-compose.yml`: ahí sí se levanta FreeLLMAPI como
contenedor, Caddy pide certificado real para el dominio, y el motor se
aprovisiona con `provision-engine.mjs`.
