# Entrega "Nada se pierde en un corte ni en un deploy", 22/9/2026

Para el Claude del VPS. Responde a tu informe de producción del 21/9/2026
(cierre 23:27 UTC, tras desplegar `83bc558`, base en `20260921030000`) — los
tres problemas que mediste ese día (búsqueda, reescaladas, espirales) ya
quedaron cerrados por la corrida anterior ("La escalada se hace una vez y la
búsqueda responde", entrega en
`docs/entregas/2026-09-21-la-escalada-se-hace-una-vez-y-la-busqueda-responde.md`).
Esta entrega es la siguiente: cortes app↔PostgREST sin diagnóstico, el 500
opaco al bajar una imagen, instrumentación que faltaba
(`maxOutputTokens`/`toolChoice` sin prueba directa, tokens por fase
inferidos, `agent_token_usage` sin razonamiento), el caché "cacheando cero"
en la mitad de los turnos, y que cada deploy destruye los logs.

**Base de esta entrega: producción = `83bc558` con 78 migraciones**, tal
como lo confirmó tu propio informe del 21/9 (23:27 UTC). El rango a
desplegar es `83bc558..HEAD` (7 commits, UNA migración: 78→79). Igual,
antes de aplicar nada, confirmá con `git -C <checkout> rev-parse HEAD` y
`select count(*) from supabase_migrations.schema_migrations` que nada se
movió desde entonces — si producción ya no está en `83bc558`, avisá antes de
seguir.

El plan completo, con las decisiones D1-D4 del operador y las seis
objeciones que tu revisión del 21/9/2026 incorporó, está en
`docs/planes/2026-09-21-nada-se-pierde-en-un-corte-ni-en-un-deploy.md`. El
orden operativo paso a paso, con los criterios de verificación, está en
`docs/PRODUCCION.md` §12 — este documento da el detalle por commit, esa
sección da la secuencia completa.

## Lo que cambió respecto a tu informe/objeciones (leé esto primero)

1. **El 500 de la imagen NO se arregla en la app.** Tu revisión ya lo había
   detectado (objeción 3): Storage registró la subida y la firma en 200, y
   Envoy no vio NINGUNA petición de `facebookexternalua` a esa hora. La
   petición de Meta murió ANTES de Envoy, en Traefik o el borde TLS, y
   Traefik no tenía access log. Esta entrega instrumenta `/api/media` y
   `media-link.ts` (T7) por su propio motivo — un 401/403/404/500 real de
   un ASESOR mirando una foto o un sticker no dejaba ninguna línea — pero
   el arreglo del incidente real es tuyo: activar el access log de Traefik
   (ver §12, paso 6, y CLAUDE.md, trampa nueva). Recordá también el
   hallazgo 1 del plan: Meta nunca pasa por `/api/media/…`, descarga
   siempre de una URL firmada de Supabase Storage.
2. **`agent_turn_calls` nace con RLS SIN ninguna política, como pediste
   (objeción 1).** No hay ninguna policy `using (is_agent())` sobre esta
   tabla — crece 3-7 filas por turno (1.100-2.500/día medidas el 21/9/2026,
   más que `messages` hoy) y una policy evaluada por fila ahí sería
   exactamente lo que tumbó la búsqueda de `/inbox` 48 h. Se lee SOLO por
   `agent_turn_calls_by_phase()`/se purga SOLO por `agent_turn_calls_purge()`,
   las dos `security definer` con `is_agent()`/`service_role` chequeado UNA
   vez al entrar. `agent_token_usage()` se recreó con el mismo criterio
   (era `security invoker`, pagaba `is_agent()` por fila vía
   `agent_turns_all` — mismo agujero que `search_conversations_by_message`
   corrigió el 21/9, corregido ahora de una vez).
3. **El compose de Dokploy no se edita a mano (objeción 2).** T8 solo suma
   `logging: driver: journald` al servicio `app` en el archivo del repo —
   no hay ningún paso de fusión: Dokploy regenera el YAML completo en cada
   deploy, inyectando los labels de Traefik desde su panel. Ver
   `docs/PRODUCCION.md` §7 → "En Dokploy" (sección nueva) para la
   verificación del primer deploy con este cambio.
4. **T1 reintenta SOLO idempotentes o lo que PRUEBA que la petición nunca
   llegó al upstream (objeción 4).** Un `POST` con `ECONNRESET`/`ETIMEDOUT`/
   "fetch failed" ambiguo NO se reintenta — PostgREST pudo haber ejecutado
   el INSERT y perderse solo la respuesta; reintentarlo duplicaría la fila,
   y una fila duplicada en `agent_turns` infla `agent_spend_today()` (la
   suma con la que `agent_can_run()` apaga a Seba por tope de gasto). Ese
   caso queda como hoy: `log.error("base_agotada")`, el llamador ve el
   error tal cual.
5. **T6 no promete arreglar el caché (nota A).** El bloque estático del
   prompt de escenarios ronda ~830 tokens con 14 escenarios activos, por
   debajo del mínimo de ~1.024 del caché de OpenAI — mover el reloj al
   final es correcto y barato, pero T4 (la tabla "Por fase" de Control IA)
   es lo que dice, con datos, si de verdad alcanza a cachear.
6. **T2 suma el test de la reentrega (objeción B)**: un lote reentregado
   donde un mensaje cae en `23505` y otro se guarda por primera vez encola
   UNA sola conversación, la del mensaje nuevo — ya era así por
   construcción, el test lo fija.

**Hallazgo nuevo, no estaba en el plan original: Kong vs Envoy.** El
clasificador de fallos transitorios (`esFalloTransitorioDeBase`,
`errores-base.ts`) no se queda en `err.code` — también mira `err.message`,
porque `postgrest-js` convierte un 503 con cuerpo NO-JSON o sin `code` en
`PostgrestError { code: "", message: <cuerpo> }`. Verificado en local con
PostgREST parado: Kong (el proxy de esta máquina de desarrollo) respondió
`503 {"message":"name resolution failed"}`, y sin mirar `message` ese 503 se
leía como un fallo cualquiera — sin reintento, sin `persistenciaFallida`, el
webhook respondía 200 con el mensaje del cliente perdido. En producción el
proxy delante de PostgREST es Envoy (el stack `supabase-squad`), no Kong,
así que la clasificación cubre los DOS: los patrones de Envoy
(`upstream connect error`, `disconnect/reset before headers`, `connection
termination`) y los de Kong (`name resolution failed`, `failure to get a
peer from the ring-balancer`, `invalid response was received from the
upstream`). El cuerpo real que tu instancia sirve es el de Envoy — esto no
cambia nada de lo que ya sabías de producción, solo hace que el código no
dependa de asumir cuál proxy hay delante.

## Orden de despliegue

Ver `docs/PRODUCCION.md` §12 para el detalle completo (con los comandos
exactos y la verificación de cada paso). Resumen:

1. Confirmar el commit real de producción y recontar migraciones contra ESE
   commit, no contra el HEAD local.
2. Respaldo (`scripts/backup.sh`).
3. Migración `20260921040000_telemetria_del_turno.sql` **ANTES** que el
   código:
   ```bash
   docker exec -i supabase-db env PGOPTIONS="-c lock_timeout=5s" psql -U postgres -d postgres \
     -1 -v ON_ERROR_STOP=1 \
     < supabase/migrations/20260921040000_telemetria_del_turno.sql
   ```
   Esperá el `NOTICE` de autoverificación antes de seguir. Registrarla en
   `supabase_migrations.schema_migrations`: el conteo pasa de 78 a 79.
4. Push / redeploy.
5. Verificar dominio + labels de Traefik (primer deploy con `journald`).
6. Activar el access log de Traefik (objeción 3, ver arriba y §12 paso 6) —
   independiente del código, es configuración de tu Traefik.

## Verificación en producción (24-48 h después)

Todos los SQL y conteos exactos están en `docs/PRODUCCION.md` §12. Resumen:

- Tokens por fase sobre `agent_turn_calls` (`group by phase`): `escenario`
  deja de cachear cero, `redactar` trae `max_output_tokens = 1500` en todas.
- `tool_choice = 'none'` en la SEGUNDA fila `redactar` de un turno que
  escaló (7.4 de tu informe del 21/9, probado en dato).
- Conteos de `webhook_mensaje_no_guardado`/`webhook_canal_no_consultable`/
  `base_reintento`/`base_agotada` — un `base_reintento` sin `base_agotada`
  inmediato después es el reintento funcionando; `webhook_error_actualizar_estado`
  debería bajar frente a `base_reintento` (los cortes cortos ya no llegan a
  ese llamador).
- `telemetria_purgada` una vez al día, nunca dos.
- Tras el SIGUIENTE deploy (no este): `journalctl CONTAINER_TAG=sbk-crm-app
  --since "1 day"` sigue mostrando turnos del contenedor anterior.
- El 500 de la imagen, si se repite: buscarlo en el access log de Traefik
  por `facebookexternalua`, no en la app.

## Límites conocidos

- **La rama "colisión al crear conversación pero no se encontró ninguna al
  releer"** (`webhook_colision_conversacion_no_resuelta`) no levanta
  `persistenciaFallida` — es un caso de carrera entre dos webhooks
  concurrentes, no un corte de la base; el mensaje de ESE intento se pierde
  igual que antes (el otro webhook ya lo guardó, así que no hay pérdida
  real, pero el evento no distingue los dos casos).
- **El panel "Por fase" de Control IA es client-side, no SSR.** `page.tsx`
  no se tocó — sigue trayendo el resto del panel en su `Promise.all`
  inicial; `turnCallsByPhase` se carga en un `useEffect` de montaje y en
  cada `refresh()`, con `readListIfTableExists` degradándolo a `[]` si la
  migración todavía no corrió. Un primer render sin datos ahí es esperado,
  no un bug.
- **`AI_AGENT_REASONING=off` vs `none`**: `off` sigue sin apagar nada (el
  proveedor razona con su default — 58,5 % de la salida medida el 21/9 con
  `off` puesto); `none` es el apagado real. Esta entrega NO cambia la
  variable en producción — sigue en `off`. Pasar a `none` es una decisión
  del operador, después de mirar `agent_turn_calls.reasoning_tokens` por
  fase durante unos días.

## Pendientes del operador que siguen (sin tocar en esta corrida)

- Cargar los catálogos a mano desde el panel (decisión del 21/9/2026,
  "Los catálogos se cargan a mano desde el panel").
- La lección (`ai_lessons`) del catálogo/inventario, si el operador decide
  sumar alguna tras ver el panel en producción.
- Encender `buscar_repuesto` cuando el operador lo decida, con asesores
  mirando la bandeja (ver `docs/PRODUCCION.md` §11, "Al encender la
  consulta de productos").
- Rotar la clave de OpenRouter (expuesta el 18/9/2026 — sigue pendiente).
- Nivel Cashea (pendiente de otra corrida, sin relación con esta).

## Commits

Rango `83bc558..HEAD`, siete commits, en este orden (la migración va sola y
primera; T4 y T5 salieron juntos porque tocan los mismos archivos):

1. `aaea86f` — [migración] Cada llamada de la IA al proveedor queda medida
   en la base y las lecturas del panel dejan de pagar la RLS por fila
2. `34a54a7` — El cliente admin reintenta un corte corto de la base y el
   webhook le pide a Meta que reentregue lo que no pudo guardar
3. `e3d959d` — El turno guarda sus tiempos, sus pasos y cada llamada al
   proveedor, el razonamiento se puede apagar de verdad y Control IA muestra
   caché, razonamiento y el reparto por fase
4. `0f0c3b8` — El prompt de escenarios deja el reloj al final para que su
   prefijo pueda cachear
5. `fa9f1f3` — api/media y el enlace que se le manda a Meta dejan rastro
   cuando fallan
6. `5a464e3` — Los logs del contenedor sobreviven al deploy
7. (este commit) — El plan, las trampas y la entrega de "Nada se pierde en
   un corte ni en un deploy" quedan escritos para el VPS (GLOSARIO,
   CLAUDE.md, PRODUCCION.md §12, plan y esta entrega)
