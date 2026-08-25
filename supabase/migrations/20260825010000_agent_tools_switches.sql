-- ============================================================================
-- Interruptores por herramienta del agente de IA
--
-- Hasta ahora el único interruptor era el global (agent_settings): o la IA
-- entera o nada. Esta tabla deja apagar UNA herramienta sin tumbar el resto
-- — hoy mismo hace falta: se pidió deshabilitar la consulta de productos
-- mientras se revisa el catálogo, sin que la IA deje de atender.
--
-- La tabla la siembran las migraciones, no el panel: una herramienta existe
-- porque hay código que la implementa, así que crear filas desde la UI solo
-- produciría interruptores que no apagan nada. Por eso el cliente puede
-- SELECT y UPDATE, pero no INSERT ni DELETE.
--
-- Escalar a un asesor NO está acá a propósito: es la única vía por la que
-- una conversación llega a un humano (y la única que toca dinero real).
-- Apagable, un descuido dejaría devoluciones, quejas y ventas sin salida.
-- ============================================================================

create table public.agent_tools (
  key text primary key,
  name text not null,
  description text not null,
  is_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.agents (id) on delete set null
);

comment on table public.agent_tools is
  'Interruptor por herramienta del agente de IA. Las filas las siembran las migraciones: una herramienta existe porque hay código que la implementa.';
comment on column public.agent_tools.key is
  'Identificador que mira el código al armar el turno (ver src/lib/ai/agent-tools.ts). No se renombra: es el contrato entre la base y el código.';
comment on column public.agent_tools.is_enabled is
  'false = la IA corre sus turnos sin esta herramienta. No apaga la IA: solo le quita esta capacidad.';

create trigger set_agent_tools_updated_at before update on public.agent_tools
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Las tres herramientas apagables que existen hoy. La consulta de productos
-- nace APAGADA: es el pedido que motivó esta tabla.
-- ---------------------------------------------------------------------------
insert into public.agent_tools (key, name, description, is_enabled) values
  (
    'buscar_repuesto',
    'Consulta de productos',
    'Busca repuestos en el catálogo y cotiza precio (USD y Bs a tasa BCV) y stock. Apagada, la IA no afirma existencia ni precio de ningún repuesto y ofrece pasar el caso a un asesor.',
    false
  ),
  (
    'buscar_historial_compras',
    'Historial de compras',
    'Lee qué compró el cliente, cuándo y cuánto pagó, para armar contexto en devoluciones sin hacerle repetir todo. Solo lectura: no aprueba ni procesa nada.',
    true
  ),
  (
    'consultar_biblioteca',
    'Biblioteca de conocimiento',
    'Lee la información oficial que el equipo carga en la biblioteca (envíos, pagos, garantías, horarios…). Apagada, la IA no responde preguntas sobre la tienda que no sean del catálogo.',
    true
  );

-- ---------------------------------------------------------------------------
-- RLS — mismo criterio que agent_settings: cualquier asesor ve el estado,
-- solo supervisor/admin lo cambia. Sin políticas de insert/delete: las filas
-- solo entran y salen por migración.
-- ---------------------------------------------------------------------------
alter table public.agent_tools enable row level security;

create policy "agent_tools_select" on public.agent_tools
  for select using (public.is_agent());

create policy "agent_tools_update" on public.agent_tools
  for update using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

grant select, update on public.agent_tools to authenticated;
grant select, insert, update, delete on public.agent_tools to service_role;

-- El panel muestra los interruptores en vivo.
alter publication supabase_realtime add table public.agent_tools;
