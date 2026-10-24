-- ============================================================================
-- Un turno que sale por "no hay mensaje nuevo" deja rastro (24/10/2026,
-- rama entrega/reconciliador-respeta-interruptor).
--
-- El caso real: la conversación 75e26065-0800-4427-92a1-cc8e68e9d5ba (1/10/2026,
-- IA encendida) recibió un texto, Seba respondió; otro texto, Seba respondió;
-- y 32 s después de la segunda respuesta, un STICKER. En ~3 horas el
-- reconciliador la reencoló 162 veces (`reabierto`) sin que ninguna dejara una
-- fila en `agent_turns` ni otro traspaso. Cada vuelta, el turno veía la marca
-- "visto hasta" de Redis (TTL 6 h) y calculaba sus mensajes pendientes con
-- `pendingCustomerCandidates`, que SALTA el sticker a propósito (un sticker no
-- es un pedido): no quedaba nada pendiente, el turno salía por
-- `turno_sin_mensaje_nuevo` (solo `resetStage`, sin traspaso) y la
-- conversación seguía cumpliendo el predicado del reconciliador (sticker =
-- `last_message_direction = 'inbound'` y `last_customer_message_at` movido).
-- La segunda puerta de la misma salida es la nota para el asesor: con la
-- escalada abierta y SIN asesor, la rama de espera deja una nota interna
-- (`sender_type = 'system'`, no cambia `last_message_direction`), marca "visto"
-- y sale; la pasada siguiente la reencola y el turno sale mudo por el mismo
-- sitio hasta que vence la marca (6 h).
--
-- Qué agrega: la razón `sin_mensaje_nuevo` al CHECK de
-- `conversation_handoffs.reason`. La escribe `runTurnPhases` (agent.ts) en esa
-- salida cuando el historial cargado termina en una línea del cliente; el
-- reconciliador la trata como "silencio decidido" (RAZONES_DE_SILENCIO_DECIDIDO,
-- handoffs.ts) y deja de reencolar la conversación hasta que el cliente escriba
-- algo posterior.
--
-- Por qué una razón NUEVA y no `sin_contenido_legible` (decisión del
-- operador, D2b): `sin_contenido_legible` NO está en
-- `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`, así que escribirla cerraría una
-- escalada abierta tanto para `escalationOpen` como para la demora del asesor
-- (`demora-cron.ts` filtra con esa misma lista): Seba dejaría de anotar los
-- pendientes para el asesor y la demora dejaría de ver la escalada.
-- `sin_mensaje_nuevo` se escribe SOBRE el mismo dueño, sin moverlo, y entra en
-- las dos listas de TypeScript.
--
-- El CHECK es una copia COMPLETA de los 32 valores vigentes (tomados de
-- 20260929020000, la última migración que lo tocó; verificado el 24/10/2026 con
-- `grep conversation_handoffs_reason_check supabase/migrations`) más la
-- razón nueva: sin la lista entera, `drop constraint` + `add constraint`
-- borraría en silencio cualquier razón omitida. El guardián
-- supabase/tests/seba_y_escalada_viva.sql pasa de 32 a 33 valores.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso, y el
-- `add constraint` pide ACCESS EXCLUSIVE sobre una tabla donde el webhook y el
-- turno insertan a cada mensaje.
--
-- No hay función `security definer` nueva (nada que revocar).
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): falla cerrado sin `psql -1`.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

alter table public.conversation_handoffs
  drop constraint conversation_handoffs_reason_check;

alter table public.conversation_handoffs
  add constraint conversation_handoffs_reason_check
  check (reason in (
    'agente_no_puede_correr',
    'conversacion_inexistente',
    'pausada',
    'asignada',
    'humano_intervino',
    'humano_se_adelanto',
    'fuera_de_ventana',
    'identidad_no_verificable',
    'lock_perdido',
    'abandonado',
    'entrega_fallida',
    'reabierto',
    'escalado_por_ia',
    'reclamado',
    'devuelto_a_ia',
    'cerrado',
    'ventana_vencida',
    'sla_vencido',
    'escalada',
    'escalada_sin_asesor',
    'rechazado_por_meta',
    'cerrada_por_asesor',
    'reabierta_por_asesor',
    'reabierta_por_cliente',
    'sin_contenido_legible',
    'cortesia_tras_escalada',
    'desasignada_por_asesor',
    'mensaje_previo_a_devolucion',
    'silenciada_por_asesor',
    'fuera_de_tema_repetido',
    'reasignada_por_demora',
    'demora_sin_asesor',
    -- 24/10/2026: el turno salió por "no hay mensaje nuevo" con el historial
    -- terminando en el cliente (sticker, o mensaje ya anotado para el
    -- asesor). Ver la cabecera.
    'sin_mensaje_nuevo'
  ));

comment on column public.conversation_handoffs.reason is
  'Por qué ocurrió el traspaso. Lista cerrada por CHECK (no enum, a propósito: ver 20260830040000). T2.1 (5/9/2026) sumó cerrada_por_asesor/reabierta_por_asesor/reabierta_por_cliente; "La IA ve lo que llega" (8/9/2026) sumó sin_contenido_legible; "La voz cercana y la espera visible" (14/9/2026) sumó cortesia_tras_escalada; "La IA no vuelve a pedir lo que ya pidió" (16/9/2026) sumó desasignada_por_asesor/mensaje_previo_a_devolucion; "Seba atiende el mostrador" (18/9/2026, T0) sumó silenciada_por_asesor; "El resguardo antes del push" (20/9/2026, C6) sumó fuera_de_tema_repetido; T10a de "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando" (29/9/2026) sumó reasignada_por_demora y demora_sin_asesor; el 24/10/2026 se suma sin_mensaje_nuevo (el turno no tenía nada nuevo que contestar y el historial termina en el cliente: un sticker o un mensaje ya anotado para el asesor; se escribe sobre el mismo dueño, entra en RAZONES_DE_SILENCIO_DECIDIDO y en RAZONES_QUE_NO_CIERRAN_LA_ESCALADA).';

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real (no leyendo este archivo).
-- ---------------------------------------------------------------------------
do $$
declare
  def_reason text;
  n_valores integer;
  v_faltan text;
  v_esperadas text[] := array[
    'agente_no_puede_correr','conversacion_inexistente','pausada','asignada','humano_intervino',
    'humano_se_adelanto','fuera_de_ventana','identidad_no_verificable','lock_perdido','abandonado',
    'entrega_fallida','reabierto','escalado_por_ia','reclamado','devuelto_a_ia','cerrado',
    'ventana_vencida','sla_vencido','escalada','escalada_sin_asesor','rechazado_por_meta',
    'cerrada_por_asesor','reabierta_por_asesor','reabierta_por_cliente','sin_contenido_legible',
    'cortesia_tras_escalada','desasignada_por_asesor','mensaje_previo_a_devolucion',
    'silenciada_por_asesor','fuera_de_tema_repetido',
    'reasignada_por_demora','demora_sin_asesor',
    'sin_mensaje_nuevo'
  ];
begin
  select pg_get_constraintdef(oid) into def_reason
    from pg_constraint
    where conrelid = 'public.conversation_handoffs'::regclass
      and conname = 'conversation_handoffs_reason_check';
  if def_reason is null then
    raise exception '20261024010000: conversation_handoffs_reason_check no existe';
  end if;

  select string_agg(e, ', ') into v_faltan
    from unnest(v_esperadas) as e
    where position('''' || e || '''::text' in def_reason) = 0;
  if v_faltan is not null then
    raise exception '20261024010000: conversation_handoffs_reason_check perdió razones: % (definición: %)', v_faltan, def_reason;
  end if;

  select count(*) into n_valores from regexp_matches(def_reason, '''([a-z_]+)''::text', 'g');
  if n_valores <> 33 then
    raise exception '20261024010000: conversation_handoffs_reason_check debía tener 33 razones, tiene % (definición: %)', n_valores, def_reason;
  end if;

  raise notice '20261024010000: autoverificación del CHECK de conversation_handoffs.reason (33 razones, incluida sin_mensaje_nuevo) correcta.';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado (hallazgo M1,
-- 19/9/2026).
notify pgrst, 'reload schema';
