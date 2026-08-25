-- ============================================================================
-- El interruptor de un agente solo lo saca del reparto de la IA.
--
-- `is_active` terminó significando dos cosas a la vez: "la IA no le pasa
-- chats" (lo que el interruptor de Control de agentes siempre quiso decir) y
-- "no existe para RLS" (porque is_agent(), del esquema inicial, exigía
-- is_active). Lo segundo es lo que rompía todo al apagar a alguien: RLS le
-- negaba hasta su propia fila de `agents`, fetchCurrentAgent daba null, y el
-- usuario quedaba rebotando entre / y /login sin cargar ninguna página.
--
-- is_agent() vuelve a preguntar lo único que debe: "¿este auth.uid() es un
-- agente registrado?". Apagado o no, sigue entrando al CRM y trabajando; el
-- único efecto del interruptor es que claimNextAvailableAgent (que filtra
-- is_active = true) no le asigna conversaciones. Sacar a alguien del equipo
-- de verdad es borrar/banear su cuenta en auth, no este interruptor.
-- ============================================================================

create or replace function public.is_agent()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (select 1 from public.agents where id = auth.uid());
$$;

-- Con el significado nuevo, apagarse a sí mismo es legítimo (un supervisor
-- que no quiere recibir chats de la IA) y ya no deja a nadie fuera: el
-- candado de 20260825030000 sobra.
drop trigger if exists no_self_deactivation on public.agents;
drop function if exists public.prevent_self_deactivation();
