# Entrega "La escalada se hace una vez y la búsqueda responde", 21/9/2026

Para el Claude del VPS. Responde a tu plan de arreglos del 21/9/2026 (los
cinco frentes medidos tras desplegar `0af0b2c`). Base: producción en
`0af0b2c`, 76 migraciones. Rama `la-escalada-se-hace-una-vez`, SIN push al
escribir esto: el operador avisa cuándo sale.

## Lo que cambió respecto a tu plan (leé esto primero)

1. **Frente 1: la causa es RLS, no la doble negación, y SÍ hay migración.**
   Tu banco (142–339 ms) corrió como superusuario, que salta RLS. La función
   es `security invoker`: desde la app corre como `authenticated` y la
   política `messages_all using (is_agent())` se evalúa POR FILA dentro de un
   `Seq Scan`. Reproducido en local con 115.000 mensajes sembrados: 75 ms
   como superusuario contra **1.468 ms como `authenticated`** (234.613
   buffers contra 4.706); el plan muestra `Filter: … AND is_agent()`. La
   doble negación es cierta (el trigram no se usa ni como superusuario) pero
   no es lo que mata la consulta. **No hace falta tocar `auto_explain`.**
2. **Frente 3: no se usó `stopWhen`** (decisión del operador). Cortar el
   bucle al escalar dejaba siempre la despedida fija; en su lugar, todo paso
   posterior a una escalada viaja con `toolChoice: "none"`: Seba redacta y no
   puede llamar ninguna herramienta.
3. **Frente 2: la herramienta no se omite siempre** (decisión del operador):
   con asesor asignado queda restringida a `motivo: "intencion_compra"` y se
   omite del todo si `deal_status` ya es `in_progress`. Consecuencia para tu
   criterio de terminado: puede quedar ALGUNA nota "IA reiteró la escalada"
   cuando un cliente de un chat asignado confirma que quiere comprar — como
   mucho una por conversación. Todo lo demás debe dar cero.
4. **Frente 5 queda fuera.** El clasificador chico ya se midió el 7/9/2026
   y se decidió no aplicarlo (el comparador no tiene referencia fija: el
   modelo grande coincide consigo mismo solo 92,5 %).

## Antes de aplicar: confirmación de solo lectura (2 minutos)

```sql
select id from public.agents limit 1;   -- <AGENTE>
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<AGENTE>","role":"authenticated"}';
set local statement_timeout = '60s';
explain (analyze, buffers)
select * from public.search_conversations_by_message('caucho trasero', 40);
rollback;
```

Esperado ANTES de la migración: segundos, cientos de miles de buffers. Si da
milisegundos como `authenticated`, PARÁ y avisá: la hipótesis no aplica a
producción y la migración `20260921030000` no es el arreglo.

## Orden de despliegue

Migraciones ANTES del código, en orden, cada una con
`PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 -f <archivo>` (las
dos traen la guarda que aborta sin transacción y su autoverificación):

1. `20260921020000_agent_turns_reasoning_tokens.sql`
2. `20260921030000_busqueda_de_mensajes_sin_rls_por_fila.sql`

Quedan 78 registradas. La segunda arregla la búsqueda EN CALIENTE, sin
esperar al código: la firma de la RPC no cambia. Repetí el `EXPLAIN` de
arriba después: esperado < 200 ms.

## Por commit

### `31a5a98` — [migración] Cada turno de la IA guarda cuántos tokens gastó razonando
1. Migración: **sí**, `20260921020000_agent_turns_reasoning_tokens.sql`
   (`agent_turns.reasoning_tokens integer not null default 0`; default
   constante, no reescribe la tabla; `notify pgrst`).
2. Variables de entorno: ninguna.
3. UI/servidor: solo base.
4. Verificado: aplicada en local con `psql -1`, test SQL
   `agent_turns_reasoning_tokens.sql` rojo sin la columna y verde con ella.
   Ninguna función ni vista hace `select *` de `agent_turns`.

### `aec99cb` — [migración] La búsqueda de la bandeja deja de pagar la política de RLS por cada mensaje
1. Migración: **sí**, `20260921030000_busqueda_de_mensajes_sin_rls_por_fila.sql`.
   `create or replace` (mismo nombre, misma firma, mismas columnas):
   `plpgsql security definer`, `is_agent()` UNA vez, `search_text like all
   (pats)`. Los dos revokes por firma + `grant` a `authenticated,
   service_role`. Semántica intacta (AND entre términos, sin acentos,
   excluye `system_event`, una fila por conversación, `p_limit <= 0` → 0;
   `%` y `_` siguen siendo comodín, igual que antes).
2. Variables: ninguna.
3. UI/servidor: solo base. El cliente TypeScript no cambia.
4. Verificado en local (~100.000 mensajes, como `authenticated`): vieja
   996–1.225 ms → nueva 29–111 ms. Test SQL de 10 casos: el de rendimiento
   (umbral 500 ms, medido con `clock_timestamp()`) ROJO con la vieja y verde
   con la nueva; mutación del orquestador (quitar el chequeo `is_agent()`)
   rompe el caso 9 (un `authenticated` que no es agente ve filas).
   `has_function_privilege`: anon=f, authenticated=t, `prosecdef`=t.
   **Sin verificar:** el plan real de producción (el `EXPLAIN` de arriba) y
   `supabase db reset` desde cero — eso lo corre el CI.

### `1b3f48e` — Seba escala una sola vez…
1. Migración: no (usa la columna de `31a5a98`: **aplicala antes** o el
   insert de `agent_turns` falla y `turno_bitacora_no_escrita` aparece en
   cada turno).
2. Variables: ninguna nueva. `AI_AGENT_REASONING` NO se tocó (ver abajo).
3. UI: **sí** (badge "Razonamiento: N" en el feed de Control IA) → rebuild
   completo.
4. Verificado: suite completa 2.761 verde (1 archivo saltado: los de Redis,
   sin Redis en esta máquina; no se tocó la cola), `tsc`, lint 0 errores,
   `rtk proxy npm run build` con `BUILD_ID` fresco. Mutaciones manuales
   sobre T1 (3) y T2 (5): todas rompen su test. **Sin verificar:** que
   `gpt-5.6-luna` vía OpenRouter respete `toolChoice: "none"` y
   `maxOutputTokens` (los tests usan un modelo simulado) — es lo primero a
   mirar en producción.

### commit de documentos (el último de la rama)
Plan, trampas nuevas de CLAUDE.md y este reporte. Sin código.

## Qué mirar después del deploy

- **Búsqueda:** 10 búsquedas desde `/inbox` dan 200; `max_exec_time` de la
  consulta en `pg_stat_statements` < 2.000 ms (conviene
  `pg_stat_statements_reset()` de esa consulta para no arrastrar el máximo
  viejo).
- **Reescalada:** en una hora, notas `IA reiteró la escalada` ≈ 0 (ver punto
  3 de arriba); log `escalarAAsesor_omitida_venta_en_curso` aparece en chats
  asignados con venta en curso.
- **Espiral:** cero turnos con `redaccionMs > 60000` y cero
  `escalarAAsesor,escalarAAsesor` en `herramientas`. Si aparece
  `escalada_repetida_en_el_turno` en el log, el freno en código actuó (el
  modelo lo intentó igual dentro del mismo paso).
- **Techo de salida:** si `turno_sin_texto` o la despedida fija suben de
  golpe, el techo de 1.500 está cortando razonamiento legítimo: reportá
  `output_tokens` y `reasoning_tokens` de esos turnos antes de tocar nada.
- **Razonamiento (Frente 4):** tras un día,
  `select count(*) filter (where reasoning_tokens > 0), max(reasoning_tokens),
  sum(reasoning_tokens)::numeric / nullif(sum(output_tokens),0) from
  agent_turns where created_at > now() - interval '1 day';`
  Si todo da 0, OpenRouter no separa el razonamiento en `usage` y la
  hipótesis sigue sin poder medirse por esta vía.

## Pendiente, a propósito

- Apagar el razonamiento de verdad (`reasoning: "none"`): `AI_AGENT_REASONING=off`
  hoy no manda nada y queda el default del proveedor. No se activó: primero
  medir con la columna nueva; después probar si OpenRouter lo honra.
- `agent_token_usage` (panel "Consumo de tokens") no trae `reasoning_tokens`:
  sería otra migración.
- Contadores por fase (tu Frente 5, "antes de optimizar, instrumentar"): otra
  tanda.
