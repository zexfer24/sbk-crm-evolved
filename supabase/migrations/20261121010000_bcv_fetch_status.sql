-- ============================================================================
-- Estado persistente de la lectura de la tasa BCV (21/11/2026).
--
-- Por qué existe: el 19/11/2026 el BCV renovó el certificado de bcv.org.ve
-- (lo firma Sectigo OV R36, una cadena que el contenedor no traía) y desde
-- ese día CADA lectura falló. Nadie se enteró en dos días: el único aviso era
-- un console.error del servidor, y la tasa de la bandeja siguió mostrando la
-- última buena sin decir que estaba vieja. Las tasas del 20/11 y del 24/11 se
-- cargaron a mano. Esta tabla deja el estado de la lectura en una fila
-- persistente (sobrevive reinicios del proceso, a diferencia de la ventana de
-- fallos en memoria de `bcv-fetch.ts`) para que la interfaz lo muestre y se
-- pueda alertar.
--
-- Quién escribe: SOLO el servidor, con el cliente service_role, llamando a
-- `bcv_registrar_intento`. Quién lee: los asesores y la caja, con el mismo
-- criterio que `exchange_rates` desde rol_caja (20261013010000):
-- `can_read_inventory()`.
--
-- El código que usa esta tabla se despliega ANTES que esta migración y ya
-- tolera que no exista.
-- ============================================================================

create table public.bcv_fetch_status (
  id boolean primary key default true
    constraint bcv_fetch_status_una_fila check (id),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0
    constraint bcv_fetch_status_fallos_no_negativos check (consecutive_failures >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.bcv_fetch_status is
  'Una sola fila (id = true): estado de la última lectura de la tasa BCV. La escribe solo el servidor por bcv_registrar_intento (21/11/2026).';
comment on column public.bcv_fetch_status.last_attempt_at is
  'Último intento de lectura, bueno o malo.';
comment on column public.bcv_fetch_status.last_success_at is
  'Última lectura buena de bcv.org.ve. Las tasas cargadas a mano NO la mueven.';
comment on column public.bcv_fetch_status.last_failure_at is
  'Último intento que falló.';
comment on column public.bcv_fetch_status.last_error is
  'Texto del último fallo (máx. 1000 caracteres). Se conserva tras un éxito como histórico.';
comment on column public.bcv_fetch_status.consecutive_failures is
  'Fallos seguidos desde la última lectura buena; vuelve a 0 con un éxito.';

alter table public.bcv_fetch_status enable row level security;

-- Una tabla nueva en `public` recibe ALL para anon/authenticated/service_role
-- por el `alter default privileges` de Supabase: se revoca todo explícito y se
-- da solo lo necesario.
revoke all on table public.bcv_fetch_status from public, anon, authenticated, service_role;
grant select on table public.bcv_fetch_status to authenticated;
grant select, insert, update on table public.bcv_fetch_status to service_role;

create policy bcv_fetch_status_select on public.bcv_fetch_status
  for select to authenticated
  using (public.can_read_inventory());

-- Backfill: una sola fila con la última lectura buena conocida. Así, si al
-- migrar la lectura sigue rota, la alerta de "más de 8 h sin lectura buena"
-- sale al instante en vez de esperar a que pasen 8 h desde hoy. Las filas
-- `manual (bcv.org.ve)` NO cuentan como lectura buena a propósito (el filtro
-- es source = 'bcv.org.ve' exacto). Sin filas, queda la fila con nulls.
insert into public.bcv_fetch_status (id, last_attempt_at, last_success_at)
select true, max(fetched_at), max(fetched_at)
  from public.exchange_rates
 where source = 'bcv.org.ve'
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- bcv_registrar_intento: registra un intento y devuelve el contador nuevo y el
-- previo (con su error), para que el llamador decida si avisa de una
-- transición (empezó a fallar / se recuperó).
--
-- `security invoker` a propósito: la única llamada llega con service_role, que
-- ya salta la RLS, así que no hay política por fila que ahorrar (el único
-- motivo por el que otras funciones son definer). El incremento va en SQL y
-- bajo `for update` porque el cron y la bandeja pueden registrar a la vez: un
-- leer-y-escribir desde TypeScript se pisaría.
-- ---------------------------------------------------------------------------
create function public.bcv_registrar_intento(p_ok boolean, p_error text default null)
returns table (consecutive_failures integer, previous_failures integer, previous_error text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_prev_failures integer;
  v_prev_error text;
  v_nuevo integer;
begin
  insert into public.bcv_fetch_status (id) values (true) on conflict (id) do nothing;

  select s.consecutive_failures, s.last_error
    into v_prev_failures, v_prev_error
    from public.bcv_fetch_status s
   where s.id
     for update;

  if p_ok then
    update public.bcv_fetch_status s
       set last_attempt_at = now(),
           last_success_at = now(),
           consecutive_failures = 0,
           updated_at = now()
     where s.id
    returning s.consecutive_failures into v_nuevo;
  else
    update public.bcv_fetch_status s
       set last_attempt_at = now(),
           last_failure_at = now(),
           last_error = left(coalesce(p_error, 'sin detalle'), 1000),
           consecutive_failures = s.consecutive_failures + 1,
           updated_at = now()
     where s.id
    returning s.consecutive_failures into v_nuevo;
  end if;

  return query select v_nuevo, v_prev_failures, v_prev_error;
end;
$$;

comment on function public.bcv_registrar_intento(boolean, text) is
  'Registra un intento de lectura de la tasa BCV (bueno o malo) en bcv_fetch_status, de forma atómica, y devuelve (contador nuevo, contador previo, error previo). Solo service_role (21/11/2026).';

-- Los DOS revokes (PUBLIC y anon/authenticated) y el grant a quien sí la usa.
revoke execute on function public.bcv_registrar_intento(boolean, text) from public;
revoke execute on function public.bcv_registrar_intento(boolean, text) from anon, authenticated;
grant execute on function public.bcv_registrar_intento(boolean, text) to service_role;

notify pgrst, 'reload schema';
