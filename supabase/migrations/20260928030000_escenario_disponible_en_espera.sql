-- ============================================================================
-- Tarea T5 · plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
-- esperando" (28/9/2026, decisión D7).
--
-- Contexto: con una escalada ABIERTA, Seba ya no corre el tool loop (T5 de
-- "Seba no habla de más", 23/9/2026): solo puede volver a hablarle al cliente
-- si un escenario INFORMATIVO calza, y si nada calza deja una nota para el
-- asesor. Hasta hoy "informativo" era "cualquier escenario que no sea
-- despedida ni escale", así que un cliente esperando al asesor podía recibir
-- de vuelta el catálogo de cascos o las redes -- respuestas que no son
-- urgentes de mandar y que el asesor suele afinar. La regla nueva es un
-- permiso EXPLÍCITO por escenario: `disponible_en_espera`. Nace en `false`
-- (ningún escenario cambia de comportamiento el día del deploy salvo los tres
-- que esta migración marca) y el supervisor la enciende desde el panel.
--
-- Backfill (D7): solo Ubicación, Envio gratis Cashea y Postventa Cashea --
-- datos que el cliente pregunta esperando y que no dependen de nadie:
-- dónde queda la tienda, si el envío con Cashea es gratis y quién atiende la
-- postventa. NO se marcan catálogos ni redes: un catálogo se manda cuando el
-- cliente lo pide, no mientras espera. La coincidencia es por NOMBRE, sin
-- distinguir acentos, mayúsculas ni espacios de los bordes
-- (`immutable_unaccent(lower(btrim(name)))`, 20260822100000), porque los
-- nombres los escribió el supervisor a mano ("Envio" sin tilde) y el
-- ambiente de destino puede traerlos distinto. Si falta alguno no se aborta:
-- `raise notice` cuenta cuántas filas cambiaron y el operador lo revisa
-- contra el panel. Es idempotente (`add column if not exists`, y el UPDATE
-- solo toca filas que aún no están marcadas); en producción corre una sola
-- vez.
--
-- RLS: no cambia. `ai_playbooks_select`/`ai_playbooks_write` (20260821010000)
-- cubren la tabla entera y `ai_playbooks` ya está en `supabase_realtime`
-- (misma migración): una columna nueva viaja por ambos sin declarar nada.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que 20260921010000: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso y el
-- `alter table ... add column` sobre `ai_playbooks` (que el turno lee en cada
-- fase 0) correría sin tope de espera.
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

alter table public.ai_playbooks
  add column if not exists disponible_en_espera boolean not null default false;

comment on column public.ai_playbooks.disponible_en_espera is
  'Permiso para que este escenario salga mientras el cliente espera a un asesor con la escalada abierta (T5, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando", 28/9/2026, D7). Sin marcarlo, el escenario NO sale en la espera: el turno deja una nota interna para el asesor. Además de esta marca, el turno exige que no sea una despedida, que no escale al mandarse y que no se haya mandado ya (misma regla de no repetir de la fase 0, ventana de 6 h). Nace en false; el backfill marca por nombre solo Ubicación, Envio gratis Cashea y Postventa Cashea -- no catálogos ni redes.';

-- ---------------------------------------------------------------------------
-- Backfill por nombre (D7), sin abortar si falta alguno.
-- ---------------------------------------------------------------------------
do $$
declare
  marcadas integer;
begin
  update public.ai_playbooks
     set disponible_en_espera = true
   where public.immutable_unaccent(lower(btrim(name))) in (
           'ubicacion',
           'envio gratis cashea',
           'postventa cashea'
         )
     and not disponible_en_espera;
  get diagnostics marcadas = row_count;

  raise notice '20260928030000: % escenario(s) marcados como disponibles en la espera (se esperaban hasta 3: Ubicación, Envio gratis Cashea, Postventa Cashea; una cifra menor significa que falta alguno por ese nombre).', marcadas;
end $$;

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real (information_schema).
-- ---------------------------------------------------------------------------
do $$
declare
  col_exists boolean;
  col_nullable text;
  col_default text;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_playbooks'
      and column_name = 'disponible_en_espera'
  ) into col_exists;

  if not col_exists then
    raise exception '20260928030000: public.ai_playbooks.disponible_en_espera no quedó creada';
  end if;

  select is_nullable, column_default into col_nullable, col_default
    from information_schema.columns
    where table_schema = 'public' and table_name = 'ai_playbooks'
      and column_name = 'disponible_en_espera';

  if col_nullable is distinct from 'NO' then
    raise exception '20260928030000: ai_playbooks.disponible_en_espera debía quedar NOT NULL, encontró is_nullable = %', col_nullable;
  end if;

  if col_default is distinct from 'false' then
    raise exception '20260928030000: ai_playbooks.disponible_en_espera debía tener DEFAULT false, encontró column_default = %', col_default;
  end if;

  raise notice '20260928030000: autoverificación de ai_playbooks.disponible_en_espera (columna not null, default false) correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la columna nueva
-- da 400 hasta que alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
