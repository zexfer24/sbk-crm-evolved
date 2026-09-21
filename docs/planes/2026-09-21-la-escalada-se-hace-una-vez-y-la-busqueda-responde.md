# Plan "La escalada se hace una vez y la búsqueda responde", 21/9/2026

Origen: reporte del Claude del VPS tras desplegar `0af0b2c` (medido en
producción la primera hora y media). Base confirmada: `HEAD = origin/main =
0af0b2c`, 76 migraciones. APROBADO por el operador el 21/9/2026 con las
decisiones D1–D4 de abajo.

## Decisiones del operador

- **D1 (Frente 3):** tras escalar, el bucle NO se corta con `stopWhen`: el
  paso siguiente viaja con `toolChoice: "none"` para que Seba redacte su
  despedida y no pueda volver a llamar ninguna herramienta. `stopWhen` habría
  dejado siempre la despedida fija.
- **D2 (Frente 2):** con asesor asignado, `escalarAAsesor` se conserva SOLO
  para `intencion_compra` (actualiza `deal_status`); para todo lo demás se
  omite. Las dos redes de seguridad en código se saltan con asesor asignado.
- **D3 (Frente 1):** primero un `EXPLAIN (ANALYZE, BUFFERS)` como
  `authenticated` en producción (solo lectura). T3 bloqueada hasta tenerlo.
- **D4:** entran los frentes 1–4. El Frente 5 queda fuera: el clasificador
  chico ya se midió el 7/9/2026 (T2, NO APLICAR; ver trampa del comparador en
  CLAUDE.md).

## Hallazgos del contraste con el código (lo que el reporte no traía)

1. `search_conversations_by_message` es `security invoker`: desde la app
   corre como `authenticated`, con la política `is_agent()` de `messages`.
   `LIKE` no es leakproof, así que con RLS el planner no puede usarlo como
   condición del GIN trigram → recorrido completo + `is_agent()` por fila. El
   banco del VPS (142–339 ms) casi seguro corrió como superusuario.
   HIPÓTESIS hasta ver el plan.
2. Con asesor asignado, las redes de seguridad de `agent.ts` (devolución/queja
   y catálogo) también llaman a `escalateConversation` y dejan la nota "IA
   reiteró la escalada" aunque se quite la herramienta.
3. `maxOutputTokens` incluye el razonamiento si el modelo razona: un corte
   puede dejar `text` vacío. Ya lo cubren la despedida fija
   (`outcome.escalated && !text`) y `turno_sin_texto`; se fija con test.
4. `ai@7.0.68` acepta `maxOutputTokens` y trae un ajuste `reasoning` nativo en
   `ToolLoopAgent`.

## Tareas

Regla para todas: test ROJO primero, después el código; no commitear; reporte
obligatorio; comentarios en español con el porqué y la fecha.

### T1 — Frente 3: una escalada por turno y techo de salida
Archivos: `src/lib/ai/agent.ts`, `tools.ts`, `tool-choice.ts` + sus tests.
- `prepareStep`: si `outcome.escalated` ya es `true` → `{ toolChoice: "none" }`;
  si no, lo de siempre (`firstStepToolChoice`). La composición vive en
  `tool-choice.ts` como función pura con su test.
- `buildEscalateTool.execute`: si `outcome.escalated` ya es `true` en este
  turno, devolver el resultado anterior SIN llamar a `escalateConversation`
  (cubre dos llamadas en el mismo paso). Log `escalada_repetida_en_el_turno`.
- `maxOutputTokens: 1500` (constante con nombre y comentario con la medición:
  ninguna respuesta legítima pasó de 400; las espirales llegaron a 65.742).
- `resumen: z.string().max(600)`.
Tests: los 5 del reporte (adaptando 1–2 a D1: la segunda llamada no ejecuta
`escalateConversation`, y el paso posterior a escalar recibe `toolChoice:
"none"`), + texto vacío tras corte por largo con escalada → despedida fija.

### T2 — Frente 2: el modelo sabe que el chat ya tiene asesor (después de T1)
Archivos: `prompt.ts`, `agent.ts`, `tools.ts` + tests.
- `TurnContext.yaEscalada`; línea SOLO en el sufijo. Test: `cacheablePrefix()`
  idéntico byte a byte con y sin la línea.
- Con asesor: la herramienta se arma en modo restringido (enum de `motivo` =
  solo `intencion_compra`, descripción acorde) y se OMITE del todo si
  `deal_status` ya refleja la intención de compra (que no se reitere en cada
  mensaje). Sin asesor: todo igual que hoy.
- Las dos redes de seguridad se saltan con asesor asignado.
Tests: los 5 del reporte + modo restringido + redes saltadas.
`escalate.ts` y `escalate.test.ts` NO se tocan.

### T3 — Frente 1: la búsqueda (BLOQUEADA hasta el EXPLAIN, D3)
`[migración]` en commit aparte + `supabase/tests/search_conversations_by_message.sql`
(los 8 casos del reporte; el 8 corre como `authenticated`, o no prueba nada)
+ cableado al job `migraciones`. Dirección si el plan confirma la hipótesis:
`security definer` con `is_agent()` chequeado una vez, filtro positivo, los
DOS revokes + grant, `lock_timeout`/`notify pgrst` como las últimas.

### T4a — Frente 4: columna `agent_turns.reasoning_tokens` `[migración]`
Columna `integer not null default 0`, sin backfill. Commit aparte.

### T4b — Frente 4: medir el razonamiento (después de T2 y T4a)
`tokensFromUsage`/`addTokens`/`logTurn`, `database.types.ts`, contador en
Control IA. Verificar si Luna vía OpenRouter acepta el ajuste `reasoning`.
Tests: los 4 del reporte.

## Cierre
Suite completa + `tsc` + lint + `rtk proxy npm run build`; mutación manual
sobre T1 y T2 (respaldo con `cp`, nunca `git checkout --`); GLOSARIO y trampas
de CLAUDE.md; reporte de entrega por commit para el VPS (migraciones ANTES del
código). Criterios en producción: los del reporte del VPS.
