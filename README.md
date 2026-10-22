# Conexión AR

https://conexion-ar.web.app/

Web app (PWA) de chat, audios, archivos, llamadas y videollamadas entre PC y celular. Gratis.

## Dos tipos de sala

**Sala privada (nombre + contraseña)**
- Chat de 2 o más personas con historial de 30 días y mensajes pendientes (llegan aunque el otro no esté conectado).
- Todo se guarda **cifrado de extremo a extremo** (AES-GCM) en Firestore. La clave se deriva del nombre de sala + contraseña con PBKDF2 y nunca sale del dispositivo.
- ✓ enviado / ✓✓ leído, "escribiendo…", en línea / última vez.
- Audios y archivos de hasta 15 MB (cifrados, en partes de 700 KB).
- Llamadas y videollamadas 1 a 1 (WebRTC directo). En grupos se elige a quién llamar.
- La identidad es el **nombre dentro de la sala**: la misma persona puede entrar desde varios dispositivos.

**Sala rápida (código de 6 letras o QR)**
- Conexión directa entre 2 dispositivos (WebRTC). Nada se guarda.

Ambas: compartir pantalla (PC), emojis, PWA instalable.

## Arquitectura

| Pieza | Para qué | Dónde |
|---|---|---|
| Firebase Hosting | Sitio web | `public/` |
| Firestore | Mensajes cifrados de salas privadas y señalización WebRTC | `firestore.rules` |
| Firebase Auth (anónimo) | Que solo la app pueda usar Firestore | consola de Firebase |
| Cloudflare Worker | Notificaciones push con la app cerrada | `worker/` |

Colecciones de Firestore:
- `chats/{id}/messages`, `parts`, `members`, `calls` — salas privadas
- `rooms/{codigo}` — salas rápidas
- `lines/{id}` — punto de encuentro de las llamadas directas

## Publicar cambios

```
firebase deploy                      # sitio + reglas
cd worker && npx wrangler@4 deploy   # servidor de notificaciones
```

Al cambiar `css/styles.css` o `js/app.js`, subir el número `?v=` en `public/index.html` y `public/sw.js`.

## Notificaciones push

- Servidor: `https://conexion-ar-push.firmaestudio.workers.dev` (cuenta de Cloudflare).
- Clave pública VAPID en `public/js/firebase-config.js`; la privada es el secreto `VAPID_PRIVATE_JWK` del Worker.
- Cada usuario debe tocar la 🔔 en la sala privada.
- **No funcionan en modo incógnito** (limitación de Chrome/Edge).
- En iPhone solo funcionan con la app instalada en la pantalla de inicio (iOS 16.4+).

## Limitaciones

- Llamadas solo de a 2 personas.
- En algunas redes (datos móviles con CGNAT, redes de empresa) la conexión directa falla; hace falta un servidor TURN en `iceServers` (`public/js/firebase-config.js`). El Worker ya tiene la ruta `/turn` para el TURN de Cloudflare (requiere tarjeta), o se puede usar el plan gratis de Metered.
