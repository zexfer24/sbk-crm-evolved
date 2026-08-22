-- ============================================================================
-- La política "agents_update_self" solo dejaba a cada agente editar su propia
-- fila. La cartilla de "Control de agentes" necesita que un supervisor o
-- admin pueda prender/apagar la disponibilidad de CUALQUIER agente para el
-- reparto automático de la IA — sin esto, el toggle fallaba en silencio
-- (RLS bloqueaba el update) para cualquier agente que no fuera uno mismo.
-- ============================================================================

create function public.is_supervisor_or_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.agents
    where id = auth.uid() and role in ('supervisor', 'admin')
  );
$$;

create policy "agents_update_by_supervisor" on public.agents
  for update
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());
