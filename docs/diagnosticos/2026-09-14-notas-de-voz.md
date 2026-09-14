# Diagnóstico: por qué los asesores no oyen las notas de voz

14/9/2026 — Tarea 6b del plan "La voz cercana y la espera visible". Un asesor
pidió 7 veces "escríbelo, no se nos reproducen las notas de voz". Diagnóstico
de solo lectura: no se tocó código (ver "Por qué no se tocó código" al final).

## Resumen

La causa más probable es de compatibilidad, no un bug del CRM: el archivo que
manda un cliente por WhatsApp como nota de voz llega de Meta como
`audio/ogg; codecs=opus` (contenedor Ogg, códec Opus), el CRM lo guarda y lo
sirve TAL CUAL —sin transcodificar—, y Safari/WebKit (macOS e iOS, y por
extensión CUALQUIER navegador en iPhone, porque en iOS todos usan el motor
WebKit por política de Apple) no supo reproducir ese contenedor hasta una
versión muy reciente (Safari/WebKit 18.4, ~marzo 2025). Si los cuatro
asesores usan un iPhone o un Mac con Safari desactualizado (la pregunta sigue
sin responder, ver más abajo), esto solo explica el 100% de los casos.

## Lo que se verificó en código (evidencia, no hipótesis)

1. **`src/app/api/media/[...path]/route.ts`** no hace streaming ni toca
   cabeceras: valida sesión + fila en `agents` y devuelve un 307 a una URL
   firmada de Supabase Storage (`createSignedUrl`, TTL 60s). El `Content-Type`
   que termina viendo el navegador es el que Supabase Storage tiene guardado
   para ese objeto — esta ruta no participa en absoluto en decidirlo. Esto
   **descarta** la única causa que el plan autorizaba arreglar con código
   trivial ("un `Content-Type` mal servido por `api/media`"): no hay tal cosa,
   la ruta ni siquiera lo toca.

2. **`src/app/api/webhooks/whatsapp/route.ts`** (líneas ~1380-1387): al
   descargar el archivo de Meta, sube a Storage con
   `contentType: mimeType` — el `mimeType` es exactamente el que devolvió
   `getMetaMediaUrl()` (Graph API `GET /{media-id}`), sin normalizar ni
   transcodificar. Para una nota de voz, ese `mime_type` es literalmente
   `audio/ogg; codecs=opus`, documentado así por Meta (ver fuentes). O sea:
   el CRM sirve, byte a byte y cabecera a cabecera, el mismo archivo Ogg/Opus
   que entregó WhatsApp — ni lo dañó ni lo sirvió mal.

3. **`src/components/chat/message-bubble.tsx`** (`AudioContent`, líneas
   29-92) **ya tiene** desde el commit `b563f80` (21/8/2026, "Robustece el
   chat: … audio no soportado") un manejo de error para exactamente este
   caso: si el `<audio>` dispara `error` con código 4
   (`MEDIA_ERR_SRC_NOT_SUPPORTED` — códec/contenedor no soportado por el
   navegador), la burbuja cambia a un aviso "Este navegador no puede
   reproducir este audio." con un enlace "Descargar" que abre el archivo
   directo, en vez de un reproductor mudo. Está probado
   (`message-bubble.test.tsx`, líneas 50-64). **Es decir: la salida (1) del
   plan ("botón Descargar ya existe → instruir") YA ESTÁ IMPLEMENTADA desde
   hace tres semanas** — no hay que construir nada, solo decidir si
   comunicarla a los asesores basta o hace falta más.

4. **Hallazgo secundario, verificado en código pero NO es la causa del
   síntoma reportado** (por eso no se corrige acá, ver más abajo):
   `EXTENSION_BY_MIME` (`webhooks/whatsapp/route.ts`, líneas 278-287) tiene
   la clave `"audio/ogg"` sin el sufijo `; codecs=opus`. Como el `mimeType`
   real de una nota de voz SÍ trae ese sufijo, el lookup
   `EXTENSION_BY_MIME[mimeType]` no calza nunca para audios de voz y cae al
   default `"bin"` (línea 1382): el objeto en Storage queda guardado como
   `<conversationId>/<wamid>.bin` en vez de `.ogg`. Esto NO cambia el
   `Content-Type` servido (sigue siendo el `mimeType` completo, no depende de
   la extensión del archivo), así que no es la causa de que Safari no
   reproduzca el audio. Pero si un asesor usa el botón "Descargar" del punto
   3, el archivo baja con un nombre como `wamid-xyz.bin` — sin ninguna pista
   de que es un audio, lo que hace ese workaround todavía menos usable en un
   iPhone (Archivos no sabrá con qué abrirlo). Se reporta como deuda; no se
   corrige en esta tarea porque el plan limita el código a la causa del
   síntoma, y esta no lo es.

## Causa probable (bien fundamentada, con fuentes — no verificada contra un
dispositivo real en esta corrida)

- **WebKit (el motor de Safari en macOS Y de TODOS los navegadores en iOS,
  incluido "Chrome" o "Firefox" para iPhone, por la política de Apple que
  obliga a usar WebKit por debajo) no soportó el contenedor Ogg en absoluto
  hasta la versión 18.4** (macOS Sequoia 15.4 / iOS 18.4 / iPadOS 18.4,
  liberada ~marzo de 2025). Antes de esa versión, Safari solo reproducía
  Opus empaquetado en `.caf` (desde macOS High Sierra/iOS 11) — nunca en Ogg
  ni en WebM. Fuente primaria: el blog oficial de WebKit,
  ["WebKit Features in Safari 18.4"](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/):
  *"WebKit for Safari 18.4 rounds out support for media formats by adding
  Ogg container support for both Opus and Vorbis audio…"* y *"Safari 11 to
  18.3 played Opus only when packaged in a CAF file."*
- `caniuse.com/opus` (consultado 14/9/2026) muestra Safari macOS en
  "soporte parcial" en TODAS las versiones listadas (11 a 27 + Technology
  Preview, sin versión de "soporte completo" listada) y Safari iOS pasando
  de "parcial" (11-18.3) a "completo" recién en 18.4+.
- El mismo problema existe a nivel de SISTEMA OPERATIVO, no solo del
  navegador: AVFoundation —el framework de medios de Apple que usan tanto
  Safari como la app Archivos, Fotos y QuickTime— nunca tuvo un demuxer de
  Ogg y no admite plugins de códec de terceros. Esto está reportado en
  múltiples issues de proyectos que sirven audio Opus/Ogg a iOS (p. ej.
  [audioserve#18](https://github.com/izderadicka/audioserve/issues/18):
  *"iOS and OSX+Safari do not support opus+ogg audio format"*; la wiki de
  Xiph.org sobre iOS documenta la misma limitación). Esto es importante para
  la salida (1) del plan: **en un iPhone con Safari anterior a 18.4, ni
  siquiera descargar el archivo y abrirlo con otra app del sistema
  (Archivos, Notas de Voz) va a funcionar** — el problema no es "abrirlo en
  el navegador", es que el sistema entero no trae un decodificador de Ogg. La
  salida "Descargar" solo sirve de verdad si el asesor tiene instalada una
  app de terceros que traiga su propio decodificador (VLC, por ejemplo), algo
  que no se puede asumir.
- No verificado (y sin forma de verificarlo sin un iPhone real a mano):
  si el soporte nuevo de Ogg en Safari/WebKit 18.4 alcanza también a
  AVFoundation a nivel de sistema (para que Archivos/Fotos también lo abran)
  o si quedó exclusivo del motor de renderizado del navegador. Un artículo de
  terceros (frequal.com, "Ogg Opus Still Not Working In Safari 18.4") sugiere
  que incluso en 18.4 hay casos reportados de fallas — no se pudo confirmar
  ni descartar con una fuente primaria.
- Dato aparte, de menor peso, sin verificar contra esta instalación: hay
  reportes públicos de que las URLs firmadas (`createSignedUrl`) de Supabase
  Storage self-hosted no siempre devuelven la cabecera `Accept-Ranges`
  ([supabase/storage#322](https://github.com/supabase/storage/issues/322),
  [discusión #4115](https://github.com/orgs/supabase/discussions/4115)), lo
  que afectaría el AVANCE/SALTO dentro de un audio largo (no la reproducción
  desde el inicio). No se pudo comprobar contra el bucket `whatsapp-media` de
  este proyecto porque no había stack local de Supabase corriendo en esta
  sesión (ver más abajo). Se anota como posible molestia secundaria, no como
  causa del síntoma reportado.

## Lo que NO se pudo verificar en esta corrida (y por qué)

- **No se bajó un audio real por `api/media` ni se probó en un navegador
  real.** Docker Desktop estaba recién arrancado y, a diferencia de lo que
  suponía la tarea, el contenedor `supabase_db_Liminal_CRM` **no existe ni
  siquiera detenido** en esta máquina (`docker ps -a` no lo lista): el stack
  local de Supabase de este repo nunca se inicializó en esta sesión/máquina.
  Levantarlo desde cero (CLI de Supabase, que además es una trampa conocida
  en `CLAUDE.md` — "la CLI falla, usar docker exec") es una tarea de
  infraestructura fuera del alcance de un diagnóstico de solo lectura, así
  que no se intentó. Tal como permite explícitamente el enunciado de esta
  tarea, se documentó desde el código en vez de inventar una prueba que no
  se pudo hacer.
- No se probó en Safari de escritorio ni en iPhone reales — no hay uno a
  mano en esta corrida.
- No se confirmó si el `Content-Type` que sirve Supabase Storage local
  incluye o no el parámetro `codecs=opus` byte por byte (se infiere del
  código, no se midió con `curl -I`).

## Pregunta pendiente al operador (queda escrita, no se le preguntó — el
operador no está disponible durante esta corrida)

**¿Desde qué navegador y equipo trabajan los cuatro asesores?** (celular o
PC; si es celular, iPhone o Android; si es PC, Chrome/Brave/Safari/Edge; si
usan WhatsApp Web aparte del CRM, eso no cambia nada porque el problema es
del CRM, no de WhatsApp Web). Qué cambia según la respuesta:

- **Todos en Android o en PC con Chrome/Brave/Edge** → esto no explica el
  reclamo; hay que seguir investigando (¿un audio puntual corrupto? ¿un
  problema de red específico?). Baja probabilidad dado lo que reportó el
  asesor, pero hay que descartarlo antes de invertir en transcodificación.
- **Alguno en iPhone/iPad, o en Mac con Safari** → la causa de este
  diagnóstico explica el síntoma; hace falta saber la VERSIÓN de iOS/macOS
  de cada uno para saber si ya tienen 18.4+ (en cuyo caso el problema debería
  haberse resuelto solo, con solo actualizar el sistema) o si están en una
  versión anterior (en cuyo caso ninguna instrucción del lado del asesor
  arregla nada — hace falta transcodificar del lado del servidor, salida 2).
- **Usan WhatsApp Web / la app oficial de WhatsApp para escuchar los audios,
  y solo entran al CRM para el resto** → el reclamo dejaría de tener sentido
  tal como está planteado; valdría la pena repreguntar qué hacen exactamente
  cuando dicen "no se reproduce".

## Las tres salidas, con costo

1. **Botón "Descargar" — YA EXISTE, no hay que construirlo.** Costo: cero en
   código; el costo es solo instruir a los asesores a usarlo cuando vean el
   aviso "Este navegador no puede reproducir este audio.". Límite real: en un
   iPhone con Safari/iOS anterior a 18.4, descargar el archivo Ogg/Opus
   probablemente TAMPOCO sirva (ver "AVFoundation" arriba) — el asesor
   terminaría con un archivo que ninguna app del sistema puede abrir. Esta
   salida solo resuelve el problema de verdad si los asesores están en
   Android/Chrome/Brave (donde ni siquiera hace falta, porque ya reproduce
   directo) o en un Mac/iPhone ya actualizado a 18.4+.

2. **Transcodificar a `audio/mp4` (AAC) al recibir, con `ffmpeg` en el
   contenedor.** Es la única salida que arregla el problema de raíz
   independientemente de la versión de Safari/iOS de cada asesor. Costo
   verificado en este repo:
   - No hay `ffmpeg` ni ningún wrapper (`fluent-ffmpeg`, etc.) instalado hoy
     — sería una dependencia nueva, tanto del lado de Node (`package.json`)
     como del binario del sistema.
   - La imagen de producción (`Dockerfile`) usa `node:22-alpine` en las tres
     etapas, sin `ffmpeg`; agregarlo (`apk add ffmpeg`) engorda la imagen de
     ejecución (Alpine + ffmpeg suele sumar 60-100 MB) y agrega una
     dependencia de sistema más para mantener actualizada por CVEs.
   - CPU: transcodificar cada nota de voz entrante consume CPU del
     contenedor en el momento de recibirla (`mediaDownloadTasks`, el mismo
     bloque que hoy solo descarga y sube a Storage) — con volumen alto de
     audios podría competir con el resto del proceso Next.js en el mismo
     contenedor.
   - Alcance de la migración de código: tocaría el webhook
     (`webhooks/whatsapp/route.ts`, el bloque de `mediaDownloadTasks`) para
     transcodificar ANTES de subir a Storage, y probablemente conservar el
     original o no, a decidir. Se declara fuera de alcance de esta corrida
     (el plan lo pone explícitamente en "Fuera de alcance"), pasa a
     recomendación para v1.2.
   - Alternativa más liviana a evaluar en esa corrida futura: ¿transcodificar
     todas las notas de voz, o solo bajo demanda cuando la burbuja ya reportó
     el error 4? Bajo demanda gasta menos CPU en general pero necesita una
     ruta nueva (`api/media/.../transcode` o similar) y no sirve para el
     caso "se descarga para reenviar/archivar".

3. **Pedirle a Meta un formato alternativo.** No existe: la Cloud API no deja
   elegir el formato de salida de una nota de voz recibida — Meta entrega el
   audio tal como lo grabó el cliente (Ogg/Opus es el formato que usa la app
   de WhatsApp del lado del cliente para grabar notas de voz, no una opción
   del lado de quien recibe). Descartada.

## Recomendación para v1.2

Antes de invertir en transcodificar (salida 2, la única que resuelve la raíz
en todos los casos): conseguir la respuesta a la pregunta pendiente. Si
resulta que los cuatro asesores están en Android o en PC con
Chrome/Brave/Edge, hay que reabrir el diagnóstico — esta causa no aplicaría y
convendría no gastar el esfuerzo de meter `ffmpeg` al contenedor sin
necesidad. Si alguno está en iPhone/Mac con una versión vieja de Safari,
recomendar mientras tanto que actualicen el sistema operativo (si 18.4+ ya
está disponible para su equipo, es gratis y no toca una línea de código) y
programar la transcodificación en `ffmpeg` para v1.2 como arreglo definitivo
que no depende de que cada asesor actualice su equipo.

## Por qué no se tocó código en esta tarea

El único caso en que el plan autorizaba tocar código era "un `Content-Type`
mal servido por `api/media`" — y el punto 1 de la evidencia de arriba
descarta que eso exista: la ruta ni siquiera participa en decidir el
`Content-Type`, solo redirige a una URL firmada que ya trae el que se guardó
al subir. La causa real (compatibilidad de Safari/WebKit con Ogg/Opus) no es
un bug de este CRM — es una limitación del motor de los navegadores de los
asesores, no arreglable con un cambio trivial. El hallazgo secundario del
punto 4 (extensión `.bin` en vez de `.ogg`) SÍ es un bug real y trivial de
corregir, pero no es la causa del síntoma reportado, así que —siguiendo la
letra de la tarea— se deja documentado como deuda en vez de corregirlo acá.

## Deuda

- `EXTENSION_BY_MIME` no reconoce `audio/ogg; codecs=opus` (ni
  `audio/ogg;codecs=opus` sin espacio, si Meta alguna vez lo manda así): cae
  a `.bin`. Arreglo trivial (agregar la clave exacta, o normalizar
  cortando en `;` antes del lookup) pero se deja para la corrida que toque
  este archivo, para no mezclar un cambio de código con una tarea que el
  plan definió como diagnóstico puro.
- Falta la respuesta del operador a la pregunta de dispositivo/navegador de
  los cuatro asesores — bloquea decidir entre "no hacer nada" e "invertir en
  transcodificar".
- No se verificó `Accept-Ranges`/`Content-Length` reales contra el bucket
  `whatsapp-media` de este proyecto (sin stack local corriendo). Si se
  retoma este diagnóstico, medir con
  `curl -sI` contra una URL firmada real.
- El stack local de Supabase de este repo no está inicializado en esta
  máquina (ni el contenedor de base de datos existe, ni detenido). Si hace
  falta verificar esto con datos reales pronto, hay que correr `supabase
  start` (o el camino de `docker exec` que ya documenta `CLAUDE.md` para
  cuando la CLI falla) antes de retomar.

## Fuentes consultadas

- [WebKit Features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/) — soporte de Ogg (Opus/Vorbis) agregado en 18.4; antes, Opus solo en `.caf`.
- [caniuse.com/opus](https://caniuse.com/opus) — tabla de soporte por versión de Safari/iOS (consultado 14/9/2026).
- [Audio messages — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages) — `audio/ogg; codecs=opus` como formato de las notas de voz.
- [audioserve#18](https://github.com/izderadicka/audioserve/issues/18) y [Xiph.org — iOS wiki](https://wiki.xiph.org/IOS) — AVFoundation no trae demuxer de Ogg a nivel de sistema.
- [supabase/storage#322](https://github.com/supabase/storage/issues/322) y [supabase/discussions#4115](https://github.com/orgs/supabase/discussions/4115) — reportes de `Accept-Ranges` ausente en URLs firmadas (self-hosted), no verificado contra esta instalación.
