-- ============================================================================
-- Facturar en SAINT (28/10/2026), plan "Facturar en SAINT sale del fondo del
-- panel", T0.
--
-- Contexto: "Enviar a SAINT" (20261025010000) pedía un teléfono obligatorio que
-- el agente LiminalReplicant recibe pero no necesita para facturar, y el asesor
-- que no lo tenía a mano no podía enviar. Además, desde el carrito la RPC solo
-- completaba la cédula del contacto "si le faltaba" y desde un presupuesto no
-- guardaba nada: lo que el asesor tipea en el formulario (nombre, apellido,
-- cédula) es el dato más fresco que tiene el CRM del cliente y se perdía.
--
-- Qué cambia en `public.enviar_borrador_saint` (misma firma de 7 parámetros; el
-- resto del cuerpo es idéntico a 20261025010000):
--   1. El teléfono vacío (o en blanco) es válido y se guarda como ''. La columna
--      `liminal.saint_borradores.telefono` sigue `not null` y la tabla NO se
--      toca: es un contrato con el agente. Que el agente acepte '' al crear el
--      cliente en SAINT está POR CONFIRMAR en LiminalReplicant (28/10/2026): es
--      el bloqueante de despliegue de esta migración. Si trae algo, sigue la
--      regex `^\+?[0-9]{7,19}$` y el mismo detail.
--   2. El contacto se actualiza SIEMPRE (gana el último envío) con
--      display_name = nombre || ' ' || apellido (ya recortados), cedula_type y
--      cedula_number. Antes: solo la cédula, solo si faltaba y solo desde el
--      carrito. El contacto sale de `conversations.contact_id` (origen carrito)
--      o de `presupuestos.contact_id` (origen presupuesto; si es nulo, no se
--      toca nada). El teléfono del contacto NUNCA se toca: es la llave de
--      WhatsApp.
--
-- La RPC sigue siendo `security invoker`: la RLS manda. La caja (que no pasa
-- `is_agent()`) puede enviar un presupuesto, pero su UPDATE sobre `contacts`
-- afecta 0 filas por RLS y el envío sigue sin error. Se acepta a propósito: la
-- caja factura, no edita clientes.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. Es
-- re-ejecutable (`create or replace`).
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): falla cerrado sin `psql -1`.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

create or replace function public.enviar_borrador_saint(
  p_origen text,
  p_origen_id uuid,
  p_cedula_tipo text,
  p_cedula_numero text,
  p_nombre text,
  p_apellido text,
  p_telefono text
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tipo text := upper(btrim(coalesce(p_cedula_tipo, '')));
  v_numero text := btrim(coalesce(p_cedula_numero, ''));
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_apellido text := btrim(coalesce(p_apellido, ''));
  v_telefono text := btrim(coalesce(p_telefono, ''));
  v_rows jsonb;
  v_n integer;
  v_lista text;
  v_codigo text;
  v_items jsonb;
  v_id uuid;
begin
  if p_origen is null or p_origen not in ('presupuesto', 'carrito') then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Origen inválido.';
  end if;

  if not public.can_read_inventory() then
    raise exception 'saint_sin_permiso' using errcode = '42501';
  end if;
  -- La caja no ve los chats: el carrito es de la conversación.
  if p_origen = 'carrito' and not public.is_agent() then
    raise exception 'saint_sin_permiso' using errcode = '42501';
  end if;

  if v_tipo not in ('V', 'E') then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Tipo de cédula inválido: solo V o E.';
  end if;
  if v_numero !~ '^[0-9]{5,10}$' or v_numero ~ '^0+$' then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Cédula inválida: use solo dígitos (5 a 10).';
  end if;
  if v_nombre = '' then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Falta el nombre del cliente.';
  end if;
  if v_apellido = '' then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Falta el apellido del cliente.';
  end if;
  -- 28/10/2026: el teléfono es opcional ('' se guarda tal cual); con contenido,
  -- sigue la misma regex y el mismo texto de siempre.
  if v_telefono <> '' and v_telefono !~ '^\+?[0-9]{7,19}$' then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Teléfono inválido.';
  end if;

  -- Renglones desde la base, con la RLS de quien llama: lo que no ve, no existe.
  if p_origen = 'presupuesto' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'nombre', p.name,
             'codigo', btrim(coalesce(p.saint_code, '')),
             'activo', p.is_active,
             'cantidad', pi.quantity,
             'creado', pi.created_at)), '[]'::jsonb)
      into v_rows
      from public.presupuesto_items pi
      join public.products p on p.id = pi.product_id
     where pi.presupuesto_id = p_origen_id;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'nombre', p.name,
             'codigo', btrim(coalesce(p.saint_code, '')),
             'activo', p.is_active,
             'cantidad', ci.quantity,
             'creado', ci.created_at)), '[]'::jsonb)
      into v_rows
      from public.conversation_cart_items ci
      join public.products p on p.id = ci.product_id
     where ci.conversation_id = p_origen_id;
  end if;

  if jsonb_array_length(v_rows) = 0 then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'El borrador no tiene artículos.';
  end if;

  select string_agg(distinct x.nombre, ', ' order by x.nombre)
    into v_lista
    from jsonb_to_recordset(v_rows) as x(nombre text, codigo text, activo boolean, cantidad integer, creado timestamptz)
   where x.codigo = '';
  if v_lista is not null then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Sin código SAINT: ' || v_lista || '.';
  end if;

  select string_agg(distinct x.nombre, ', ' order by x.nombre)
    into v_lista
    from jsonb_to_recordset(v_rows) as x(nombre text, codigo text, activo boolean, cantidad integer, creado timestamptz)
   where not x.activo;
  if v_lista is not null then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'Dados de baja en el inventario: ' || v_lista || '.';
  end if;

  -- Misma cantidad que el agente acepta por línea: entera, de 1 a 9999 POR CÓDIGO
  -- (dos productos del CRM pueden compartir el código SAINT y se suman).
  select min(g.codigo)
    into v_codigo
    from (
      select x.codigo, sum(x.cantidad::bigint) as suma
        from jsonb_to_recordset(v_rows) as x(nombre text, codigo text, activo boolean, cantidad integer, creado timestamptz)
       group by x.codigo
    ) g
   where g.suma > 9999 or g.suma < 1;
  if v_codigo is not null then
    raise exception 'saint_dato_invalido' using errcode = '22023',
      detail = 'Cantidad inválida en ' || v_codigo || ': debe ser un entero entre 1 y 9999.';
  end if;

  select jsonb_agg(jsonb_build_object('codprod', g.codigo, 'cantidad', g.suma) order by g.primero, g.codigo),
         count(*)
    into v_items, v_n
    from (
      select x.codigo, sum(x.cantidad)::integer as suma, min(x.creado) as primero
        from jsonb_to_recordset(v_rows) as x(nombre text, codigo text, activo boolean, cantidad integer, creado timestamptz)
       group by x.codigo
    ) g;
  if v_n > 100 then
    raise exception 'saint_dato_invalido' using errcode = '22023', detail = 'El borrador supera 100 líneas.';
  end if;

  -- 28/10/2026: lo tipeado en el formulario (nombre, apellido, cédula) queda en
  -- el contacto SIEMPRE: gana el último envío. Antes solo se completaba la
  -- cédula si faltaba y solo desde el carrito. El teléfono del contacto NUNCA se
  -- toca (es la llave de WhatsApp). Un presupuesto sin contacto (contact_id
  -- nulo) no actualiza nada. security invoker: la caja (no pasa is_agent()) no
  -- tiene permiso sobre `contacts`, su UPDATE afecta 0 filas por RLS y el envío
  -- sigue sin error; se acepta a propósito.
  update public.contacts
     set display_name = v_nombre || ' ' || v_apellido,
         cedula_type = v_tipo,
         cedula_number = v_numero
   where id = case p_origen
                when 'carrito' then (select c.contact_id from public.conversations c where c.id = p_origen_id)
                else (select pr.contact_id from public.presupuestos pr where pr.id = p_origen_id)
              end;

  -- El 23505 del índice de "un envío en curso por origen" sube tal cual.
  insert into liminal.saint_borradores (
    origen, origen_id, creado_por, cedula_tipo, cedula_numero, nombre, apellido, telefono, items
  ) values (
    p_origen, p_origen_id, auth.uid(), v_tipo, v_numero, v_nombre, v_apellido, v_telefono, v_items
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.enviar_borrador_saint(text, uuid, text, text, text, text, text) is
  'Encola un borrador hacia SAINT (plan "Enviar a SAINT", 25/10/2026; teléfono opcional y contacto actualizado el 28/10/2026): arma los renglones desde presupuesto_items o conversation_cart_items (agrupados por saint_code, sumando cantidades), valida con los textos del agente (el teléfono puede ir vacío y se guarda como cadena vacía) y guarda nombre, apellido y cédula tipeados en el contacto del origen (conversations.contact_id o presupuestos.contact_id) siempre, sin tocar su teléfono. security invoker: la RLS manda (la caja actualiza 0 filas de contacts y el envío sigue); el carrito exige is_agent() (la caja no ve chats). 23505 = ya hay un envío en curso de ese origen.';

revoke execute on function public.enviar_borrador_saint(text, uuid, text, text, text, text, text) from public;
revoke execute on function public.enviar_borrador_saint(text, uuid, text, text, text, text, text) from anon, authenticated;
grant execute on function public.enviar_borrador_saint(text, uuid, text, text, text, text, text) to authenticated, service_role;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
