-- ============================================================================
-- Límite de tasa por ventana deslizante
--
-- Vive en Postgres y no en memoria del proceso a propósito: un contador en
-- memoria no sirve cuando la app corre en más de una instancia, que es lo
-- normal apenas se despliega detrás de un balanceador.
--
-- El primer consumidor es el webhook de WhatsApp. Con la firma de Meta ya
-- exigida, esto no frena a un atacante anónimo —no llega tan lejos— sino una
-- avalancha legítima: una campaña, un reenvío masivo o un bucle de reintentos
-- de Meta que dispararía un turno de IA por mensaje.
-- ============================================================================

create table public.rate_limit_hits (
  bucket text not null,
  hit_at timestamptz not null default now()
);

comment on table public.rate_limit_hits is
  'Marcas de tiempo por clave para el límite de tasa. Las filas viejas las borra la propia función al consultar.';

create index rate_limit_hits_bucket_time_idx on public.rate_limit_hits (bucket, hit_at desc);

-- ---------------------------------------------------------------------------
-- Registra un golpe y dice si se pasó del límite en la ventana.
-- Devuelve true si SE PUEDE seguir, false si hay que frenar.
-- ---------------------------------------------------------------------------
create function public.rate_limit_allow(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  hits integer;
begin
  -- Poda: sin esto la tabla crece sin fin. Se limpia la clave consultada.
  delete from public.rate_limit_hits
  where bucket = p_bucket
    and hit_at < now() - make_interval(secs => p_window_seconds);

  select count(*) into hits
  from public.rate_limit_hits
  where bucket = p_bucket;

  if hits >= p_limit then
    return false;
  end if;

  insert into public.rate_limit_hits (bucket) values (p_bucket);
  return true;
end;
$$;

comment on function public.rate_limit_allow is
  'true si la clave todavía tiene cupo en la ventana; false si hay que frenar. Registra el golpe cuando devuelve true.';

alter table public.rate_limit_hits enable row level security;

-- Nadie la lee desde el cliente: solo la función security definer y el
-- service_role del webhook la tocan.
grant select, insert, delete on public.rate_limit_hits to service_role;
grant execute on function public.rate_limit_allow(text, integer, integer) to service_role;
