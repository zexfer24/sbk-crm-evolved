-- ===========================================================================
-- Un turno sin mensaje nuevo deja rastro (24/10/2026, caso 75e26065-0800-4427-
-- 92a1-cc8e68e9d5ba)
--
-- Migración bajo prueba: 20261024010000_traspaso_sin_mensaje_nuevo.sql.
--
-- Qué fija:
--   1. El CHECK de conversation_handoffs.reason acepta `sin_mensaje_nuevo`
--      (la escribe runTurnPhases cuando sale por turno_sin_mensaje_nuevo con
--      el historial terminando en el cliente) y sigue aceptando las 32 que ya
--      tenía.
--   2. Sigue rechazando una razón inventada.
--
-- Transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final con todo lo acumulado.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;

insert into public.whatsapp_channels (id, label, phone_number) values
  ('5e1a0000-1000-0000-0000-000000000000', 'Canal de prueba sin mensaje nuevo', '+580000009600');
insert into public.contacts (id, phone_number) values
  ('5e1a0000-2000-0000-0000-000000000001', '+580000009601');
insert into public.conversations (id, contact_id, whatsapp_channel_id) values
  ('5e1a0000-3000-0000-0000-000000000001', '5e1a0000-2000-0000-0000-000000000001', '5e1a0000-1000-0000-0000-000000000000');

do $$
declare
  v_razones text[] := array[
    'sin_mensaje_nuevo',
    'agente_no_puede_correr','conversacion_inexistente','pausada','asignada','humano_intervino',
    'humano_se_adelanto','fuera_de_ventana','identidad_no_verificable','lock_perdido','abandonado',
    'entrega_fallida','reabierto','escalado_por_ia','reclamado','devuelto_a_ia','cerrado',
    'ventana_vencida','sla_vencido','escalada','escalada_sin_asesor','rechazado_por_meta',
    'cerrada_por_asesor','reabierta_por_asesor','reabierta_por_cliente','sin_contenido_legible',
    'cortesia_tras_escalada','desasignada_por_asesor','mensaje_previo_a_devolucion',
    'silenciada_por_asesor','fuera_de_tema_repetido','reasignada_por_demora','demora_sin_asesor'
  ];
  v_razon text;
  v_entro boolean;
begin
  foreach v_razon in array v_razones loop
    begin
      insert into public.conversation_handoffs (conversation_id, to_kind, reason)
        values ('5e1a0000-3000-0000-0000-000000000001', 'unassigned', v_razon);
    exception when check_violation then
      insert into _errores(msg) values (format('Caso 1: el CHECK de conversation_handoffs.reason rechazó la razón "%s" (debía aceptarla).', v_razon));
    end;
  end loop;

  v_entro := false;
  begin
    insert into public.conversation_handoffs (conversation_id, to_kind, reason)
      values ('5e1a0000-3000-0000-0000-000000000001', 'unassigned', 'razon_inventada_por_el_test');
    v_entro := true;
  exception when check_violation then
    null;
  end;
  if v_entro then
    insert into _errores(msg) values ('Caso 2: el CHECK aceptó una razón inventada (perdió su lista cerrada).');
  end if;
end $$;

do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'traspaso_sin_mensaje_nuevo.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'traspaso_sin_mensaje_nuevo.sql: todas las aserciones pasaron.'
