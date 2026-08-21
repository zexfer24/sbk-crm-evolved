-- ============================================================================
-- La UI ya ocultaba ciertos botones para el rol "agent" (ej. "Marcar
-- revisada" en Control de IA), pero la base de datos dejaba pasar la misma
-- operación igual si se llamaba la API REST directo con el JWT de cualquier
-- asesor -- el control era puramente cosmético. Esta migración lo respalda
-- a nivel de RLS para las acciones sensibles identificadas en la auditoría
-- de producción:
--
--   1. Ventas: cerrar una venta nueva sigue abierto a cualquier asesor (es
--      su trabajo del día a día), pero VERIFICAR el comprobante, REVERTIR
--      (marcar devuelta) o ELIMINAR el registro de una venta ya cerrada
--      queda solo para supervisor/admin.
--   2. Tarifas de modelo (model_pricing) y el interruptor global de la IA
--      (agent_settings): lectura abierta a cualquier asesor, escritura
--      solo supervisor/admin.
--   3. Sugerencias al supervisor (agent_suggestions): cualquier asesor
--      puede crear las suyas, pero solo supervisor/admin puede editar
--      cualquiera (marcarla como revisada).
--   4. Notas internas (notes): cualquier asesor puede crear notas y ver
--      todas, pero solo el autor de la nota o un supervisor/admin puede
--      editarla o borrarla -- exactamente la regla que ya vive hoy en
--      context-panel.tsx del lado del cliente, ahora respaldada en la base.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Ventas: trigger que distingue la transición, no una política genérica
--    (conversations tiene muchas otras columnas -- asignación, pausa de IA,
--    etapa del recorrido -- que deben seguir abiertas a cualquier asesor).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_sale_role_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Verificar el comprobante de pago: solo supervisor/admin.
  if new.deal_verified is distinct from old.deal_verified and new.deal_verified then
    if not public.is_supervisor_or_admin() then
      raise exception 'Solo un supervisor o admin puede verificar una venta.';
    end if;
  end if;

  -- Revertir a "devuelta" o eliminar el registro (volver a 'none' desde un
  -- estado ya cerrado): solo supervisor/admin. Cerrar una venta nueva
  -- (transición hacia 'won' desde 'none'/'in_progress') no entra acá.
  if new.deal_status is distinct from old.deal_status
     and new.deal_status in ('returned', 'none')
     and old.deal_status <> 'none' then
    if not public.is_supervisor_or_admin() then
      raise exception 'Solo un supervisor o admin puede revertir o eliminar el registro de una venta.';
    end if;
  end if;

  return new;
end;
$$;

create trigger enforce_sale_role_guard
  before update on public.conversations
  for each row
  execute function public.enforce_sale_role_guard();

-- ---------------------------------------------------------------------------
-- 2. model_pricing y agent_settings: lectura abierta, escritura restringida.
-- ---------------------------------------------------------------------------
drop policy "model_pricing_all" on public.model_pricing;
create policy "model_pricing_select" on public.model_pricing for select using (public.is_agent());
create policy "model_pricing_write" on public.model_pricing for insert with check (public.is_supervisor_or_admin());
create policy "model_pricing_update" on public.model_pricing for update
  using (public.is_supervisor_or_admin()) with check (public.is_supervisor_or_admin());
create policy "model_pricing_delete" on public.model_pricing for delete using (public.is_supervisor_or_admin());

drop policy "agent_settings_all" on public.agent_settings;
create policy "agent_settings_select" on public.agent_settings for select using (public.is_agent());
create policy "agent_settings_update" on public.agent_settings for update
  using (public.is_supervisor_or_admin()) with check (public.is_supervisor_or_admin());

-- ---------------------------------------------------------------------------
-- 3. agent_suggestions: cualquier asesor crea/ve, solo supervisor/admin
--    marca como revisada (o borra).
-- ---------------------------------------------------------------------------
drop policy "agent_suggestions_all" on public.agent_suggestions;
create policy "agent_suggestions_select" on public.agent_suggestions for select using (public.is_agent());
create policy "agent_suggestions_insert" on public.agent_suggestions for insert with check (public.is_agent());
create policy "agent_suggestions_update" on public.agent_suggestions for update
  using (public.is_supervisor_or_admin()) with check (public.is_supervisor_or_admin());
create policy "agent_suggestions_delete" on public.agent_suggestions for delete using (public.is_supervisor_or_admin());

-- ---------------------------------------------------------------------------
-- 4. notes: cualquier asesor crea/ve, pero solo el autor o supervisor/admin
--    edita/borra -- misma regla que ya aplica hoy solo en el cliente
--    (context-panel.tsx: note.agent?.id === currentAgent.id || role !== "agent").
-- ---------------------------------------------------------------------------
drop policy "notes_all" on public.notes;
create policy "notes_select" on public.notes for select using (public.is_agent());
create policy "notes_insert" on public.notes for insert with check (public.is_agent());
create policy "notes_update" on public.notes for update
  using (agent_id = auth.uid() or public.is_supervisor_or_admin())
  with check (agent_id = auth.uid() or public.is_supervisor_or_admin());
create policy "notes_delete" on public.notes for delete
  using (agent_id = auth.uid() or public.is_supervisor_or_admin());
