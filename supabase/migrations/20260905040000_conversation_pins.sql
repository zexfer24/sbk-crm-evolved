-- ============================================================================
-- Pines de conversación: hasta tres chats fijados por asesor
--
-- T2.2 del plan "La bandeja que no pierde" (5/9/2026). Cada asesor puede
-- fijar hasta tres conversaciones para que no se le pierdan en el fondo de la
-- lista mientras trabaja otras más urgentes; `applyInboxFilters`
-- (`src/lib/inbox-filters.ts`) las pone primero, respetando el orden interno
-- (el criterio de la píldora activa) de la lista.
--
-- Por qué (agent_id, conversation_id) como llave primaria y no un id propio:
-- "fijado" es un hecho binario por par agente/conversación -- no hace falta
-- historial ni updates, solo existe o no existe. Con la llave compuesta, un
-- segundo intento de fijar lo mismo es un simple conflicto de llave (el
-- cliente puede resolverlo con `on conflict do nothing`), sin necesitar un
-- índice único aparte.
--
-- Por qué el tope de tres vive en un TRIGGER y no en un CHECK: un CHECK de
-- fila no puede contar cuántas filas ya existen para el mismo agente -- eso
-- exige mirar la tabla entera, que es exactamente lo que hace un trigger
-- BEFORE INSERT.
-- ============================================================================

create table public.conversation_pins (
  agent_id uuid not null references public.agents (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (agent_id, conversation_id)
);

comment on table public.conversation_pins is
  'Hasta tres conversaciones fijadas por asesor (T2.2, plan "La bandeja que no pierde", 5/9/2026). Cada agente lee y escribe solo las suyas (RLS); el tope de tres lo impone el trigger conversation_pins_limit_before_insert -- un CHECK no puede contar filas ya existentes.';
comment on column public.conversation_pins.created_at is
  'Cuándo se fijó. applyInboxFilters (src/lib/inbox-filters.ts) no lo usa para ordenar entre pines: el grupo de fijados va primero completo, respetando entre ellos el mismo orden interno que ya traía la lista (más reciente/más viejo), no el orden en que se fijaron.';

create index conversation_pins_conversation_id_idx
  on public.conversation_pins (conversation_id);
comment on index public.conversation_pins_conversation_id_idx is
  'Soporta el on delete cascade al borrar la conversación, y una eventual consulta "quién tiene esto fijado".';

-- ---------------------------------------------------------------------------
-- RLS -- cada agente lee y escribe SOLO sus propios pines. A diferencia de
-- conversation_handoffs (bitácora compartida, lectura de todo el equipo) esto
-- es personal: que Ana tenga fijado un chat no le importa a Beto, y Beto no
-- puede fijar nada a nombre de Ana. Mismo patrón que el resto de políticas
-- `for all` del esquema (`is_agent()`, ver 20260819000001_initial_schema.sql);
-- `agent_id = auth.uid()` es lo que además exige ser EL dueño de la fila, no
-- solo un agente cualquiera.
-- ---------------------------------------------------------------------------
alter table public.conversation_pins enable row level security;

create policy "conversation_pins_own" on public.conversation_pins
  for all
  using (public.is_agent() and agent_id = auth.uid())
  with check (public.is_agent() and agent_id = auth.uid());

grant select, insert, delete on public.conversation_pins to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- El tope de tres. `security invoker` (el default, sin esa cláusula) a
-- propósito: quien inserta ya puede leer sus propios pines por la política de
-- arriba, así que la función no necesita saltarse RLS para contar los que ya
-- tiene -- decisión del orquestador, ver CLAUDE.md ("código de servidor no es
-- sinónimo de service_role": acá el razonamiento es el mismo al revés, no
-- todo lo que valida una fila necesita ser definer).
--
-- Si alguien intentara insertar un pin a nombre de OTRO agente (agent_id
-- distinto de auth.uid()), este trigger -- corriendo con los privilegios de
-- quien llama -- cuenta CERO filas ajenas (su propio SELECT ya está filtrado
-- por la misma RLS que protege la tabla) y dejaría pasar la cuenta con
-- pines_actuales en 0; pero el `with check` de la política de arriba rechaza
-- la fila igual, porque agent_id sigue sin ser auth.uid(). El trigger nunca
-- es la única barrera contra ese caso -- lo verificó pins.sql.
--
-- `language plpgsql` porque hace falta la rama condicional (`if ... then
-- raise`); record_handoff() pudo ser `language sql` por ser un insert directo
-- sin lógica, esto no.
-- ---------------------------------------------------------------------------
create function public.enforce_conversation_pins_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  pines_actuales integer;
begin
  select count(*) into pines_actuales
  from public.conversation_pins
  where agent_id = new.agent_id;

  if pines_actuales >= 3 then
    raise exception 'Ya tenés tres conversaciones fijadas. Desfijá una para poder fijar esta.';
  end if;

  return new;
end;
$$;

comment on function public.enforce_conversation_pins_limit is
  'Rechaza el cuarto pin de un mismo agente. BEFORE INSERT en conversation_pins. security invoker a propósito -- ver el comentario junto a la función.';

-- Dos revokes por higiene, aunque esta función NO es security definer y
-- PostgREST nunca la expone como RPC (returns trigger, igual que
-- handle_new_message() y las demás del Grupo 3 de
-- 20260830010000_security_definer_revoke_roles.sql): el EXECUTE de fábrica a
-- PUBLIC que Postgres concede a toda función nueva no depende de si es
-- definer o invoker, y 20260830020000 solo cambió el default de
-- anon/authenticated -- sin este revoke, esos dos roles lo seguirían
-- heredando de PUBLIC igual que antes de esa migración. No lleva grant:
-- Postgres ejecuta funciones de trigger sin comprobar EXECUTE del rol que
-- dispara la operación.
revoke execute on function public.enforce_conversation_pins_limit() from public;
revoke execute on function public.enforce_conversation_pins_limit() from anon, authenticated;

create trigger conversation_pins_limit_before_insert
  before insert on public.conversation_pins
  for each row execute function public.enforce_conversation_pins_limit();

notify pgrst, 'reload schema';
