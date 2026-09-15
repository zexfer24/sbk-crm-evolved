-- ============================================================================
-- La base dice SBK Motors donde decía SBK Motorcycles
--
-- Tarea 1 del plan "La voz de mostrador con nombre propio y el cierre de
-- v1.1" (15/9/2026). El operador renombró el negocio de "SBK Motorcycles" a
-- "SBK Motors" (Decisión 1-2 del plan: el nombre nuevo se escribe UNA vez en
-- código, en `src/lib/brand.ts`), pero el nombre viejo ya es un DATO en
-- producción, no solo texto de código: la categoría "La tienda" de la
-- biblioteca se sembró con "datos generales de SBK Motorcycles"
-- (20260825020000_knowledge_base.sql:68) y el operador puede haberlo repetido
-- a mano en entradas de la biblioteca y en escenarios (`ai_playbooks`) desde
-- el panel -- ambas cosas SÍ le llegan al cliente tal cual, verbatim.
--
-- Decisión 3 del plan (aprobada por el operador el 15/9/2026): tocar las TRES
-- tablas (incluido lo escrito a mano en el panel), con un `replace()` que no
-- rompe nada más del texto -- no un `update ... set x = 'texto fijo'` que
-- perdería lo que cada fila decía alrededor del nombre.
--
-- NO se toca `public.templates`: su `body_preview` es un reflejo informativo
-- de un texto YA APROBADO por Meta bajo ese nombre exacto; reescribirlo acá
-- no cambia la plantilla real del lado de Meta y solo desalinearía el
-- reflejo. Fuera de alcance de esta tarea (ver plan, "No se renombran").
--
-- `replace()` es idempotente por construcción (una segunda pasada no
-- encuentra 'SBK Motorcycles' y no cambia nada) y el trigger `set_updated_at`
-- de las tres tablas va a mover `updated_at` en las filas tocadas -- aceptado,
-- no hay nada que lo evite sin tocar el trigger, que está fuera de alcance.
--
-- Sin backfill de otra clase (no hay nada más que corregir) y sin funciones
-- `security definer` nuevas: solo `update` sobre datos existentes -> sin
-- revokes ni grants.
-- ============================================================================

update public.knowledge_categories
set
  name = replace(name, 'SBK Motorcycles', 'SBK Motors'),
  description = replace(description, 'SBK Motorcycles', 'SBK Motors')
where name like '%SBK Motorcycles%' or description like '%SBK Motorcycles%';

update public.knowledge_entries
set
  title = replace(title, 'SBK Motorcycles', 'SBK Motors'),
  content = replace(content, 'SBK Motorcycles', 'SBK Motors')
where title like '%SBK Motorcycles%' or content like '%SBK Motorcycles%';

update public.ai_playbooks
set
  trigger_description = replace(trigger_description, 'SBK Motorcycles', 'SBK Motors'),
  response_text = replace(response_text, 'SBK Motorcycles', 'SBK Motors')
where trigger_description like '%SBK Motorcycles%' or response_text like '%SBK Motorcycles%';

-- ----------------------------------------------------------------------------
-- Autoverificación: si algo del nombre viejo sobrevivió en cualquiera de las
-- seis columnas, la migración entera falla en vez de dejarlo pasar en
-- silencio -- mismo criterio que 20260914010000 (contar contra la base real,
-- no confiar en que el `update` de arriba hizo lo que el comentario dice).
-- ----------------------------------------------------------------------------
do $$
declare
  n_restantes integer;
begin
  select
    (select count(*) from public.knowledge_categories where name like '%SBK Motorcycles%' or description like '%SBK Motorcycles%')
    + (select count(*) from public.knowledge_entries where title like '%SBK Motorcycles%' or content like '%SBK Motorcycles%')
    + (select count(*) from public.ai_playbooks where trigger_description like '%SBK Motorcycles%' or response_text like '%SBK Motorcycles%')
  into n_restantes;

  if n_restantes > 0 then
    raise exception '20260915010000: quedaron % fila(s) con "SBK Motorcycles" en knowledge_categories/knowledge_entries/ai_playbooks tras el replace.', n_restantes;
  end if;

  raise notice '20260915010000: ninguna fila de knowledge_categories/knowledge_entries/ai_playbooks quedó con el nombre viejo.';
end $$;
