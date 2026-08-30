-- ============================================================================
-- Bitácora de traspasos de conversación: conversation_handoffs
--
-- T1.1 del plan "Ningún lead invisible". Hoy quién atiende una conversación
-- (IA, un asesor, nadie, cerrada) cambia sin dejar rastro: `assigned_agent_id`
-- y las columnas de estado guardan el ÚLTIMO valor, no la HISTORIA de cómo se
-- llegó ahí. Si un lead queda huérfano —la IA no pudo correr, un humano se
-- adelantó, el lock se perdió, la ventana de 24h venció— hoy no hay forma de
-- reconstruir la cadena de eventos que lo dejó así; esta tabla es esa cadena.
-- Es solo bitácora: no reemplaza ninguna columna de estado existente, se
-- inserta una fila por cada traspaso y nunca se actualiza ni se borra.
--
-- Por qué `reason` es `text` + `check` y NO un tipo `enum`: las Etapas 2 y 3
-- de este plan van a agregar razones nuevas, y ampliar una lista de `check`
-- es una migración de una línea (`alter table ... drop constraint`, `add
-- constraint` con la lista nueva); ampliar un `enum` en Postgres es más
-- delicado (no se puede hacer dentro de la misma transacción que lo usa en
-- versiones viejas, y `alter type ... add value` tiene sus propias trampas
-- transaccionales). Se paga el precio de no tener el catálogo de valores
-- como tipo aparte a cambio de que crecer la lista sea trivial.
--
-- Por qué `agente_no_puede_correr` es UNA sola razón y no dos
-- ("ia_apagada" + "tope_de_gasto_alcanzado"): `agent_can_run()`
-- (20260822010000_ai_daily_spend_cap.sql:48) ya fusiona el interruptor
-- global y el tope de gasto diario en un único booleano — distinguir cuál de
-- los dos frenó a la IA exigiría una segunda consulta (leer
-- `agent_settings.ai_globally_enabled` aparte) en el camino caliente del
-- webhook de WhatsApp, justo donde el resto del código evita todo lo que no
-- sea indispensable. Decisión del operador (30/8/2026): una razón única, sin
-- migración extra; si algún día hace falta distinguir, se separa entonces.
-- ============================================================================

create table public.conversation_handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  from_kind text,
  from_id uuid,
  to_kind text not null
    check (to_kind in ('ai', 'human', 'unassigned', 'closed')),
  to_id uuid,
  reason text not null
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
      'sla_vencido'
    )),
  created_by text not null default 'system'
    check (created_by in ('system', 'user')),
  created_at timestamptz not null default now()
);

comment on table public.conversation_handoffs is
  'Bitácora de a quién (IA/humano/nadie/cerrada) pasó a atender cada conversación y por qué. Solo se inserta, nunca se actualiza ni se borra: es el rastro que impide que un lead desaparezca sin explicación. Parte de T1.1 del plan "Ningún lead invisible".';
comment on column public.conversation_handoffs.from_kind is
  'Quién atendía antes del traspaso: ai/human/unassigned/closed, o null si se desconoce el origen (p. ej. el primer registro de una conversación nueva).';
comment on column public.conversation_handoffs.from_id is
  'id del agente humano que atendía antes, si from_kind = human. Null en cualquier otro caso.';
comment on column public.conversation_handoffs.to_kind is
  'Quién queda atendiendo después del traspaso.';
comment on column public.conversation_handoffs.to_id is
  'id del agente humano que queda atendiendo, si to_kind = human. Null en cualquier otro caso.';
comment on column public.conversation_handoffs.reason is
  'Por qué ocurrió el traspaso. Lista cerrada por CHECK (no enum, a propósito: crece en las Etapas 2 y 3 del plan y ampliar un CHECK es una migración trivial). agente_no_puede_correr fusiona a propósito "IA apagada" y "tope de gasto alcanzado" porque agent_can_run() ya las fusiona en un solo booleano — separarlas costaría una segunda consulta en el camino caliente del webhook.';
comment on column public.conversation_handoffs.created_by is
  'Quién generó la fila: system (webhook, cron, triggers) o user (una acción de un asesor/supervisor en el panel).';

create index conversation_handoffs_conversation_id_created_at_idx
  on public.conversation_handoffs (conversation_id, created_at desc);
create index conversation_handoffs_to_kind_created_at_idx
  on public.conversation_handoffs (to_kind, created_at desc);

comment on index public.conversation_handoffs_conversation_id_created_at_idx is
  'La consulta natural de la bitácora: la historia completa de una conversación, más reciente primero.';
comment on index public.conversation_handoffs_to_kind_created_at_idx is
  'Para responder "qué quedó unassigned/closed recientemente" sin recorrer toda la bitácora.';

-- ---------------------------------------------------------------------------
-- RLS — cualquier agente autenticado LEE la bitácora completa (mismo
-- criterio que el resto del CRM: compartido, no multi-tenant). La ESCRITURA
-- directa queda cerrada a todo el mundo salvo service_role: nadie hace
-- INSERT a mano desde el navegador, y en la Etapa 1 los cuatro llamadores
-- (turno, cola, webhook, reconciliador) corren con createAdminClient(). Los
-- que sí correrán como `authenticated` son los botones de la Etapa 2
-- (reclamar, cerrar, devolver a IA): esa migración les abrirá
-- record_handoff() cuando existan. Ver CLAUDE.md: "código de servidor" no es
-- sinónimo de service_role, lo decide el cliente Supabase que se usó.
-- ---------------------------------------------------------------------------
alter table public.conversation_handoffs enable row level security;

create policy "conversation_handoffs_select" on public.conversation_handoffs
  for select using (public.is_agent());

grant select on public.conversation_handoffs to authenticated, service_role;
grant insert on public.conversation_handoffs to service_role;

-- ---------------------------------------------------------------------------
-- record_handoff() — la única puerta de escritura para código `authenticated`
--
-- `language sql` porque es un insert directo sin lógica condicional: nada
-- que plpgsql resuelva mejor acá. Los CHECK de la tabla son los que validan
-- to_kind/reason/created_by; la función no duplica esa validación.
-- ---------------------------------------------------------------------------
create function public.record_handoff(
  p_conversation_id uuid,
  p_to_kind text,
  p_reason text,
  p_from_kind text default null,
  p_from_id uuid default null,
  p_to_id uuid default null,
  p_created_by text default 'system'
)
returns uuid
language sql
security definer set search_path = public
as $$
  insert into public.conversation_handoffs
    (conversation_id, from_kind, from_id, to_kind, to_id, reason, created_by)
  values
    (p_conversation_id, p_from_kind, p_from_id, p_to_kind, p_to_id, p_reason, p_created_by)
  returning id;
$$;

comment on function public.record_handoff is
  'Inserta una fila en conversation_handoffs. security definer, concedida HOY solo a service_role: en la Etapa 1 los cuatro llamadores (turno, cola, webhook, reconciliador) corren con createAdminClient(). Los botones de la Etapa 2 (reclamar, cerrar, devolver a IA) sí correrán como authenticated, y esa migración les dará el grant entonces, no antes: security definer significa que quien la ejecuta se salta la RLS de la tabla, así que un grant de más es capacidad de fabricar traspasos falsos.';

-- El privilegio llega por dos vías independientes (el EXECUTE de fábrica de
-- Postgres a PUBLIC, y el `alter default privileges` de Supabase a
-- anon/authenticated) y ninguno de los dos revokes alcanza solo — ver
-- CLAUDE.md y 20260830010000_security_definer_revoke_roles.sql. Los dos
-- revokes van primero, el grant después: el revoke de PUBLIC también le
-- saca el acceso a authenticated si lo tenía solo por ahí, así que hay que
-- devolvérselo explícito.
revoke execute on function public.record_handoff(uuid, text, text, text, uuid, uuid, text) from public;
revoke execute on function public.record_handoff(uuid, text, text, text, uuid, uuid, text) from anon, authenticated;
grant  execute on function public.record_handoff(uuid, text, text, text, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- unassigned_waiting_count() — el KPI de la reforma, bien medido
--
-- "Cuántas conversaciones siguen esperando y quedaron sin dueño" parece una
-- consulta trivial y no lo es: la respuesta correcta es "aquellas cuya
-- ÚLTIMA fila de bitácora es unassigned", y eso PostgREST no lo sabe decir.
-- Lo más parecido que se puede escribir desde el cliente —"tiene al menos
-- una fila unassigned"— da un número inflado, y no por poco: el
-- reconciliador vuelve a encolar lo que quedó huérfano y escribe un
-- `reabierto` (to_kind = 'ai') encima, así que TODA conversación recuperada
-- seguiría contando como perdida para siempre. Medido el 30/8/2026 contra
-- esta misma base: dos handoffs unassigned + un reabierto posterior, y el
-- conteo por embed seguía devolviendo 1 en vez de 0.
--
-- Importa que sea exacto porque este número es el que decide si la Etapa 2
-- del plan arranca o si la reforma se revisa: un KPI que solo sabe subir no
-- sirve para tomar esa decisión.
--
-- `security invoker` (el default): NO se salta la RLS. Llamada por
-- service_role desde /api/health devuelve el total; si algún día la llama
-- una sesión de asesor, ve lo que su RLS le permita ver. No hace falta el
-- ritual de los dos revokes que sí exigen las `security definer`, pero se
-- cierra igual por higiene: nadie sin sesión tiene por qué contar leads.
-- ---------------------------------------------------------------------------
create function public.unassigned_waiting_count()
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
  from public.conversations c
  where c.awaiting_reply
    and (
      select h.to_kind
      from public.conversation_handoffs h
      where h.conversation_id = c.id
      order by h.created_at desc, h.id desc
      limit 1
    ) = 'unassigned';
$$;

comment on function public.unassigned_waiting_count is
  'Conversaciones que siguen esperando respuesta y cuya ÚLTIMA fila en conversation_handoffs las dejó sin dueño. El KPI de la reforma "ningún lead invisible" (Etapa 1). El desempate por id en el order by es para que dos traspasos con el mismo created_at no den un resultado que cambie entre consultas.';

revoke execute on function public.unassigned_waiting_count() from public;
revoke execute on function public.unassigned_waiting_count() from anon, authenticated;
grant  execute on function public.unassigned_waiting_count() to service_role;

notify pgrst, 'reload schema';
