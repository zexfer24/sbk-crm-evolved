-- SBK Motorcycles CRM - Datos de prueba
-- Permite probar el CRM completo sin tener aún la conexión real a Meta.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- Freno de seguridad: este archivo crea tres usuarios con una contraseña
-- publicada acá mismo. Correrlo contra la base del negocio entregaría acceso
-- al CRM a cualquiera que lea el repositorio.
--
-- Se aborta si la base muestra señales de ser real: un canal de WhatsApp
-- conectado, o mensajes que Meta haya entregado de verdad. En una base de
-- desarrollo recién creada no hay ni lo uno ni lo otro, así que no estorba.
-- ============================================================================
do $$
begin
  if exists (select 1 from public.whatsapp_channels where status = 'connected')
     or exists (select 1 from public.messages where whatsapp_message_id is not null) then
    raise exception
      'seed.sql es solo para desarrollo y esta base tiene datos reales (un canal conectado o mensajes entregados por Meta). Abortado: crearía usuarios con la contraseña que está escrita en el propio archivo.';
  end if;
end $$;

-- ============================================================================
-- AGENTES (auth.users + auth.identities + public.agents)
-- Contraseña para los 3: SbkDemo123!
-- ============================================================================
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  last_sign_in_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated',
   'jose@sbk.test', crypt('SbkDemo123!', gen_salt('bf')), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"display_name":"JOSE RIERA","full_name":"Jose Riera"}',
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated',
   'maria@sbk.test', crypt('SbkDemo123!', gen_salt('bf')), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"display_name":"ASESOR 2","full_name":"Maria Gomez"}',
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated',
   'carlos@sbk.test', crypt('SbkDemo123!', gen_salt('bf')), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"display_name":"ASESOR 3","full_name":"Carlos Ibarra"}',
   now(), now(), '', '', '', '');

insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   jsonb_build_object('sub', '11111111-1111-1111-1111-111111111111', 'email', 'jose@sbk.test'), 'email', now(), now(), now()),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
   jsonb_build_object('sub', '22222222-2222-2222-2222-222222222222', 'email', 'maria@sbk.test'), 'email', now(), now(), now()),
  (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333',
   jsonb_build_object('sub', '33333333-3333-3333-3333-333333333333', 'email', 'carlos@sbk.test'), 'email', now(), now(), now());

-- El trigger on_auth_user_created ya creó las filas en public.agents.
-- Ajustamos el rol de Jose a supervisor.
update public.agents set role = 'supervisor' where id = '11111111-1111-1111-1111-111111111111';

-- ============================================================================
-- CANALES DE WHATSAPP (buzones)
-- ============================================================================
insert into public.whatsapp_channels (id, label, phone_number, phone_number_id, waba_id, status)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Ventas Principal', '+52 55 1234 5678', 'mock-phone-id-ventas', 'mock-waba-1', 'connected'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Soporte', '+52 55 8765 4321', 'mock-phone-id-soporte', 'mock-waba-1', 'pending');

-- ============================================================================
-- TAGS
-- ============================================================================
insert into public.tags (id, label, color) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'BBK', 'accent'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'VIP', 'success'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'Moroso', 'danger'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'Nuevo', 'default');

-- ============================================================================
-- CONTACTOS
-- ============================================================================
insert into public.contacts (id, phone_number, display_name, profile_name) values
  ('cccccccc-0000-0000-0000-000000000001', '+52 55 1111 0001', 'Ana Torres', 'Ana T.'),
  ('cccccccc-0000-0000-0000-000000000002', '+52 55 1111 0002', 'Carlos Mendoza', 'Carlos M'),
  ('cccccccc-0000-0000-0000-000000000003', '+52 55 1111 0003', 'Laura Fernández', 'Laura F'),
  ('cccccccc-0000-0000-0000-000000000004', '+52 55 1111 0004', 'Roberto Nuñez', 'Roberto N.'),
  ('cccccccc-0000-0000-0000-000000000005', '+52 55 1111 0005', 'Diana López', 'Diana');

insert into public.contact_tags (contact_id, tag_id) values
  ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'),
  ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000003'),
  ('cccccccc-0000-0000-0000-000000000005', 'bbbbbbbb-0000-0000-0000-000000000004');

-- ============================================================================
-- CONVERSACIONES
-- ============================================================================
insert into public.conversations
  (id, contact_id, whatsapp_channel_id, status, assigned_agent_id, ai_enabled, deal_status, deal_closed_at)
values
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 'open', '22222222-2222-2222-2222-222222222222', true, 'in_progress', null),
  ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001', 'open', null, true, 'none', null),
  ('dddddddd-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000002', 'open', '11111111-1111-1111-1111-111111111111', false, 'lost', null),
  ('dddddddd-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000004',
   'aaaaaaaa-0000-0000-0000-000000000001', 'closed', '22222222-2222-2222-2222-222222222222', true, 'won', now() - interval '4 hours'),
  ('dddddddd-0000-0000-0000-000000000005', 'cccccccc-0000-0000-0000-000000000005',
   'aaaaaaaa-0000-0000-0000-000000000001', 'open', null, true, 'none', null);

-- ============================================================================
-- MENSAJES (incluye eventos de sistema para el rastro de auditoría)
-- ============================================================================

-- Conversación 1: Ana Torres — dentro de la ventana 24h, con no leídos.
insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, is_internal_note, created_at) values
  ('dddddddd-0000-0000-0000-000000000001', 'inbound', 'customer', null, 'text', 'Hola, quería preguntar por el paquete premium', false, now() - interval '2 hours'),
  ('dddddddd-0000-0000-0000-000000000001', 'outbound', 'system', '22222222-2222-2222-2222-222222222222', 'system_event', 'Asesor 2 se auto-asignó la conversación', false, now() - interval '1 hour 50 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', 'outbound', 'ai', null, 'text', '¡Hola! Claro, el paquete premium incluye envío gratis y garantía extendida. ¿Te gustaría ver el catálogo?', false, now() - interval '1 hour 45 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', 'inbound', 'customer', null, 'text', '¿Tienen envío a Guadalajara?', false, now() - interval '15 minutes'),
  ('dddddddd-0000-0000-0000-000000000001', 'inbound', 'customer', null, 'text', 'Y cuánto tarda?', false, now() - interval '10 minutes');

-- Conversación 2: Carlos Mendoza — sin asignar, un no leído.
insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, is_internal_note, created_at) values
  ('dddddddd-0000-0000-0000-000000000002', 'inbound', 'customer', null, 'text', 'Buenas tardes, vi su anuncio en Facebook', false, now() - interval '3 hours'),
  ('dddddddd-0000-0000-0000-000000000002', 'outbound', 'ai', null, 'text', '¡Hola! Gracias por escribirnos. ¿En qué producto estás interesado?', false, now() - interval '2 hours 58 minutes');

-- Conversación 3: Laura Fernández — fuera de la ventana 24h (demo de bloqueo + plantillas), IA pausada.
insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, is_internal_note, created_at) values
  ('dddddddd-0000-0000-0000-000000000003', 'inbound', 'customer', null, 'text', 'Ya no me interesa, gracias', false, now() - interval '31 hours'),
  ('dddddddd-0000-0000-0000-000000000003', 'outbound', 'system', '11111111-1111-1111-1111-111111111111', 'system_event', 'Jose Riera intervino la conversación y pausó la IA', false, now() - interval '30 hours 50 minutes'),
  ('dddddddd-0000-0000-0000-000000000003', 'outbound', 'agent', '11111111-1111-1111-1111-111111111111', 'text', 'Entendido, cualquier cosa me escribes', false, now() - interval '30 hours 45 minutes'),
  ('dddddddd-0000-0000-0000-000000000003', 'outbound', 'system', '11111111-1111-1111-1111-111111111111', 'system_event', 'Asesor 2 fue desasignado de la conversación', false, now() - interval '30 hours 40 minutes');

-- Conversación 4: Roberto Nuñez — venta cerrada.
insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, is_internal_note, created_at) values
  ('dddddddd-0000-0000-0000-000000000004', 'inbound', 'customer', null, 'text', 'Quiero comprar 3 unidades', false, now() - interval '6 hours'),
  ('dddddddd-0000-0000-0000-000000000004', 'outbound', 'ai', null, 'text', '¡Perfecto! Te comparto el link de pago para 3 unidades.', false, now() - interval '5 hours 58 minutes'),
  ('dddddddd-0000-0000-0000-000000000004', 'outbound', 'agent', '22222222-2222-2222-2222-222222222222', 'text', '¡Cerramos la venta! Gracias por tu compra 🎉', false, now() - interval '4 hours'),
  ('dddddddd-0000-0000-0000-000000000004', 'outbound', 'system', '22222222-2222-2222-2222-222222222222', 'system_event', 'Venta cerrada por Asesor 2', false, now() - interval '4 hours');

-- Conversación 5: Diana López — sin asignar, 3 no leídos.
insert into public.messages (conversation_id, direction, sender_type, sender_agent_id, message_type, content, is_internal_note, created_at) values
  ('dddddddd-0000-0000-0000-000000000005', 'inbound', 'customer', null, 'text', 'Hola! Buenas', false, now() - interval '20 minutes'),
  ('dddddddd-0000-0000-0000-000000000005', 'inbound', 'customer', null, 'text', 'Cuánto cuesta el envío a CDMX?', false, now() - interval '12 minutes'),
  ('dddddddd-0000-0000-0000-000000000005', 'inbound', 'customer', null, 'text', 'Sigue disponible el producto?', false, now() - interval '5 minutes');

-- El trigger on_message_inserted ya calculó unread_count / last_message_at, pero
-- forzamos valores exactos para que la demo de filtros sea determinista.
update public.conversations set unread_count = 2 where id = 'dddddddd-0000-0000-0000-000000000001';
update public.conversations set unread_count = 1 where id = 'dddddddd-0000-0000-0000-000000000002';
update public.conversations set unread_count = 0 where id = 'dddddddd-0000-0000-0000-000000000003';
update public.conversations set unread_count = 0 where id = 'dddddddd-0000-0000-0000-000000000004';
update public.conversations set unread_count = 3 where id = 'dddddddd-0000-0000-0000-000000000005';

-- ============================================================================
-- NOTAS INTERNAS
-- ============================================================================
insert into public.notes (contact_id, agent_id, content) values
  ('cccccccc-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Cliente frecuente, siempre pregunta por descuentos de temporada.'),
  ('cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Se quejó del tiempo de entrega en su última compra. Manejar con cuidado.');

-- ============================================================================
-- PLANTILLAS DE WHATSAPP (para reabrir chats fuera de la ventana 24h)
-- ============================================================================
insert into public.templates (whatsapp_channel_id, name, language, category, body_preview, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'reabrir_conversacion_generico', 'es', 'utility',
   'Hola {{1}}, seguimos disponibles para ayudarte. ¿Deseas continuar con tu compra?', 'approved'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'seguimiento_post_venta', 'es', 'marketing',
   'Hola {{1}}, ¿qué tal tu experiencia con {{2}}? Nos encantaría conocer tu opinión.', 'pending'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'reapertura_soporte', 'es', 'utility',
   'Hola {{1}}, tu ticket de soporte sigue abierto. ¿Podemos ayudarte en algo más?', 'approved');

-- ============================================================================
-- MENSAJES RÁPIDOS (texto que se carga en el composer, editable antes de enviar)
-- ============================================================================
insert into public.quick_replies (label, content) values
  ('Saludo inicial', '¡Hola! Gracias por escribirnos, ¿en qué te podemos ayudar?'),
  ('Pedir cédula y datos', 'Para procesar tu pedido necesito tu nombre completo, cédula y la dirección de entrega, por favor.'),
  ('Horario de atención', 'Nuestro horario de atención es de lunes a viernes de 8am a 6pm.');

-- ============================================================================
-- CATÁLOGO DE REPUESTOS (para que el agente de IA tenga qué buscar)
-- ============================================================================
insert into public.products (id, name, brand, price, currency, stock_quantity, description) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'Carburador PZ27', 'Genérico', 18.00, 'USD', 12, 'Carburador de 27mm, ajuste estándar para motos de 150-200cc.'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'Kit de arrastre (piñón + catalina + cadena)', 'DID', 35.50, 'USD', 5, 'Kit completo 428H, incluye piñón, catalina y cadena de 120 eslabones.'),
  ('eeeeeeee-0000-0000-0000-000000000003', 'Bujía CR7HSA', 'NGK', 3.25, 'USD', 40, 'Bujía estándar de níquel, rosca corta.'),
  ('eeeeeeee-0000-0000-0000-000000000004', 'Pastillas de freno delanteras', 'Genérico', 8.00, 'USD', 0, 'Juego de pastillas para disco delantero, calibre estándar.'),
  ('eeeeeeee-0000-0000-0000-000000000005', 'Filtro de aceite', 'Genérico', 4.50, 'USD', 20, 'Filtro de aceite roscado, compatible con motor de 4 tiempos.');

insert into public.product_compatibility (product_id, moto_brand, moto_model) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'Bera', 'SBR 200'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'Empire Keeway', 'TX 200'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'Suzuki', 'AX 100'),
  ('eeeeeeee-0000-0000-0000-000000000003', 'Bera', 'SBR 200'),
  ('eeeeeeee-0000-0000-0000-000000000003', 'Yamaha', 'Crypton'),
  ('eeeeeeee-0000-0000-0000-000000000003', 'Suzuki', 'AX 100'),
  ('eeeeeeee-0000-0000-0000-000000000004', 'Bera', 'SBR 200'),
  ('eeeeeeee-0000-0000-0000-000000000005', 'Bera', 'SBR 200');

-- ============================================================================
-- HISTORIAL DE COMPRAS (para que la IA tenga contexto real en "devolución")
-- ============================================================================
insert into public.orders (id, contact_id, purchased_at, total_amount, currency, bcv_rate) values
  ('ffffffff-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', now() - interval '10 days', 18.00, 'USD', 768.1200);

insert into public.order_items (order_id, product_id, description, quantity, unit_price) values
  ('ffffffff-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'Carburador PZ27', 1, 18.00);

-- ============================================================================
-- TASA BCV del día (para no depender de bcv.org.ve en la primera prueba)
-- ============================================================================
-- Tasa de arranque para que la demo pueda cotizar sin red. `fetched_on` va
-- en null a propósito: así la app la trata como "no sé de cuándo es" y sale a
-- buscar la real en el primer arranque, en vez de quedarse con este número.
insert into public.exchange_rates (rate_date, usd_to_ves, source, fetched_on) values
  (current_date, 775.3356, 'bcv.org.ve', null)
on conflict (rate_date) do nothing;

-- ============================================================================
-- TARIFAS de modelo (placeholder — ajustar desde el panel de Control de IA
-- antes de confiar en el $USD que muestra; estos valores son de ejemplo)
-- ============================================================================
insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values
  ('openai/gpt-5.6-luna', 1.2500, 10.0000),
  ('google/gemini-3.1-flash-lite', 0.1000, 0.4000)
on conflict (model) do nothing;
