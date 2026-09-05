-- ============================================================================
-- contacts.search_text encuentra "José" escribiendo "jose" (F13)
--
-- Corre en el job `migraciones` de CI contra la base reconstruida desde cero,
-- dentro de una transacción con `rollback`: no depende de los seeds ni deja
-- nada atrás (mismo estilo que invariante_leads.sql).
--
-- Lo que se verifica es exactamente la promesa de
-- 20260905020000_contacts_search_unaccent.sql: la columna generada
-- `search_text` es el nombre para mostrar + el nombre de perfil de WhatsApp +
-- el número, todo junto, sin acentos y en minúsculas — y el filtro
-- `ilike '%jose%'` que usa `searchConversationSummaries` (src/lib/data.ts)
-- contra esa columna encuentra al contacto sin importar cómo escribió su
-- nombre quien lo cargó.
-- ============================================================================

begin;

insert into public.contacts (id, phone_number, display_name, profile_name) values
  -- El caso que justifica la migración: nombre con tilde y mayúscula.
  ('33333333-3333-3333-3333-333333333301', '+580000001001', 'José Pérez', null),
  -- Sin acentos de por sí: tiene que seguir encontrándose, la normalización
  -- no puede romper el caso que ya andaba.
  ('33333333-3333-3333-3333-333333333302', '+580000001002', 'Jose Ramirez', null),
  -- El nombre para mostrar no lo tiene, pero el profile_name de WhatsApp sí
  -- trae la tilde: search_text junta las tres columnas, así que tiene que
  -- calzar igual.
  ('33333333-3333-3333-3333-333333333303', '+580000001003', null, 'José (perfil)'),
  -- Contacto sin ningún "jose" en ningún campo: no tiene que aparecer.
  ('33333333-3333-3333-3333-333333333304', '+580000001004', 'María Contreras', null);

do $$
declare
  obtenido text;
  n integer;
  errores text := '';
begin
  -- La columna generada, tal cual: sin acentos, en minúsculas, las tres
  -- columnas concatenadas con espacio de por medio (profile_name viene
  -- vacío por `coalesce`, así que entre "pérez" y el número quedan dos
  -- espacios — el mismo artefacto de products.search_text, no afecta al
  -- `ilike` que de verdad usa el buscador).
  select search_text into obtenido
  from public.contacts
  where id = '33333333-3333-3333-3333-333333333301';

  if obtenido <> 'jose perez  +580000001001' then
    errores := errores || format(
      E'\n  - search_text de "José Pérez" dio %L y se esperaba %L.',
      obtenido, 'jose perez  +580000001001');
  end if;

  -- El filtro que de verdad usa el buscador: ilike con comodín al
  -- principio, la misma forma que arma pgrstLiteral en searchConversationSummaries.
  select count(*) into n
  from public.contacts
  where id in (
    '33333333-3333-3333-3333-333333333301',
    '33333333-3333-3333-3333-333333333302',
    '33333333-3333-3333-3333-333333333303',
    '33333333-3333-3333-3333-333333333304'
  )
  and search_text ilike '%jose%';

  if n <> 3 then
    errores := errores || format(
      E'\n  - "jose" tenía que encontrar a los tres contactos con "José"/"Jose" (display_name o profile_name) y encontró %s.',
      n);
  end if;

  -- El que no tiene "jose" en ningún campo no tiene que aparecer.
  if exists (
    select 1 from public.contacts
    where id = '33333333-3333-3333-3333-333333333304'
      and search_text ilike '%jose%'
  ) then
    errores := errores || E'\n  - "María Contreras" no tenía que calzar con "jose" y calzó.';
  end if;

  if errores <> '' then
    raise exception E'contacts_search.sql: F13 rota:%', errores;
  end if;
end $$;

rollback;

\echo 'contacts_search.sql: todas las aserciones pasaron.'
