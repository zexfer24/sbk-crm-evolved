-- ============================================================================
-- Nadie puede desactivar su propio acceso.
--
-- El interruptor de "Control de agentes" apaga el acceso completo al CRM, y
-- un admin que se lo apaga a sí mismo queda fuera sin nadie que lo vuelva a
-- encender — pasó dos veces en doce horas con la cuenta del dueño, y las dos
-- hubo que reactivarla por SQL. El panel ya deshabilita el interruptor sobre
-- la propia fila (ddd942c), pero la UI no es una garantía: cualquier pestaña
-- vieja sin ese cambio, o una llamada directa a PostgREST, seguía pudiendo.
--
-- La regla vive acá, en la base, porque es donde no se puede esquivar. Solo
-- frena el caso exacto: apagarse (is_active true -> false) siendo uno mismo
-- (auth.uid() = la fila tocada). Un admin apagando a otro pasa igual que
-- siempre, y el SQL directo del operador (sin JWT, auth.uid() es null)
-- también: si un día TODOS quedan fuera, la puerta de emergencia sigue
-- siendo la de siempre.
-- ============================================================================

create function public.prevent_self_deactivation()
returns trigger
language plpgsql
as $$
begin
  if old.is_active and not new.is_active and old.id = auth.uid() then
    raise exception 'No puedes desactivar tu propio acceso al CRM.';
  end if;
  return new;
end;
$$;

create trigger no_self_deactivation
  before update of is_active on public.agents
  for each row
  execute function public.prevent_self_deactivation();
