# AI SEN — entrar con Google o GitHub

Ya está en el código: la pantalla de login muestra los dos botones. Falta
activarlos en Supabase, que necesita credenciales de cada proveedor.

**Por qué conviene:** con OAuth no hay correo de confirmación. Ese era el cuello
de botella —el plan gratuito de Supabase manda pocos correos por hora— y
desaparece por completo. Tus amigos entran en dos clics, sin inventar una
contraseña más.

---

## La URL que te van a pedir los dos

```
https://nqonojwcvmhzwxqsqffd.supabase.co/auth/v1/callback
```

Esa es la dirección a la que el proveedor devuelve al usuario. Es la misma para
Google y para GitHub.

---

## GitHub — 2 minutos, sin trámites

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
2. Rellena:
   - *Application name*: AI SEN
   - *Homepage URL*: `https://145-223-92-190.sslip.io`
   - *Authorization callback URL*: la URL de arriba
3. **Generate a new client secret** y copia el *Client ID* y el *Secret*.
4. Supabase → **Authentication → Sign In / Providers → GitHub** → activar,
   pegar ambos, **Save**.

Listo. Sin revisiones, sin límite de usuarios.

---

## Google — más trámite, pero es la que usará tu gente

Tus amigos tienen Gmail, no GitHub. Así que esta es la que importa para el
producto; GitHub sirve para que tú pruebes el flujo hoy mismo.

1. [Google Cloud Console](https://console.cloud.google.com) → crea un proyecto.
2. **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Tipo: **External**
   - Nombre, correo de soporte, correo de contacto
   - *Scopes*: solo `email`, `profile`, `openid`. **No pidas más** — en cuanto
     pides un scope sensible entras en revisión de Google, que tarda semanas.
3. **Credenciales → Crear credenciales → ID de cliente de OAuth**
   - Tipo: **Aplicación web**
   - *URI de redirección autorizados*: la URL de callback de arriba
4. Copia *Client ID* y *Client secret*.
5. Supabase → **Authentication → Sign In / Providers → Google** → activar,
   pegar ambos, **Save**.

### El detalle que te va a morder

Mientras la pantalla de consentimiento esté en **Testing**, solo entran los
correos que agregues a mano como *test users* (hasta 100). Si un amigo no está
en esa lista, Google lo rechaza y no vas a entender por qué.

Dos salidas:

- **Para probar con pocos**: agrega los correos de tus amigos como test users.
  Rápido, pero manual y no escala.
- **Para abrirlo**: publica la pantalla de consentimiento (**Publish app**).
  Con solo `email`, `profile` y `openid` —scopes no sensibles— normalmente sale
  sin pasar por revisión. Si Google igual te pide verificación, la consola te
  lo dirá en ese momento; no lo sabrás hasta intentarlo.

---

## Las URL de retorno en Supabase

Sin esto el usuario se autentica y vuelve a una página en blanco.

Supabase → **Authentication → URL Configuration**:

| Campo | Valor |
|---|---|
| Site URL | `https://145-223-92-190.sslip.io` |
| Redirect URLs | `https://145-223-92-190.sslip.io/**` |

Cuando compres tu dominio, agrégalo aquí también.

---

## Qué pasa por dentro

Nada más que cambiar. El trigger `handle_new_user` se dispara igual cuando
alguien entra por Google o GitHub, así que su perfil se crea con plan `free`
como con cualquier registro. La API valida el token de sesión sin importar de
dónde vino.

Si un proveedor no está activado, el botón no falla feo: dice *"Ese acceso aún
no está activado en el proyecto"*.
