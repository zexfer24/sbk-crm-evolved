-- ============================================================================
-- Tope de gasto diario de la IA
--
-- El panel ya calcula cuánto cuesta el agente, pero nada lo detenía: una
-- ráfaga de mensajes —legítima o no— gasta cuota del modelo sin límite, y
-- eso solo se descubre en la factura.
--
-- El tope se evalúa contra el gasto del día en curso (hora de Caracas, que
-- es el día que ve el equipo en el panel) y frena el agente sin apagar el
-- interruptor global: cuando cambia el día vuelve solo, sin que nadie tenga
-- que acordarse de reactivarlo.
-- ============================================================================

alter table public.agent_settings
  add column daily_spend_cap_usd numeric(10, 2);

comment on column public.agent_settings.daily_spend_cap_usd is
  'Gasto máximo del agente por día en USD. Null = sin tope. Al superarlo la IA deja de responder hasta el día siguiente.';

-- ---------------------------------------------------------------------------
-- Gasto de hoy, cruzando los turnos con la tarifa de su modelo. Mismo
-- criterio de día que el resto del CRM: America/Caracas.
-- ---------------------------------------------------------------------------
create function public.agent_spend_today()
returns numeric
language sql
stable
security definer set search_path = public
as $$
  select coalesce(sum(
    (coalesce(t.input_tokens, 0) / 1000000.0) * p.input_price_per_million
    + (coalesce(t.output_tokens, 0) / 1000000.0) * p.output_price_per_million
  ), 0)::numeric
  from public.agent_turns t
  join public.model_pricing p on p.model = t.model
  where (t.created_at at time zone 'America/Caracas')::date
        = (now() at time zone 'America/Caracas')::date;
$$;

comment on function public.agent_spend_today is
  'Gasto en USD del agente en el día en curso (hora de Caracas). Los turnos cuyo modelo no tenga tarifa cargada no suman.';

-- ---------------------------------------------------------------------------
-- ¿Puede correr la IA ahora mismo? Une el interruptor global y el tope.
-- Vive en la base y no en la app para que la respuesta sea la misma sin
-- importar quién pregunte.
-- ---------------------------------------------------------------------------
create function public.agent_can_run()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select s.ai_globally_enabled
     and (s.daily_spend_cap_usd is null or public.agent_spend_today() < s.daily_spend_cap_usd)
  from public.agent_settings s
  where s.id;
$$;

comment on function public.agent_can_run is
  'false si la IA está apagada globalmente o si ya se alcanzó el tope de gasto del día.';

grant execute on function public.agent_spend_today() to authenticated, service_role;
grant execute on function public.agent_can_run() to authenticated, service_role;
