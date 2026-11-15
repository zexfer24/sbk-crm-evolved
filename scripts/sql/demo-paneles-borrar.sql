-- ============================================================================
-- Borra los datos de demostración de los paneles (13/11/2026), tarea D1.
-- SOLO BASE LOCAL. Quita exactamente lo que cargó `demo-paneles.sql` y nada más:
--
--   docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sql/demo-paneles-borrar.sql
--
-- Cómo reconoce lo demo (misma marca que el script de carga):
--   · contactos con profile_name = 'DEMO-PANELES' (sus conversaciones, mensajes,
--     carritos, etiquetas y traspasos se van por ON DELETE CASCADE);
--   · presupuestos con nota = 'DEMO-PANELES' (sus renglones, por cascada);
--   · los borradores de SAINT y las fotos (`ventas_saint`) que cuelgan de esas
--     conversaciones y presupuestos;
--   · productos con description = 'DEMO-PANELES' y saint_code 'DEMO-%';
--   · tasas BCV con source = 'demo-paneles'.
-- Las sentencias son las mismas del paso 0 de `demo-paneles.sql`; si cambia una,
-- cambia la otra. Se borra en este orden: fotos y borradores primero (cuelgan de
-- ids que se van a perder), después presupuestos, contactos, productos y tasas.
-- ============================================================================
begin;

create temp table _demo_conv on commit drop as
  select c.id
    from public.conversations c
    join public.contacts ct on ct.id = c.contact_id
   where ct.profile_name = 'DEMO-PANELES';
create temp table _demo_pres on commit drop as
  select id from public.presupuestos where nota = 'DEMO-PANELES';

delete from public.ventas_saint
 where borrador_id in (
         select b.id from liminal.saint_borradores b
          where (b.origen = 'carrito' and b.origen_id in (select id from _demo_conv))
             or (b.origen = 'presupuesto' and b.origen_id in (select id from _demo_pres)))
    or conversation_id in (select id from _demo_conv)
    or presupuesto_id in (select id from _demo_pres);
delete from liminal.saint_borradores b
 where (b.origen = 'carrito' and b.origen_id in (select id from _demo_conv))
    or (b.origen = 'presupuesto' and b.origen_id in (select id from _demo_pres));
delete from public.presupuestos where nota = 'DEMO-PANELES';
delete from public.contacts where profile_name = 'DEMO-PANELES';
delete from public.products where description = 'DEMO-PANELES' and saint_code like 'DEMO-%';
delete from public.exchange_rates where source = 'demo-paneles';

-- Lo que queda de demo: todo debe dar 0.
select 'contactos demo' as concepto, count(*) as filas from public.contacts where profile_name = 'DEMO-PANELES'
union all select 'presupuestos demo', count(*) from public.presupuestos where nota = 'DEMO-PANELES'
union all select 'productos demo', count(*) from public.products where description = 'DEMO-PANELES' or saint_code like 'DEMO-%'
union all select 'tasas demo', count(*) from public.exchange_rates where source = 'demo-paneles'
union all select 'borradores demo', count(*) from liminal.saint_borradores where nombre = 'Demo' or numero_saint like 'DEMO-%'
union all select 'fotos huérfanas (ventas_saint sin borrador)', count(*) from public.ventas_saint v where not exists (select 1 from liminal.saint_borradores b where b.id = v.borrador_id);

commit;
