# Diagnóstico: por qué en Chrome/Android tampoco se oyen las notas de voz

15/9/2026 — Tarea 7 del plan "La voz de mostrador con nombre propio y el
cierre de v1.1". Segunda vuelta del diagnóstico del 14/9/2026
(`docs/diagnosticos/2026-09-14-notas-de-voz.md`), que asumió Safari/WebKit
(Ogg/Opus no soportado hasta la versión 18.4). El operador confirmó
(Decisión 9) que los cuatro asesores usan **Android o PC con
Chrome/Brave/Edge** — navegadores que sí decodifican Ogg/Opus nativamente —
así que esa hipótesis queda **descartada** y hace falta una causa distinta.

Diagnóstico dirigido: hipótesis ordenadas, evidencia que decide cada una, y
UN arreglo de código pequeño e independiente del veredicto (la burbuja deja
de esconder "Reintentar" en el código 4). Sin acceso a producción ni al
operador durante la corrida: lo que se pudo medir se midió contra el stack
local de Supabase (`supabase_db_Liminal_CRM`, Kong en `127.0.0.1:54321`); lo
que exige una sesión real de Chrome contra producción queda escrito, paso a
paso, para que el operador o el Claude del VPS lo ejecute.

## Lo que se midió en local (evidencia, no hipótesis)

Se subió un archivo de prueba a `whatsapp-media/diag/nota-voz-test.ogg` con
el cliente admin (REST de Storage, misma cabecera `Content-Type: audio/ogg`
que pone el webhook al descargar de Meta) y se firmó con el MISMO TTL de 60s
que usa `api/media/[...path]/route.ts` (`createSignedUrl(path, 60)`).
Limpiado al terminar (`DELETE` del objeto): no queda nada en el bucket local.

**Antes de los 60s** (`curl -sI`):

```
HTTP/1.1 200 OK
Content-Type: audio/ogg
accept-ranges: bytes
```

Con `Range: bytes=0-1`:

```
HTTP/1.1 206 Partial Content
Content-Type: audio/ogg
content-range: bytes 0-1/50
```

**Después de los 60s** (mismo `curl`, misma URL, sin volver a firmar):

```
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"statusCode":"400","error":"InvalidJWT","message":"\"exp\" claim timestamp check failed","code":"InvalidJWT"}
```

Esto **confirma la mecánica exacta de H1** al nivel HTTP: una URL firmada
vencida no devuelve un error "de red" ni cierra la conexión — devuelve un
200-que-no-es-200: un `400` con cuerpo JSON, `Content-Type` distinto
(`application/json`, no `audio/*`). Para un `<audio>` que ya recibió esa URL
del 307 de `api/media` (con `preload="metadata"` resuelto al montar la
burbuja) y que vuelve a pedir bytes contra esa MISMA URL al dar play más
tarde, esto es indistinguible en la superficie de "el servidor mandó algo
que no es audio" — que es exactamente la familia de fallos que el estándar
de `HTMLMediaElement` mapea a `MEDIA_ERR_SRC_NOT_SUPPORTED` (código 4) en
Chrome, no a `MEDIA_ERR_NETWORK` (código 2): la conexión SÍ respondió, con
un recurso que el demuxer no puede tratar como audio.

Se intentó además reproducir el código de error exacto (`audio.error.code`)
dentro de un Chrome real (`claude-in-chrome`, navegando a
`http://127.0.0.1:54323` para tener un origen `http:` real y poder crear el
`<audio>` con `preload="metadata"` apuntando a la URL firmada del bucket
local) — se abandonó: el archivo de prueba subido no es un Ogg/Opus válido
(es texto plano con la extensión y el `Content-Type` correctos, no bytes de
audio reales), y sin `ffmpeg` en esta máquina no había forma barata de
generar uno. Con contenido inválido, Chrome se quedó indefinidamente en
`networkState=2` (`NETWORK_LOADING`) / `readyState=0` sin disparar `error`
ni antes ni después de vencer el token — un resultado que no aporta nada
sobre el código real que dispara un ARCHIVO VÁLIDO servido por una URL
vencida, y que se habría podido confundir con la causa equivocada. Se anota
como intento fallido, no como evidencia: **el código de error real
(`audio.error.code`) contra un audio real solo se puede confirmar en
producción** (pasos más abajo).

**H3 y H4 (medidas, no solo mecánica):** el `curl -sI` de arriba, tomado
ANTES de vencer el token, ya contesta las dos:

- `accept-ranges: bytes` está presente y el `Range: bytes=0-1` devuelve un
  `206` correcto con `content-range` — **descarta H3**. El reporte de
  `supabase/storage#322` que citaba el diagnóstico del 14/9/2026 no aplica a
  esta versión del storage self-hosted local.
- `Content-Type: audio/ogg` — el mismo valor que se puso al subir, sin
  normalizar a `application/octet-stream` — **descarta H4**.

Ambas mediciones son contra el storage **local**; no hay garantía de que la
versión desplegada en el VPS sea idéntica, pero es la misma imagen del mismo
`supabase-squad` (ver `CLAUDE.md`), así que sirve como evidencia fuerte, no
solo como intuición.

**H6 (mecánica probada, dato no representativo):** la consulta que decide
H6 corre tal cual contra el esquema real:

```sql
select count(*) from messages
where message_type='audio' and media_url is null
  and created_at > now() - interval '7 days';
```

Verificado contra `\d messages`: las tres columnas existen con esos nombres
y tipos. Contra la base local (semillas de desarrollo, sin tráfico real de
WhatsApp) da `0` — un resultado sin ningún valor probatorio para producción,
solo confirma que la consulta no tiene errores de sintaxis ni de columnas
para cuando el operador la corra contra datos reales.

## Corrección a la mecánica de H2 (leyendo el código, no solo la tabla del plan)

La tabla de hipótesis del plan describe H2 como "`proxy.ts` refresca en
navegaciones, no al cargar un `<audio>`". Leyendo `src/proxy.ts` y
`src/lib/supabase/middleware.ts` completos, esa frase describe mal el
mecanismo real:

- `updateSession` (lo que corre `proxy.ts`) **sale inmediatamente** para
  cualquier `pathname` que empiece con `/api` (comentario propio del
  archivo: *"Las rutas /api/\* manejan su propia autenticación... Cada route
  handler crea su propio cliente y renueva la sesión si le hace falta"*).
  `api/media` no pasa por el proxy en absoluto — ni para bien ni para mal.
- `api/media/[...path]/route.ts` llama a `createClient()` de
  `@/lib/supabase/server`, que arma su PROPIO `createServerClient` con la
  cookie de sesión, y ese cliente **sí tiene** `autoRefreshToken` en su
  default (`true`): solo `src/lib/supabase/admin.ts` lo desactiva
  explícitamente, y es el cliente de service role, no este. `getSession()`
  de `@supabase/ssr` renueva el token vencido usando el refresh token
  **dentro de la misma llamada**, sin depender de un timer — es el mismo
  comportamiento que el comentario de `middleware.ts` documenta para su
  propio uso de `getSession()` — y `createClient()` escribe la cookie nueva
  con `cookieStore.set(...)` (que en un Route Handler de App Router sí
  aplica el `Set-Cookie` a la respuesta, sea cual sea el objeto `Response`
  que el handler termine devolviendo).

Conclusión: un 401 de `api/media` por sesión vencida **no es simplemente**
"la petición del `<audio>` no dispara un refresco" — el refresco SÍ corre,
en cada llamada a esta ruta, igual que en cualquier otra. Para que H2 sea la
causa real hace falta que el **refresh token mismo** ya no sirva (sesión
cerrada en otro lado, revocada, o más vieja que su vida máxima — 30 días por
default en GoTrue), un caso bastante más raro que "pasó un minuto sin tocar
la pestaña". Esto no descarta H2 del todo (un asesor con la pestaña abierta
varios días, o que cerró sesión en otra pestaña, sí puede pegarle), pero le
baja la probabilidad frente a H1: H1 solo necesita que pasen 60 segundos
entre abrir el chat y dar play, algo que ocurre todo el tiempo; H2 necesita
una sesión genuinamente inválida.

## Tabla de veredictos

| # | Hipótesis | Veredicto | Evidencia |
|---|---|---|---|
| H1 | URL firmada vencida (60s) → 400 JSON → código 4, la burbuja "culpa al navegador" y escondía Reintentar | **Mecánica confirmada en local** (curl antes/después de los 60s, ver arriba); código de error exacto en un `<audio>` real de Chrome **pendiente de producción** (no se pudo forzar con contenido de prueba inválido, ver arriba) | `curl -sI` local antes/después del TTL; intento de reproducción en Chrome real documentado como no concluyente |
| H2 | 401 de sesión vencida en el `src` | **Improbable según el código, pendiente de producción**: `api/media` refresca la sesión en cada llamada (`getSession()` con `autoRefreshToken` activo), a diferencia de lo que sugiere la tabla del plan sobre `proxy.ts` (que ni siquiera corre para `/api/*`). Solo aplicaría con un refresh token ya inválido | Lectura completa de `proxy.ts`, `lib/supabase/middleware.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts` |
| H3 | Sin `Accept-Ranges`/206 en Storage self-hosted | **Descartada** (local): `accept-ranges: bytes` presente, `Range: bytes=0-1` devuelve 206 con `content-range` correcto | `curl -sI` con y sin `Range`, antes de vencer el token |
| H4 | `Content-Type` normalizado a `application/octet-stream` | **Descartada** (local): se sirve exactamente el `Content-Type` con el que se subió (`audio/ogg`) | `curl -sI`, antes de vencer el token |
| H5 | El `.bin` del webhook (T6) | **Hecha por otra tarea en esta misma corrida** (T6, `whatsapp/media-extension.ts`); no afecta a `<audio>`, solo al nombre de descarga | Fuera del alcance de esta tarea, confirmado como hecho por el orquestador |
| H6 | Descarga de Meta falló, `media_url` null | **Mecánica probada, dato real pendiente de producción**: la consulta corre sin error contra el esquema real; da 0 en datos locales sin valor probatorio | `\d messages` + `select count(*)...` contra `supabase_db_Liminal_CRM` |

**Causa más probable: H1.** Es la única que no exige ninguna condición rara
(sesión inválida, descarga fallida) — solo que pase más de un minuto entre
abrir el chat y dar play, algo tan común que explica por sí solo el reclamo
recurrente de los asesores, y su mecánica quedó confirmada al nivel HTTP en
esta misma corrida.

## Pasos para el operador o el Claude del VPS (producción, con sesión real)

Con DevTools → Network, "Preserve log" activado, en un chat con una nota de
voz reciente:

1. Abrir el chat y ESPERAR sin tocar el audio al menos 90 segundos (más que
   los 60s del TTL).
2. Dar play. En Network, buscar la última petición al dominio de Supabase
   Storage (`.../storage/v1/object/sign/whatsapp-media/...`) — anotar su
   status HTTP y, si es 4xx, pegar el cuerpo de la respuesta.
3. En la consola: `document.querySelector('audio').error` — anotar `.code` y
   `.message`. Si `code === 4` y el paso 2 dio un 4xx con JSON, **H1
   confirmada en producción**.
4. Recargar la página (URL firmada nueva) y dar play en menos de 60s desde
   que carga el chat: si ESTA vez reproduce, es evidencia adicional a favor
   de H1 (y en contra de H6 para ese mensaje puntual: el archivo sí estaba
   bien).
5. Para H2: repetir el paso 1-3 pero dejando la pestaña abierta e inactiva
   varias HORAS (o probar en una sesión donde conste que el asesor cerró
   sesión en otra pestaña) — un 401 (no 400) en el paso 2 apunta a H2 en vez
   de H1.
6. Para H6: correr contra la base de producción (con `psql` por SSH, no
   escribiendo nada):
   ```sql
   select count(*) from messages
   where message_type='audio' and media_url is null
     and created_at > now() - interval '7 days';
   ```
   Un resultado > 0 no prueba que ESE mensaje puntual sea el que el asesor
   reportó, pero > 0 sí es señal de que vale la pena cruzarlo con los
   wamids de los casos reportados.

## Salidas con costo (decisión del operador: el TTL NO se toca en esta corrida)

1. **TTL más largo en `SIGNED_URL_TTL_SECONDS`** (`api/media/[...path]/route.ts`).
   Arregla H1 de raíz para cualquier audio de menos que ese TTL, sin tocar
   nada más. Costo: una URL firmada más viva es una URL más fácil de
   reenviar/cachear fuera del CRM durante más tiempo — el bucket sigue
   privado, pero la ventana de "alguien con la URL, sin sesión" crece. **No
   se implementa en esta corrida** (decisión del operador, 15/9/2026): queda
   para quien retome esto en v1.2, con el número de segundos a elegir.
2. **Streaming con `Range` real en `api/media`, sin URL firmada intermedia**:
   el propio route handler valida sesión y sirve los bytes él mismo (o hace
   proxy de un `fetch` con el `Range` del cliente contra el objeto). Arregla
   H1 de raíz sin importar cuánto tiempo pase — no hay URL que venza porque
   no se expone ninguna URL de Storage al navegador. Costo: el archivo pasa
   por el proceso Next.js en vez de servirlo Supabase directo (más CPU/RAM
   del contenedor por cada audio reproducido, sobre todo si varios asesores
   escuchan a la vez); hay que reimplementar el manejo de `Range`/206 a
   mano, terreno con más superficie de bugs que un `redirect`. Alcance fuera
   de esta tarea (el operador ya declaró `api/media` fuera de alcance,
   Decisión 9).
3. **`preload="none"` en vez de `"metadata"`**: si el `<audio>` no resuelve
   la URL firmada hasta que el asesor toca play, el TTL de 60s alcanza
   siempre (nadie tarda un minuto entre tocar play y que cargue). Costo:
   se pierde la duración/controles habilitados antes del primer click —hoy
   `preload="metadata"` deja ver la duración sin reproducir— y es un cambio
   de UX, no solo de robustez; y no cubre el caso de un asesor que SÍ le da
   play, lo pausa, y lo retoma pasado el minuto (mismo problema, ventana más
   angosta). Cambio de una palabra, pero fuera del alcance que autorizó esta
   tarea (el único arreglo de código permitido es la rama del código 4 de la
   burbuja) — se anota como opción barata para v1.2, no se implementa acá.
4. **Transcodificar el audio**: ya no aplica (era la salida del diagnóstico
   del 14/9/2026 para el problema de Safari/Ogg, que no es la causa acá).

## Único arreglo de código de esta tarea

`src/components/chat/message-bubble.tsx`, rama del código 4 dentro de
`AudioContent`: ya no asume "códec no soportado" (mensaje "Este navegador no
puede reproducir este audio.", sin Reintentar) — pasa a un mensaje neutro
("No se pudo reproducir el audio.") con **Reintentar** (mismo `setAttempt`
que ya usaba la rama genérica: monta un `<audio>` nuevo con `key={attempt}`,
que vuelve a pedir `src` a `api/media` y por lo tanto una URL firmada
fresca) **y** Descargar (se conserva, para el caso real de códec no
soportado o de un archivo roto). El comentario en el código deja escrita la
razón: en Chrome el código 4 también sale de un 401/400 con cuerpo JSON, no
solo de un contenedor no soportado, así que esconder Reintentar ahí
castigaba también al caso más común (la URL vencida) sin ninguna necesidad.

Test nuevo (`message-bubble.test.tsx`): "código 4 ofrece reintentar Y
descargar" reemplaza al test viejo que afirmaba lo contrario ("no ofrece
reintentar"); el test del código 2 (red genérica) no cambia.

## Deuda y dudas

- El código real de `audio.error` en Chrome contra una URL vencida y un
  audio VÁLIDO no se confirmó en esta corrida (ni local, por falta de un
  archivo Ogg/Opus real y de `ffmpeg` para generar uno, ni en producción,
  sin acceso). Los pasos de arriba lo dejan listo para medir.
- H2 quedó con probabilidad baja pero no en cero; no se puede cerrar sin
  probar con una sesión de verdad vencida en producción.
- No se generó un archivo Ogg/Opus real para la prueba de Chrome: quien
  retome esto y tenga `ffmpeg` a mano (no está instalado en esta imagen,
  ver diagnóstico del 14/9/2026) puede repetir el experimento con un
  archivo válido para obtener el código real sin depender de producción.
- El archivo y el objeto de prueba subidos al bucket local
  (`whatsapp-media/diag/nota-voz-test.ogg`) se borraron al terminar; no
  queda ningún residuo en el stack local.
