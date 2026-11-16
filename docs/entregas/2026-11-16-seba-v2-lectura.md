# Entrega 1 del rework de Seba: «Seba lee fotos y audios» (16/11/2026)

Rama `entrega/seba-v2-lectura`, partida de `main` = `371a8ca`. **Lleva una migración**
(`20261116010000_lecturas_de_media.sql`) y **tres variables de entorno opcionales**. `main` no se tocó:
el VPS aplica la migración y después avanza `main`.

Es el bloque M (M1 a M6) de los briefs del VPS. La entrega 0 (T0, el build) ya estaba en `main`
(`371a8ca`, `entrega/fuentes-locales`), así que no se creó `entrega/build-fuente-local`.

## Antes de desplegar

1. **Confirmar con el operador en qué commit está producción** y listar el rango:
   `git diff --name-only <produccion>..entrega/seba-v2-lectura -- supabase/migrations`. Si producción
   todavía no tiene los paneles, sus cuatro migraciones (`20261113…`) y el relleno van antes
   (`docs/entregas/2026-11-15-paneles.md`).
2. **La migración va ANTES que el código, sin excepción.** La consulta de mensajes del chat y el
   historial del turno embeben `message_readings`: con el código nuevo y sin la tabla, PostgREST
   responde 400, el chat no carga mensajes y el turno falla (queda `turno_historial_no_consultable`).
   Se aplica con `psql -1 -v ON_ERROR_STOP=1`; es idempotente y termina con `notify pgrst`.
3. La migración redefine `agent_spend_today()`: desde que se aplica, el tope de gasto diario cuenta
   también las lecturas. No cambia `agent_can_run()` ni sus permisos.
4. **Privacidad (D-M2):** las fotos y los audios de los clientes salen hacia OpenRouter. El código no
   manda `provider.data_collection = "deny"` porque el SDK no permite campos extra en el cuerpo. Se
   configura en la privacidad de la cuenta de OpenRouter.

## Commits

| # | Título | ¿Migración? | ¿Variable de entorno? | ¿UI o servidor? |
|---|---|---|---|---|
| 1 | `[migración]` Cada audio e imagen entrante tiene dónde guardar su lectura, y el tope de gasto diario la cuenta | **Sí:** `20261116010000_lecturas_de_media.sql` | No | Base |
| 2 | Seba ya puede transcribir un audio y leer una imagen, con un filtro para lo que Whisper inventa | No | `AI_TRANSCRIBE_MODEL`, `AI_VISION_MODEL`, `AI_MEDIA_READING` (opcionales) | Servidor |
| 3 | El webhook lee cada audio e imagen del cliente al guardarlo, y deja escrito cuando no pudo | No | No | Servidor |
| 4 | Seba lee la nota de voz y la foto en su historial, y un comprobante pasa a un asesor sin que ella lo valide | No | No | Servidor |
| 5 | El asesor ve la transcripción y la lectura bajo cada audio e imagen del cliente, y aparecen en vivo | No | No | UI |
| 6 | Las correcciones de la revisión de código | No | No | Servidor y UI |
| 7 | El glosario, CLAUDE.md, la guía de producción y este reporte | No | No | Documentos |
| 8 | Una lectura larga se puede abrir completa con «Ver más» | No | No | UI |

Costo de despliegue: **rebuild completo (~5 min)**, porque toca la UI.

## Variables nuevas (todas opcionales)

| Variable | Default | Para qué |
|---|---|---|
| `AI_TRANSCRIBE_MODEL` | `openai/whisper-1` | Modelo de transcripción. `openai/gpt-4o-transcribe` queda como cambio de `.env` |
| `AI_VISION_MODEL` | `openai/gpt-5.4` | Modelo que lee imágenes. Su costo sale de la fila de `model_pricing` con esa clave exacta |
| `AI_MEDIA_READING` | encendida | `off` apaga la lectura entera (interruptor de emergencia) |

## Qué cambia

- **Tabla `message_readings`:** una fila por audio o imagen del cliente, con estado (`pendiente`,
  `ok`, `vacio`, `alucinacion`, `fallo`), texto leído, campos de la imagen y costo. La leen los
  agentes; la escribe solo el webhook. Está en Realtime.
- **El webhook** escribe la fila `pendiente` al subir el adjunto y después la lectura. Si la descarga
  falla, queda `fallo/descarga`. Corre aunque la IA esté apagada (D-M1); la cortan el tope de gasto y
  `AI_MEDIA_READING=off`. Video, documento y sticker quedan como estaban.
- **Seba** ve `[Nota de voz del cliente, transcrita: "…"]` y `[Foto del cliente: …]` en su historial.
  El turno espera la lectura hasta 8 s. Lo leído se guarda en `agent_turns.customer_message` (P12).
- **Comprobante de pago u orden de Cashea:** el turno escala en código, sin modelo, con el motivo
  `comprobante_pago` y el texto fijo «Recibido 🙌 Pásame la cédula del titular de la compra (y la
  talla, si es casco o ropa) y un asesor la verifica.». La nota al asesor lleva monto, banco, fecha y
  los últimos 6 dígitos de la referencia, y avisa si la orden quedó con retiro en tienda. Esos datos
  no viajan al modelo. Seba nunca confirma el pago (D3).
- **Adjuntos ilegibles:** como hoy, Seba pide una vez que lo escriban y a la segunda escala; el
  motivo pasa de `seguimiento` a `no_pudo_leer`.
- **Panel:** bajo cada audio e imagen del cliente sale la transcripción o la lectura, con la pastilla
  «Posible comprobante» o «Posible orden de Cashea» y lo leído de la captura.

## Desvíos respecto de los briefs

| Brief | Qué decía | Qué se hizo y por qué |
|---|---|---|
| T0 | Rama `entrega/build-fuente-local` | No se creó: el arreglo ya está en `main` (`371a8ca`) |
| M1 | `20261025010000_lecturas_de_media.sql`; tipos en `src/lib/database.types.ts` | `20261116010000…` (posterior a los paneles); los tipos viven en `src/lib/supabase/database.types.ts`. Índice extra por `created_at` y el corte de «hoy» como rango, porque `agent_spend_today()` corre en cada `agent_can_run()`. Paso nuevo en `ci.yml` |
| M2 | `maxOutputTokens: 400`; `provider.data_collection` si el SDK deja | 700, porque M6 agranda el objeto. `data_collection` no se manda: el SDK no tiene cómo |
| M2 | `getVisionModel()` con `build()` y fase `vision` | Va sin el middleware de telemetría: la fase es un tipo cerrado con CHECK en `agent_turn_calls` |
| M3 | Tres tests del webhook en espejo | Son cuatro (`agent-off.test.ts`). Un tope de gasto que no se puede consultar deja `fallo/tope_no_consultable` (falla cerrado). Un audio o imagen sin tarea de descarga deja `fallo/descarga` |
| M4 | `esperarLecturas(admin, conv, desdeMessageId, …)` | Sin `desdeMessageId`: los pendientes se calculan después de leer el historial. Mira los audios e imágenes entrantes de los últimos 10 min; ignora `pendiente` de más de 2 min |
| M4 | `lastCustomerMessage` y `customerBurst` devuelven la lectura | También `pendingCustomerLines`, que es la ráfaga que usan las guardas del turno |
| M4 | Lectura fallida → camino de `DESPEDIDA_MEDIA` | Se conserva «pregunta una vez, a la segunda escala» (casos F8 y A3); cambia solo el motivo a `no_pudo_leer` |
| M4 | Regla del prompt en voseo | En tuteo, como el resto del prompt. `MEDIA_RULES` aclara que «pide que lo escriba» vale solo para lo que no se pudo leer |
| M4 | — | Con un comprobante en la ráfaga, Seba no manda su presentación (caso A4) |
| M5 | Lectura embebida y realtime | La lectura en vivo se aplica en el sitio; un refresco de mensajes no pisa una lectura resuelta. «Leyendo…» se apaga a los 2 min si la lectura quedó huérfana. El panel muestra además lo leído del comprobante |
| M6 | `[Foto del cliente: … · texto visible: "…"]` en el prompt de v2 | La línea de v1 es `[Foto del cliente: <descripción>. Texto visible: "…"]` (literal de M4). Hay que alinear el prompt de v2 en la entrega 3 |

## Qué se verificó

- **Suite completa:** 318 archivos y 6.920 tests en verde (1 archivo saltado, 1 `todo`), con
  `--exclude ".claude/**"` porque hay un worktree ajeno dentro del repo. Ojo: `queue.test.ts` y
  `redis-queue.test.ts` se saltan enteros sin Redis, y Docker estaba en pausa al cierre. Esta entrega
  no toca la cola.
- **Tipos:** `tsc --noEmit` sin errores. **Lint** de `src`: 0 errores, 8 advertencias de parámetros
  sin usar en fakes de tests que ya existían.
- **Build en frío** (`.next` borrada): `npm run build` termina bien y deja un `BUILD_ID` nuevo.
- **Test SQL** `supabase/tests/lecturas_de_media.sql`: 9 casos en verde contra la base local, con la
  migración aplicada dos veces (es idempotente). `permisos_funciones.sql` y
  `permisos-funciones.test.ts` siguen en verde: el conteo de funciones `security definer` no cambia.
- **Mutaciones** (cada una puso en rojo su test y se restauró desde una copia):
  - quitar la suma de lecturas de `agent_spend_today()`;
  - quitar el `contiene "amara org"` del filtro de Whisper;
  - que `getVisionModel()` respete `AI_AGENT_REASONING=off`;
  - quitar la comprobación del tope de gasto, y el `if (lecturaKind)` del webhook;
  - invertir la condición del comprobante, y quitar la exclusión del turno por demora;
  - quitar la condición de «solo mensajes del cliente» en el panel, y el vencimiento de «Leyendo…»;
  - quitar el `throw` de `loadHistory`, la condición que evita el saludo, y el corte por reloj de la espera.
- **`security-review`:** sin vulnerabilidades de alta confianza. Revisó la RLS y los permisos de la
  tabla, la publicación en Realtime, el ACL de `agent_spend_today()`, los logs (nunca llevan lo
  leído) y los datos que salen al proveedor.
- **`code-review` en nivel high:** 10 hallazgos; 7 corregidos en el commit 6 y 3 anotados abajo.

- **Revisión en el navegador** (`next dev` contra la base local, con siete mensajes de prueba y sus
  lecturas sembradas por SQL, borrados al terminar):
  - los estados: audio leído, «Leyendo…», audio fallido (no muestra nada), foto de repuesto con
    texto visible, comprobante con su pastilla y lo leído, y una galería con «Foto 1» y «Foto 2»;
  - modo oscuro y claro a 1440 px, con captura; la pastilla se distingue en los dos;
  - a 390 px las lecturas caben en la burbuja y nada desborda (medido en el DOM: la captura a ese
    ancho no salió porque la ventana estaba oculta);
  - **en vivo:** una lectura pasada por SQL de `fallo` a `pendiente` y a `ok` cambió la burbuja a
    «Leyendo…» y después a la transcripción, sin recargar, sin volver a pedir mensajes y sin errores
    en la consola. Eso prueba la RLS de lectura y la publicación en Realtime contra Supabase real;
  - una transcripción larga se cortaba a 6 líneas con el texto completo solo en el tooltip: se
    agregó «Ver más» (commit 8) y se comprobó que abre y cierra.

El CI no corre sobre ramas `entrega/`: el job de migraciones corre cuando `main` avance.

## Lo que no se pudo verificar acá

- **La lectura real contra OpenRouter.** Los tests simulan `fetch` y el modelo. Falta comprobar en
  producción que `openai/gpt-5.4` acepta la salida estructurada con este esquema y cuánto tarda.
- **La calidad de las lecturas** (30 transcripciones y 30 descripciones a mano) y el porcentaje real
  de `alucinacion`, `fallo` y falsos comprobantes.
- **El costo por día.** La estimación del brief (US$0,85) era con 165 imágenes; hoy son 236. Conviene
  mirar `sum(cost_usd)` de los primeros días contra el tope de gasto: las lecturas y los turnos de
  Seba comparten ese tope.

## Qué medir después del deploy (lo hace el VPS)

- Que cada audio o imagen nuevo tenga su fila en `message_readings`.
- El p50 de `duration_ms`, el costo por día y el porcentaje de `alucinacion` y de `fallo` por `error`.
- Que en el chat aparezca la lectura sin recargar.

## Observaciones fuera de alcance

- El inner join de `agent_spend_today()` con `model_pricing` hace que un turno cuyo modelo no tiene
  tarifa no sume al gasto, sin aviso. No se tocó (queda para S1).
- `agent_spend_today()` la puede ejecutar cualquier `authenticated`, también el rol `caja`. Es
  anterior a esta entrega y devuelve solo un total en dólares.
- El canal Realtime del carrito (`cart-<id>`) sigue sin `nombreCanalUnico`.
- Las lecturas comparten el freno de ritmo con los turnos; `esperarLecturas` hace una consulta en
  cada turno, también en los de solo texto.
