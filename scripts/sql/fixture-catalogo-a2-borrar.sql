-- GENERADO por scripts/fixture-a2-sql.ts -- no editar a mano.
-- Catalogo de prueba de la Entrega A2 ("Seba no cotiza lo que no es").
-- Correr con psql como postgres (products es de solo lectura para la app):
--   docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 -f - < <este archivo>
-- No abre transaccion propia: psql -1 la abre.

delete from public.products where description like 'A2FIX-%';
