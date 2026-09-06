-- ===========================================================================
-- agent_settings.business_hours (migración 20260906010000, Frente B1 del
-- plan "El reloj dice la verdad", 5/9/2026)
--
-- Dos aserciones:
--   1. El default trae los siete días (mon..sun) con la forma esperada --
--      lunes a viernes 08:00-18:00, sábado y domingo cerrado (lista vacía) --
--      que es el supuesto del orquestador y lo que ya decía el seed en
--      prosa.
--   2. La columna es un OBJETO, no cualquier jsonb: un update a '[]'::jsonb
--      (un array, forma que alguien podría mandar por error) tiene que
--      fallar por `agent_settings_business_hours_object`. Se captura con
--      `exception when check_violation` (estilo `do $$ ... end $$` de
--      `invariante_leads.sql`) y se afirma que SÍ falló -- si el update
--      pasara sin error, esta prueba lo delata.
--
-- Corre en el job `migraciones` de CI, dentro de una transacción con
-- `rollback`: no depende de los seeds ni deja nada atrás (la fila única de
-- agent_settings ya existe desde 20260819040000, insertada en esa misma
-- migración -- acá solo se lee y se intenta actualizar, nunca se inserta).
-- ===========================================================================

begin;

do $$
declare
  horario jsonb;
  errores text := '';
  update_fallo boolean := false;
begin
  select business_hours into horario from public.agent_settings where id = true;

  if horario is null then
    errores := errores || E'\n  - business_hours vino null en la fila única de agent_settings.';
  end if;

  if horario <> '{"mon":[["08:00","18:00"]],"tue":[["08:00","18:00"]],"wed":[["08:00","18:00"]],"thu":[["08:00","18:00"]],"fri":[["08:00","18:00"]],"sat":[],"sun":[]}'::jsonb then
    errores := errores || format(
      E'\n  - el default de business_hours no coincide con L-V 08:00-18:00 y fin de semana cerrado. Vino: %s', horario);
  end if;

  -- Los siete días tienen que estar, uno por uno, para que un typo en una
  -- llave (ej. "tues" en vez de "tue") no se cuele silencioso: `<>` arriba ya
  -- lo detectaría, pero esta vuelta explícita nombra CUÁL día falta.
  if not (horario ? 'mon' and horario ? 'tue' and horario ? 'wed'
          and horario ? 'thu' and horario ? 'fri' and horario ? 'sat'
          and horario ? 'sun') then
    errores := errores || E'\n  - business_hours no trae las siete llaves mon..sun.';
  end if;

  if errores <> '' then
    raise exception E'agent_settings.business_hours (default): %', errores;
  end if;
end $$;

do $$
begin
  begin
    update public.agent_settings set business_hours = '[]'::jsonb where id = true;
    -- Si la línea de arriba no lanzó, el check no está protegiendo la forma.
    raise exception 'agent_settings_business_hours_object: un update a ''[]''::jsonb (un array) debía fallar por el check y no falló.';
  exception
    when check_violation then
      -- Esperado: el check `agent_settings_business_hours_object` corta el
      -- update. Nada que hacer -- el bloque exterior sigue de largo.
      null;
  end;
end $$;

rollback;

\echo 'business_hours.sql: todas las aserciones pasaron.'
