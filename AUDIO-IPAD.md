# Audios de WhatsApp en el iPad 2

La vista `/ipad/index.html` abre ahora una copia MP3 de las notas de voz. El original se conserva. Funciona también con audios anteriores que ya tienen su archivo guardado.

## Publicar la corrección

Esta corrección necesita los cambios en **los dos repositorios**:

1. **Francoldk/whatsapp-server-qr**: publicar `audio-compatible.js`, `audio-compat-auth.cjs`, la línea de registro añadida a `index.js` y los cambios en `package.json` y `package-lock.json`. Render debe ejecutar su instalación habitual de dependencias; se agrega `ffmpeg-static`.
2. **Francoldk/crm-whatsapp-simple**: publicar `pages/api/media-audio.js`, `lib/audio-compat-auth.cjs`, los archivos de `public/ipad` y estas instrucciones. Cloudflare sigue con su despliegue habitual. El conversor no se ejecuta en Cloudflare.
3. Abrir Safari en `/ipad/index.html?v=3` para actualizar la aplicación. En un chat, tocar reproducir. La primera conversión puede tardar unos segundos. Hay un botón Reintentar y un enlace Abrir MP3 que permite ver el detalle si el servidor devuelve un error.

Se reutilizan **SUPABASE_URL** y **SUPABASE_SERVICE_ROLE_KEY**. Ambos servidores deben tener exactamente la misma clave de servicio del mismo proyecto de Supabase, que ya se utiliza para gestionar los adjuntos. No se envía esa clave al iPad ni al otro servidor: las peticiones de conversión llevan una firma temporal. No hace falta agregar una clave nueva.

Si el servidor WhatsApp usa otro dominio, `WHATSAPP_RENDER_URL` en el CRM debe apuntar a su URL de envío, por ejemplo la existente que termina en `/send`. El CRM deriva de ella la ruta `/audio-compatible`. Si no está configurada, conserva el servidor predeterminado actual.

## Cómo funciona

El CRM valida la sesión y el acceso al contacto antes de abrir o convertir cada audio. Busca una copia guardada bajo `chat-media/compat-audio/v1/`. Si existe, entrega un enlace temporal y el audio no depende de que Render esté despierto. Si falta, pide al servidor WhatsApp que descargue el original desde Supabase y cree un MP3 mono de 24 kHz y 64 kbps. La copia queda guardada para las próximas reproducciones. Se usa el reproductor de Safari y no se descargan todos los audios al abrir el chat.

No se convierten documentos, enlaces externos ni archivos aportados directamente a la ruta del conversor. Sólo acepta peticiones firmadas del CRM que identifican un mensaje guardado. El conversor limita el original a 16 MB, el MP3 a 32 MB, el proceso a 25 segundos y las conversiones simultáneas a dos. Los archivos que exceden esos límites devuelven error; no se guarda una copia recortada. Los temporales se eliminan al terminar.

No recupera archivos originales eliminados o que nunca se guardaron. Tampoco cambia la función de grabar o enviar audios: esta corrección permite escuchar los adjuntos existentes.

## Verificación

Se comprobó la conversión real de Ogg/Opus a MP3 con FFmpeg y se verificaron formato, duración, canales y frecuencia. También se probaron el almacenamiento de la copia, la reutilización, las peticiones simultáneas, firmas inválidas, archivos dañados, límites, permisos por contacto, errores del servidor y los controles ES5 de la vista iPad. No se usaron audios de clientes para las pruebas y falta comprobar la reproducción en un iPad físico.

Prueba del CRM (desde la raíz, con `@babel/core`, `@babel/preset-env`, `jsdom` y `acorn` disponibles en NODE_PATH): `node tests/media-audio.cjs`.

Prueba del servidor WhatsApp: `node tests/audio-compatible.cjs` en Linux con FFmpeg y ffprobe instalados. El servidor en producción utiliza el binario que instala `ffmpeg-static`, o `FFMPEG_PATH` si ya existe uno en el entorno.
