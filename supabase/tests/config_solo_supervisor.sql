-- ===========================================================================
-- La configuración solo la cambia un supervisor/admin, y un asesor corriente
-- NO recibe error: recibe "0 filas afectadas" (T7, plan "Seba encuentra, no
-- insiste, y el mostrador no deja a nadie esperando", 28/9/2026)
--
-- Por qué existe: el 28/9/2026 los asesores mandaban un link de catálogo
-- distinto al de Seba. Antes de dar con la causa real (un mensaje rápido con
-- la URL escrita a mano, ver `quick-reply-catalog-hint.ts`) se sospechó del
-- guardado silencioso: bajo RLS, un `UPDATE`/`DELETE` que la política no deja
-- pasar NO falla -- afecta 0 filas y PostgREST responde 200/204 sin error, así
-- que `const { error } = await ...update()` daba por bueno un guardado que no
-- cambió nada. Este test FIJA ese comportamiento tabla por tabla (es la razón
-- de `assertRowsAffected` en `src/lib/mutations.ts`: sin `.select("id")` el
-- cliente no puede distinguir "guardé" de "la RLS me ignoró").
--
-- Corre como `authenticated` con claims de un agente real -- como `postgres`
-- se salta la RLS y no mediría nada (mismo criterio que catalog_links.sql).
-- Un asesor (rol `agent`) contra cada tabla: 0 filas. Un supervisor: cambia.
--
-- Tablas: catalog_links, ai_playbooks, agent_tools, knowledge_entries,
-- knowledge_categories, agent_settings, model_pricing.
--
-- Caso aparte, `model_pricing` con upsert: el guardado de tarifas usa
-- `upsert` (INSERT ... ON CONFLICT DO UPDATE); ahí la RLS SÍ levanta error
-- (42501) porque el INSERT propuesto también tiene que pasar `with check`.
-- Se deja probado para no suponerlo.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated;

-- Dos agentes: A (asesor, rol 'agent' por default) y S (supervisor).
insert into auth.users (id, email, raw_user_meta_data) values
  ('c7c7c7c7-0000-0000-0000-000000000001', 'agente-a-config@sbk.test', jsonb_build_object('display_name', 'Agente A (config)')),
  ('c7c7c7c7-0000-0000-0000-000000000002', 'agente-s-config@sbk.test', jsonb_build_object('display_name', 'Agente S (config, supervisor)'));

update public.agents set role = 'supervisor' where id = 'c7c7c7c7-0000-0000-0000-000000000002';

-- Fixtures creadas como postgres (sin RLS), antes de cambiar de rol.
insert into public.catalog_links (id, key, label, url, updated_by) values
  ('c7c7c7c7-1000-0000-0000-000000000001', 'config-test', 'Config test', 'https://drive.google.com/file/d/1original/view', 'c7c7c7c7-0000-0000-0000-000000000002');

insert into public.ai_playbooks (id, name, trigger_description, response_text) values
  ('c7c7c7c7-2000-0000-0000-000000000001', 'Config test', 'cuando pruebe', 'Texto original');

insert into public.knowledge_categories (id, name) values
  ('c7c7c7c7-3000-0000-0000-000000000001', 'Config test');

insert into public.knowledge_entries (id, category_id, title, content) values
  ('c7c7c7c7-4000-0000-0000-000000000001', 'c7c7c7c7-3000-0000-0000-000000000001', 'Config test', 'Contenido original');

-- Función temporal, creada como postgres: es security invoker, así que corre
-- con los privilegios (y la RLS) del rol que la llame, A o S.
create or replace function pg_temp.filas_de_a(cual text) returns integer
language plpgsql as $$
declare
  n integer;
begin
  case cual
    when 'catalog_links:update' then
      update public.catalog_links set label = 'Editado por A' where id = 'c7c7c7c7-1000-0000-0000-000000000001';
    when 'catalog_links:delete' then
      delete from public.catalog_links where id = 'c7c7c7c7-1000-0000-0000-000000000001';
    when 'ai_playbooks:update' then
      update public.ai_playbooks set response_text = 'Editado por A' where id = 'c7c7c7c7-2000-0000-0000-000000000001';
    when 'ai_playbooks:delete' then
      delete from public.ai_playbooks where id = 'c7c7c7c7-2000-0000-0000-000000000001';
    when 'agent_tools:update' then
      update public.agent_tools set is_enabled = false where key = 'buscar_repuesto';
    when 'knowledge_entries:update' then
      update public.knowledge_entries set content = 'Editado por A' where id = 'c7c7c7c7-4000-0000-0000-000000000001';
    when 'knowledge_entries:delete' then
      delete from public.knowledge_entries where id = 'c7c7c7c7-4000-0000-0000-000000000001';
    when 'knowledge_categories:update' then
      update public.knowledge_categories set name = 'Editada por A' where id = 'c7c7c7c7-3000-0000-0000-000000000001';
    when 'knowledge_categories:delete' then
      delete from public.knowledge_categories where id = 'c7c7c7c7-3000-0000-0000-000000000001';
    when 'agent_settings:update' then
      update public.agent_settings set ai_globally_enabled = false where id = true;
    else
      raise exception 'caso desconocido %', cual;
  end case;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Como A (asesor): cada UPDATE/DELETE afecta 0 filas, sin error. Nada cambia.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'c7c7c7c7-0000-0000-0000-000000000001';


do $$
declare
  cual text;
  n integer;
begin
  foreach cual in array array[
    'catalog_links:update', 'catalog_links:delete',
    'ai_playbooks:update', 'ai_playbooks:delete',
    'agent_tools:update',
    'knowledge_entries:update', 'knowledge_entries:delete',
    'knowledge_categories:update', 'knowledge_categories:delete',
    'agent_settings:update'
  ] loop
    begin
      n := pg_temp.filas_de_a(cual);
      if n is distinct from 0 then
        insert into _errores(msg) values (format('A (asesor) / %s: afectó %s fila(s), se esperaban 0 -- un asesor pudo cambiar configuración.', cual, n));
      end if;
    exception when others then
      insert into _errores(msg) values (format('A (asesor) / %s: lanzó error (%s) en vez de afectar 0 filas -- si ahora falla fuerte, assertRowsAffected ya no hace falta para esta tabla.', cual, sqlerrm));
    end;
  end loop;
end $$;

-- model_pricing con upsert (así guarda el panel): RLS sí lanza 42501, tanto
-- para un modelo nuevo (INSERT) como para uno existente (ON CONFLICT DO UPDATE).
do $$
declare
  se_guardo boolean;
begin
  se_guardo := false;
  begin
    insert into public.model_pricing (model, input_price_per_million, output_price_per_million)
      values ('config-test/modelo-nuevo', 1, 2)
      on conflict (model) do update set input_price_per_million = excluded.input_price_per_million;
    se_guardo := true;
  exception when insufficient_privilege then
    null;
  end;
  if se_guardo then
    insert into _errores(msg) values ('A (asesor) / model_pricing upsert de modelo NUEVO: se aceptó -- la política de INSERT no está restringiendo a supervisor/admin.');
  end if;

  se_guardo := false;
  begin
    insert into public.model_pricing (model, input_price_per_million, output_price_per_million)
      values ('openai/gpt-5.6-luna', 999, 999)
      on conflict (model) do update set input_price_per_million = excluded.input_price_per_million;
    se_guardo := true;
  exception when insufficient_privilege then
    null;
  end;
  if se_guardo then
    insert into _errores(msg) values ('A (asesor) / model_pricing upsert de modelo EXISTENTE: se aceptó -- la política de UPDATE no está restringiendo a supervisor/admin.');
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- Nada de lo que intentó A cambió (verificado como postgres, sin RLS).
do $$
declare
  n integer;
begin
  select count(*) into n from public.catalog_links
    where id = 'c7c7c7c7-1000-0000-0000-000000000001'
      and label = 'Config test' and url = 'https://drive.google.com/file/d/1original/view';
  if n <> 1 then insert into _errores(msg) values ('Tras A: catalog_links cambió o desapareció.'); end if;

  select count(*) into n from public.ai_playbooks
    where id = 'c7c7c7c7-2000-0000-0000-000000000001' and response_text = 'Texto original';
  if n <> 1 then insert into _errores(msg) values ('Tras A: ai_playbooks cambió o desapareció.'); end if;

  select count(*) into n from public.agent_tools where key = 'buscar_repuesto' and is_enabled;
  if n <> 1 then insert into _errores(msg) values ('Tras A: agent_tools.buscar_repuesto quedó apagada.'); end if;

  select count(*) into n from public.knowledge_entries
    where id = 'c7c7c7c7-4000-0000-0000-000000000001' and content = 'Contenido original';
  if n <> 1 then insert into _errores(msg) values ('Tras A: knowledge_entries cambió o desapareció.'); end if;

  select count(*) into n from public.knowledge_categories
    where id = 'c7c7c7c7-3000-0000-0000-000000000001' and name = 'Config test';
  if n <> 1 then insert into _errores(msg) values ('Tras A: knowledge_categories cambió o desapareció.'); end if;

  select count(*) into n from public.agent_settings where ai_globally_enabled;
  if n <> 1 then insert into _errores(msg) values ('Tras A: agent_settings.ai_globally_enabled quedó apagado.'); end if;

  select count(*) into n from public.model_pricing where model = 'config-test/modelo-nuevo';
  if n <> 0 then insert into _errores(msg) values ('Tras A: model_pricing tiene el modelo que A intentó crear.'); end if;
end $$;

-- ---------------------------------------------------------------------------
-- Como S (supervisor): las mismas sentencias SÍ cambian una fila.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'c7c7c7c7-0000-0000-0000-000000000002';

do $$
declare
  cual text;
  n integer;
begin
  -- Los borrados van al final: primero las ediciones sobre las mismas filas.
  foreach cual in array array[
    'catalog_links:update',
    'ai_playbooks:update',
    'agent_tools:update',
    'knowledge_entries:update',
    'knowledge_categories:update',
    'agent_settings:update',
    'knowledge_entries:delete',
    'knowledge_categories:delete',
    'ai_playbooks:delete',
    'catalog_links:delete'
  ] loop
    begin
      n := pg_temp.filas_de_a(cual);
      if n is distinct from 1 then
        insert into _errores(msg) values (format('S (supervisor) / %s: afectó %s fila(s), se esperaba 1.', cual, n));
      end if;
    exception when others then
      insert into _errores(msg) values (format('S (supervisor) / %s: lanzó error -- %s', cual, sqlerrm));
    end;
  end loop;

  begin
    insert into public.model_pricing (model, input_price_per_million, output_price_per_million, updated_by)
      values ('openai/gpt-5.6-luna', 7, 8, 'c7c7c7c7-0000-0000-0000-000000000002')
      on conflict (model) do update
        set input_price_per_million = excluded.input_price_per_million,
            output_price_per_million = excluded.output_price_per_million;
    get diagnostics n = row_count;
    if n is distinct from 1 then
      insert into _errores(msg) values (format('S (supervisor) / model_pricing upsert: afectó %s fila(s), se esperaba 1.', n));
    end if;
  exception when others then
    insert into _errores(msg) values (format('S (supervisor) / model_pricing upsert: lanzó error -- %s', sqlerrm));
  end;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Veredicto
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'config_solo_supervisor.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'config_solo_supervisor.sql: todas las aserciones pasaron.'
