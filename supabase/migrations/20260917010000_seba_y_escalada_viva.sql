-- ============================================================================
-- T0 · "Seba atiende el mostrador" (docs/planes/2026-09-17-seba-atiende-el-
-- mostrador.md, APROBADO 18/9/2026)
--
-- Esta migración prepara la base para dos piezas del plan que todavía no
-- tienen código (T2b y T4, tandas 2/3 de la misma corrida), para que el
-- orden de entrega sea siempre migración → código:
--
--   1. Hallazgo 4 del plan: `welcome_sent_at` deja de significar "última vez
--      que se mandó LA PLANTILLA de bienvenida" (semántica de
--      20260819030000, muerta en la práctica porque
--      `WHATSAPP_WELCOME_TEMPLATE` está vacía desde siempre) y pasa a ser el
--      sello de "Seba ya se presentó en esta conversación" (R1/D1 del plan:
--      el saludo estricto que pide el cliente lo manda el CÓDIGO como
--      mensaje propio, y `welcome_sent_at IS NULL` es la condición que ese
--      código usará -- T2b, todavía sin implementar -- para decidir si
--      saluda). El backfill de acá abajo sella con lo que YA hay: un chat
--      del backlog que alguna vez recibió una respuesta real (`has_reply`,
--      vitalicio) no tiene que volver a escuchar la presentación; uno que
--      jamás recibió nada sí, porque es de verdad lo primero que le
--      llegaría.
--
--   2. Hallazgo 1 del plan: con D2 (la escalada deja la IA ENCENDIDA, sigue
--      contestando hasta que el asesor escriba -- requisito 6 del cliente),
--      `escalate.ts` (T4, todavía sin implementar) va a cambiar SOLO
--      `assigned_agent_id`, sin tocar `ai_enabled`. Eso calza EXACTO con la
--      condición que hoy dispara la rama `reclamado` de
--      `handle_conversation_ownership_change()` (20260916010000): "el
--      asesor asignado cambió sin que `ai_enabled` cambiara en el mismo
--      UPDATE". Sin la guarda que agrega esta migración, CADA escalada
--      dejaría una fila `reclamado` espuria antes de su propia fila
--      `escalada` (que sigue escribiéndola TypeScript aparte) -- y el caso 1
--      de `tests/devolucion_a_la_ia.sql` ("escalada simulada no deja
--      fila") se pondría rojo apenas T4 saliera. La corrección: la rama
--      `reclamado` exige además `auth.uid() is not null`. La escalada corre
--      con `service_role` (sin sesión de un asesor real -- ver CLAUDE.md,
--      "código de servidor no es sinónimo de service_role"), así que
--      `auth.uid()` da `null` y la rama no dispara; un asesor reclamando de
--      verdad desde el panel SÍ trae sesión.
--
--   3. Requisito 6 del cliente, la otra mitad: "en el instante en que el
--      asesor manda su primer mensaje, la IA se calla en ese chat". Hasta
--      hoy `ai_enabled=false` solo lo escribe `escalate.ts` (a punto de
--      dejar de hacerlo, ver 2) o `setAiEnabled(false)` de `mutations.ts`
--      (la pausa manual del botón, que hoy NO deja ninguna fila en
--      `conversation_handoffs`). Nuevo trigger `AFTER INSERT ON messages`
--      (`handle_agent_message_silences_ai()`): apaga la IA en cuanto un
--      asesor manda un mensaje REAL al cliente (`sender_type = 'agent'`,
--      saliente, que no sea una nota interna). Es atómico con el insert (el
--      route que manda el mensaje solo espera esa transacción, no una
--      segunda escritura desde TypeScript que podría quedar a medias) y
--      cubre cualquier vía que algún día escriba `sender_type = 'agent'`,
--      no solo la de hoy (`api/messages/send`).
--
-- Los dos caminos que apagan `ai_enabled` --el trigger nuevo y la pausa
-- manual, que hoy tampoco deja rastro-- comparten una única rama nueva en
-- `handle_conversation_ownership_change()`: `silenciada_por_asesor`. El
-- `to_kind` lo calcula la misma función que ya lo calculaba (`human` si
-- queda asignada, `unassigned` si no, `closed` si está cerrada): un
-- supervisor que pausa la IA a mano en un chat sin asesor deja ese chat
-- esperando a una PERSONA, no a la IA que él mismo acaba de silenciar, así
-- que tiene que verse en "Sin dueño" -- misma invariante de siempre.
--
-- `silenciada_por_asesor` SÍ cierra una escalada abierta para
-- `escalationOpen()` (`handoffs.ts`): un humano tomó el chat de verdad. Esa
-- constante (`RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`) es código -- T4 la toca,
-- no esta migración.
--
-- `handle_conversation_ownership_change()` no es `security definer` NUEVA
-- acá: ya lo era desde 20260916010000 y esta migración solo la reemplaza
-- con `create or replace function`, que conserva el ACL (los dos revokes ya
-- viven en esa migración) -- por eso esta migración no repite `revoke`
-- sobre ella. La función nueva (`handle_agent_message_silences_ai`) sí es
-- `security definer` NUEVA y nace con los dos revokes de siempre, sin
-- grant: es una función de trigger, Postgres no comprueba EXECUTE del rol
-- que dispara la operación al ejecutar un trigger (mismo criterio que
-- `enforce_conversation_pins_limit`/`handle_new_message`).
--
-- ESTA MIGRACIÓN TIENE QUE APLICARSE DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- por el mismo motivo que 20260916010000:
-- `set local lock_timeout` fuera de una transacción es un NO-OP silencioso,
-- y sin `ON_ERROR_STOP=1` una sentencia de en medio que falle no tumba el
-- resto del archivo, dejando el esquema a medias (p. ej. el CHECK ampliado
-- sin el trigger que lo usa, o al revés).
--
-- `begin;`/`commit;` EXPLÍCITOS (revisión "El resguardo antes del push",
-- tarea C5, 20/9/2026, hallazgo B): hasta esta corrida el archivo confiaba
-- en que QUIEN LO APLICA lo envuelva en una transacción (`psql -1`).
-- `npx supabase db reset` -- el método que este mismo repo usa para
-- reconstruir la base en cada verificación, y el del job `migraciones` del
-- CI -- SÍ aplica cada migración de forma atómica (sondeado el 20/9/2026
-- por el orquestador: una migración de prueba `create table …; select
-- 1/0;` falla y la tabla NO queda), pero lo hace con una transacción
-- IMPLÍCITA del protocolo (un lote sin `BEGIN`), no con un BLOQUE de
-- transacción. Para `set local lock_timeout` alcanza -- por eso la guarda
-- de más abajo nunca disparó ahí, no fue casualidad --; para `lock table`
-- (hallazgo B, la sección de más abajo) NO: Postgres exige un bloque
-- explícito y con ese applier fallaba con "LOCK TABLE can only be used in
-- transaction blocks", incluso en un archivo mínimo de prueba --
-- reproducido a mano el 20/9/2026. El `begin;` de acá abajo (y el
-- `commit;` al final del archivo, después del `notify pgrst`) abren ese
-- bloque DENTRO del archivo, sin depender de quién lo aplique. Efecto
-- colateral aceptado: aplicado sin `-1`, la guarda "abortar si no hay
-- transacción" de más abajo ya no dispara nunca (el archivo trae la suya),
-- que es el lado seguro. Aplicado con `psql -1` (el método
-- que sigue pidiendo docs/PRODUCCION.md §11) produce dos WARNING
-- inofensivos ("there is already a transaction in progress" al llegar a
-- este `begin;`, "there is no transaction in progress" cuando `-1` intenta
-- cerrar una transacción que el `commit;` de acá ya cerró) -- el mismo
-- patrón, ya documentado, de `scripts/sql/2026-09-18-catalogos-iniciales.sql`
-- -- y aplicado con `npx supabase db reset` (o cualquier `psql -f` sin
-- `-1`) queda igual de atómico porque el `begin`/`commit` viajan DENTRO
-- del propio archivo, no dependen de un flag externo.
-- ============================================================================
begin;

set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` -- mismo motivo y misma
-- verificación que 20260916010000 (hallazgo 10, revisión `/code-review
-- high` del 19/9/2026): sin `psql -1` esto corre con `lock_timeout = 0`
-- sin que `ON_ERROR_STOP` lo note (un warning, no un error), así que falla
-- cerrado acá. `PGOPTIONS="-c lock_timeout=5s"` sin `-1` también pasa: hay
-- un tope real, no es el no-op.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Guarda de prerrequisito (hallazgo J, revisión "El resguardo antes del
-- push", tarea C5, 20/9/2026): esta migración hace `create or replace
-- function public.handle_conversation_ownership_change()` -- REPLACE, no
-- creación nueva -- porque asume que 20260916010000 ya la creó (con sus dos
-- revokes ya puestos, que un `create or replace` conserva). Si alguien
-- aplica esta migración SIN haber aplicado antes 20260916010000, el
-- `create or replace` la CREA de cero igual (Postgres no distingue "crear"
-- de "reemplazar lo que no existía"): queda sin los dos revokes de esa
-- migración, el trigger `messages_agent_silences_ai_trigger` de la sección 4
-- de acá abajo apaga la IA sin que `handle_conversation_ownership_change`
-- deje ninguna fila en `conversation_handoffs` (la columna
-- `new_since_ai_resume` que esa función lee en su rama `unassigned` ni
-- siquiera existe todavía), y la autoverificación de ESTA migración pasa
-- igual (mira su propio CHECK/trigger, no las columnas de la otra). El
-- reventón real llega recién cuando alguien aplica 20260916010000 después:
-- su propio `create function` (sin `or replace`) revienta con "function
-- already exists". Se detecta acá, temprano y con mensaje explícito, en vez
-- de descubrirlo con una IA muda sin rastro o con la migración anterior
-- rota.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.handle_conversation_ai_resume()') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'conversations'
        and column_name = 'ai_resume_cutoff_at'
    )
  then
    raise exception '20260917010000: falta 20260916010000 (handle_conversation_ai_resume()/conversations.ai_resume_cutoff_at no existen) -- aplicar esa migración primero.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Candados de TABLA por adelantado (hallazgo B, revisión "El resguardo antes
-- del push", tarea C5, 20/9/2026) -- interbloqueo real, reproducido contra
-- la base local con 30.000 conversaciones candidatas al backfill y 20
-- conexiones concurrentes insertando en `messages` (el mismo shape que el
-- webhook, route.ts ~1358) durante toda la aplicación de esta migración:
--
--   Proceso 1772 (esta migración) espera AccessExclusiveLock sobre
--   `messages`; bloqueado por el proceso 1837 (un INSERT del generador).
--   Proceso 1837 espera ShareLock sobre la transacción 1852 (esta
--   migración); bloqueado por el proceso 1772.
--   ERROR: deadlock detected (en la sentencia `drop trigger ... on
--   public.messages`, sección 4 de acá abajo).
--
-- La causa: el backfill de más abajo (sección 1) toma candados de FILA
-- (FOR NO KEY UPDATE, implícitos en el UPDATE) sobre las conversaciones que
-- toca y los retiene hasta el COMMIT -- no hasta que el UPDATE termine.
-- Un webhook que inserta un mensaje entrante para UNA DE ESAS
-- conversaciones toma ROW EXCLUSIVE sobre `messages` (para su propio
-- INSERT) y después, en su trigger AFTER `handle_new_message()`, intenta
-- actualizar esa fila de `conversations` -- y se queda esperando el
-- candado que esta migración ya tiene. Mientras tanto, esta migración sigue
-- de largo por el resto del archivo y, más abajo, pide ACCESS EXCLUSIVE
-- sobre `messages` para el `drop trigger`/`create trigger` de la sección 4
-- -- y ahí se topa con el ROW EXCLUSIVE que el webhook ya tiene sobre esa
-- misma tabla. Ninguno de los dos puede seguir: interbloqueo.
--
-- El arreglo no es dejar de tomar los candados de fila del backfill (es
-- inherente a cualquier UPDATE fila por fila: sin él no se puede sellar
-- `welcome_sent_at` con el valor de cada conversación) sino invertir el
-- ORDEN en que esta transacción pide sus candados de TABLA: tomar el de
-- `messages` ACÁ, ANTES de tocar una sola fila de `conversations`, para que
-- un INSERT entrante quede esperando SIN HABER TOMADO NADA TODAVÍA -- así
-- no puede completar su parte del ciclo. `SHARE ROW EXCLUSIVE` (no
-- `ACCESS EXCLUSIVE`) porque solo hace falta bloquear ESCRITURAS
-- (INSERT/UPDATE piden ROW EXCLUSIVE, que sí choca con SHARE ROW EXCLUSIVE):
-- un candado más fuerte bloquearía también las LECTURAS de la bandeja
-- (SELECT sobre `messages`, que solo pide ACCESS SHARE y no choca con
-- SHARE ROW EXCLUSIVE). El `drop trigger`/`create trigger` de la sección 4,
-- más abajo, van a pedir ACCESS EXCLUSIVE sobre esta misma tabla -- eso es
-- una escalada del candado DENTRO de la misma sesión/transacción, que
-- Postgres concede sin esperar a nadie más (nadie más puede tener nada
-- sobre `messages` a esta altura: el SHARE ROW EXCLUSIVE de acá ya excluye
-- cualquier ROW EXCLUSIVE/SHARE/EXCLUSIVE nuevo desde el momento en que se
-- concede).
--
-- El mismo patrón backfill-antes-que-ALTER se repite con
-- `conversation_handoffs` (sección 2, más abajo): un `record_handoff(...)`
-- en vuelo (reconciler.ts/mutations.ts, el mismo camino que el gemelo de
-- 20260916010000) sobre una conversación que el backfill ya bloqueó toma
-- ROW EXCLUSIVE sobre `conversation_handoffs` y se queda esperando esa fila
-- de `conversations`; si eso ocurre justo cuando esta migración llega al
-- `alter table conversation_handoffs drop constraint` de la sección 2,
-- forma el mismo ciclo. Se cierra con el mismo remedio, en el mismo orden
-- (alfabético, para que dos migraciones que necesiten las dos tablas las
-- pidan siempre igual y no puedan interbloquearse ENTRE ellas): primero
-- `conversation_handoffs`, después `messages`.
--
-- Verificado el 20/9/2026 (misma tarea, con el archivo ya en su forma FINAL
-- -- incluido el `begin;`/`commit;` explícito de la cabecera): 3 corridas
-- seguidas contra el mismo escenario de carga (30.000 conversaciones
-- candidatas al backfill, 20 conexiones concurrentes insertando en
-- `messages` durante TODA la aplicación, vía `psql -1 -v ON_ERROR_STOP=1`)
-- terminaron con RC=0, sin ningún deadlock, y con el 100% de los INSERT
-- del generador confirmados en `messages` al final (conteo exacto contra
-- la base, sin pérdidas, en las 3 corridas: 47/47, 62/62, 44/44). El costo
-- medido -- el tiempo que el generador quedó bloqueado, de punta a punta
-- de la migración -- fue 6,2 s / 15,6 s / 7,7 s según cuántas filas tocó
-- el backfill en cada corrida; aceptable fuera de hora pico. Ver
-- docs/PRODUCCION.md §11 para la nota operativa de cuánto retiene al
-- webhook en producción real.
-- ---------------------------------------------------------------------------
lock table public.conversation_handoffs in share row exclusive mode;
lock table public.messages in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. Backfill de `welcome_sent_at` (hallazgo 4). Mismo criterio que
--    `has_reply`: un chat que alguna vez recibió una respuesta real (IA,
--    asesor o la bienvenida automática -- `has_reply` es vitalicio, ver
--    CLAUDE.md) ya no tiene "primer mensaje" por delante, así que se sella
--    con lo último que de verdad salió (`last_reply_at`), o si eso faltara
--    con `last_message_at`, o si tampoco eso con `created_at` -- nunca
--    `now()`: sellar con el reloj de esta migración inventaría una
--    presentación que nunca ocurrió. Un chat que JAMÁS recibió nada queda
--    con `welcome_sent_at` en `null` a propósito: la próxima vez que hable
--    con ese cliente será, literalmente, la primera, y Seba se presenta de
--    verdad.
-- ---------------------------------------------------------------------------
update public.conversations
set welcome_sent_at = coalesce(last_reply_at, last_message_at, created_at)
where welcome_sent_at is null and has_reply;

comment on column public.conversations.welcome_sent_at is
  'Sello de que Seba se presentó en esta conversación (requisito 1 del cliente, plan "Seba atiende el mostrador", 18/9/2026): null = todavía no, así que el turno manda el saludo literal como mensaje propio antes de redactar nada (T2b, código, misma corrida -- sin implementar al escribir esta migración). Reemplaza la semántica vieja de 20260819030000 ("última vez que se mandó la plantilla de bienvenida de WhatsApp"), que en la práctica nunca se usó: WHATSAPP_WELCOME_TEMPLATE está vacía desde siempre y esa columna jamás se selló por esa vía. El backfill de esta migración sella con COALESCE(last_reply_at, last_message_at, created_at) -- nunca now() -- todo chat que alguna vez tuvo una respuesta real (has_reply, vitalicio); un chat que nunca recibió nada queda en null y Seba se presenta la próxima vez que hable con ese cliente. El webhook (T2b) la vuelve a poner en null al reabrir una conversación cerrada: el chat arranca de cero.';

-- ---------------------------------------------------------------------------
-- 2. `conversation_handoffs.reason` -- copia completa de los 27 valores
--    vigentes en 20260916010000 (líneas 190-220 de esa migración) más
--    `silenciada_por_asesor`: un asesor manda su primer mensaje real
--    (`handle_agent_message_silences_ai`, sección 4) o alguien pausa la IA
--    a mano (`setAiEnabled(false)`, `mutations.ts`) -- los dos casos que
--    hoy apagan `ai_enabled = false` sin dejar ninguna fila en la bitácora.
-- ---------------------------------------------------------------------------
alter table public.conversation_handoffs
  drop constraint conversation_handoffs_reason_check;

alter table public.conversation_handoffs
  add constraint conversation_handoffs_reason_check
  check (reason in (
    'agente_no_puede_correr',
    'conversacion_inexistente',
    'pausada',
    'asignada',
    'humano_intervino',
    'humano_se_adelanto',
    'fuera_de_ventana',
    'identidad_no_verificable',
    'lock_perdido',
    'abandonado',
    'entrega_fallida',
    'reabierto',
    'escalado_por_ia',
    'reclamado',
    'devuelto_a_ia',
    'cerrado',
    'ventana_vencida',
    'sla_vencido',
    'escalada',
    'escalada_sin_asesor',
    'rechazado_por_meta',
    'cerrada_por_asesor',
    'reabierta_por_asesor',
    'reabierta_por_cliente',
    'sin_contenido_legible',
    'cortesia_tras_escalada',
    'desasignada_por_asesor',
    'mensaje_previo_a_devolucion',
    -- T0, "Seba atiende el mostrador" (18/9/2026): un asesor manda su primer
    -- mensaje real, o alguien pausa la IA a mano -- los dos casos que apagan
    -- ai_enabled sin dejar rastro hasta hoy.
    'silenciada_por_asesor',
    -- "El resguardo antes del push" (20/9/2026, tarea C6): a la segunda
    -- insistencia fuera de tema el turno se calla; hasta hoy lo hacía SIN
    -- traspaso (viola "ningún lead invisible") y el reconciliador lo
    -- reencolaba cada minuto, pagando fase 0 y clasificación en cada vuelta.
    -- Sin este valor acá, el INSERT de `recordHandoff` fallaría en silencio
    -- contra la base -- la misma trampa de `fuera_de_tema` del 14/9/2026.
    'fuera_de_tema_repetido'
  ));

comment on column public.conversation_handoffs.reason is
  'Por qué ocurrió el traspaso. Lista cerrada por CHECK (no enum, a propósito: ver 20260830040000). T2.1 (5/9/2026) sumó cerrada_por_asesor/reabierta_por_asesor/reabierta_por_cliente; "La IA ve lo que llega" (8/9/2026) sumó sin_contenido_legible; "La voz cercana y la espera visible" (14/9/2026) sumó cortesia_tras_escalada; "La IA no vuelve a pedir lo que ya pidió" (16/9/2026) sumó desasignada_por_asesor/mensaje_previo_a_devolucion; "Seba atiende el mostrador" (18/9/2026, T0) suma silenciada_por_asesor: un asesor manda su primer mensaje real al cliente (handle_agent_message_silences_ai) o alguien pausa la IA a mano (setAiEnabled(false), mutations.ts) -- los dos únicos caminos que apagan ai_enabled sin que ninguna fila lo cuente hasta esta migración. SÍ cierra una escalada abierta para escalationOpen() (handoffs.ts): un humano tomó el chat de verdad.';

-- ---------------------------------------------------------------------------
-- 3. `handle_conversation_ownership_change()` -- `create or replace`, no
--    creación nueva: conserva el ACL que ya le dio 20260916010000 (los dos
--    revokes), por eso esta sección no repite ningún `revoke`. Dos cambios
--    sobre la versión anterior:
--
--    a) La rama `reclamado` gana `and auth.uid() is not null` (hallazgo 1):
--       sin sesión de un asesor real, "el asesor asignado cambió sin que
--       ai_enabled cambiara" también es exactamente lo que hará la
--       escalada de T4 (cambiar SOLO assigned_agent_id, con service_role,
--       sin sesión) -- sin esta guarda cada escalada dejaría una fila
--       `reclamado` espuria antes de su propia fila `escalada`.
--
--    b) Rama nueva `silenciada_por_asesor`: `old.ai_enabled and not
--       new.ai_enabled and old.assigned_agent_id is not distinct from
--       new.assigned_agent_id` -- ai_enabled se apagó en este UPDATE SIN
--       que `assigned_agent_id` cambiara en el mismo UPDATE. `to_kind` es
--       el mismo `v_to_kind` que ya se calculaba antes de las cuatro
--       ramas: `human` si queda asignada, `unassigned` si no (el cliente
--       sigue esperando a una PERSONA, no a la IA que alguien acaba de
--       silenciar), `closed` si está cerrada.
--
--       El `and old.assigned_agent_id is not distinct from
--       new.assigned_agent_id` se agregó DESPUÉS de la primera versión de
--       esta migración, al correr `tests/devolucion_a_la_ia.sql` contra
--       ella: la escalada de HOY (`escalate.ts`, todavía sin tocar por
--       T4) sigue cambiando `ai_enabled` y `assigned_agent_id` JUNTOS en
--       un solo UPDATE, y sin esta guarda ese UPDATE calzaba también con
--       `silenciada_por_asesor` -- una fila espuria en cada escalada de
--       hoy, y el caso 1 de ese test ("escalada simulada no deja fila")
--       se puso en rojo. Los dos casos reales que esta rama existe para
--       cubrir (el trigger de mensajes de la sección 4, y
--       `setAiEnabled(false)` de `mutations.ts`) nunca tocan
--       `assigned_agent_id` en el mismo UPDATE, así que la guarda no les
--       quita nada.
--
--    Puede coexistir con `desasignada_por_asesor` en el mismo UPDATE (un
--    panel que desasigne Y apague la IA de una sola llamada) exactamente
--    igual que ya podían coexistir `desasignada_por_asesor` y
--    `devuelto_a_ia` (caso 4 de `tests/devolucion_a_la_ia.sql`): cada rama
--    mira solo su propio par de columnas, así que insertan sus propias
--    filas sin pisarse.
-- ---------------------------------------------------------------------------
create or replace function public.handle_conversation_ownership_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_to_kind text;
  v_created_by text;
begin
  if new.status = 'closed' then
    v_to_kind := 'closed';
  elsif new.assigned_agent_id is not null then
    v_to_kind := 'human';
  elsif not new.ai_enabled or (new.awaiting_reply and not new.new_since_ai_resume) then
    v_to_kind := 'unassigned';
  else
    v_to_kind := 'ai';
  end if;

  v_created_by := case when auth.uid() is not null then 'user' else 'system' end;

  -- Un asesor suelta el caso.
  if old.assigned_agent_id is not null and new.assigned_agent_id is null then
    insert into public.conversation_handoffs
      (conversation_id, from_kind, from_id, to_kind, to_id, reason, created_by)
    values (
      new.id,
      'human',
      old.assigned_agent_id,
      v_to_kind,
      new.assigned_agent_id,
      'desasignada_por_asesor',
      v_created_by
    );
  end if;

  -- La IA vuelve a encenderse.
  if old.ai_enabled = false and new.ai_enabled = true then
    insert into public.conversation_handoffs
      (conversation_id, to_kind, to_id, reason, created_by)
    values (new.id, v_to_kind, new.assigned_agent_id, 'devuelto_a_ia', v_created_by);
  end if;

  -- Un asesor reclama el caso (lo toma sin tenerlo, o se lo saca a otro
  -- asesor) sin que ai_enabled cambie en el mismo UPDATE, Y con sesión real
  -- de un asesor -- T0, "Seba atiende el mostrador" (18/9/2026): sin el
  -- `auth.uid() is not null`, la escalada de T4 (cambia SOLO
  -- assigned_agent_id, con service_role, sin sesión) calzaría esta misma
  -- condición y dejaría una fila `reclamado` espuria antes de su propia
  -- fila `escalada`.
  if new.assigned_agent_id is not null
    and old.assigned_agent_id is distinct from new.assigned_agent_id
    and old.ai_enabled = new.ai_enabled
    and auth.uid() is not null
  then
    insert into public.conversation_handoffs
      (conversation_id, from_kind, from_id, to_kind, to_id, reason, created_by)
    values (
      new.id,
      case
        when old.assigned_agent_id is not null then 'human'
        when old.ai_enabled then 'ai'
        else 'unassigned'
      end,
      old.assigned_agent_id,
      v_to_kind,
      new.assigned_agent_id,
      'reclamado',
      v_created_by
    );
  end if;

  -- Alguien apaga la IA en este chat SIN reasignarla en el mismo UPDATE --
  -- T0, "Seba atiende el mostrador" (18/9/2026): el trigger
  -- messages_agent_silences_ai_trigger (sección 4, más abajo) cuando un
  -- asesor manda su primer mensaje real, o setAiEnabled(false)
  -- (mutations.ts) cuando alguien pausa la IA a mano. Los dos caminos
  -- apagaban ai_enabled sin dejar ninguna fila hasta esta migración. La
  -- guarda `old.assigned_agent_id is not distinct from
  -- new.assigned_agent_id` excluye a la escalada de HOY (que todavía
  -- cambia assigned_agent_id y ai_enabled juntos, hasta que T4 la
  -- reforme): esa transición ya la cuenta su propia fila `escalada`,
  -- escrita aparte por TypeScript.
  if old.ai_enabled = true
    and new.ai_enabled = false
    and old.assigned_agent_id is not distinct from new.assigned_agent_id
  then
    insert into public.conversation_handoffs
      (conversation_id, from_kind, from_id, to_kind, to_id, reason, created_by)
    values (
      new.id,
      case when old.assigned_agent_id is not null then 'human' else 'ai' end,
      old.assigned_agent_id,
      v_to_kind,
      new.assigned_agent_id,
      'silenciada_por_asesor',
      v_created_by
    );
  end if;

  return new;
end;
$$;

comment on function public.handle_conversation_ownership_change is
  'Deja rastro en conversation_handoffs cuando un asesor desasigna una conversación, la IA se reactiva, un asesor reclama un caso, o alguien apaga la IA en este chat (mensaje real de un asesor o pausa manual) -- los movimientos de dueño que mutations.ts hace sin escribir bitácora. security definer para saltarse la RLS de conversation_handoffs (solo service_role inserta ahí). to_kind se calcula una sola vez para todas las filas del mismo UPDATE: closed si la conversación está cerrada, unassigned si la IA quedó apagada o si queda un mensaje del cliente anterior a la devolución sin atender, human si sigue asignada, ai en cualquier otro caso. reclamado (16/9/2026, ampliado 18/9/2026) dispara cuando assigned_agent_id cambia a un valor no nulo sin que ai_enabled cambie a la vez Y con sesión real de un asesor (auth.uid() is not null) -- eso excluye tanto a la escalada de hoy (que cambia las dos columnas juntas) como a la de T4 (que corre con service_role, sin sesión). silenciada_por_asesor (18/9/2026) dispara cuando ai_enabled pasa de true a false SIN que assigned_agent_id cambie en el mismo UPDATE -- esa guarda excluye a la escalada de hoy, que todavía cambia las dos columnas juntas y ya deja su propia fila escalada, escrita aparte por TypeScript.';

-- ---------------------------------------------------------------------------
-- 4. `handle_agent_message_silences_ai()` -- requisito 6 del cliente, la
--    mitad que faltaba: "en el instante en que el asesor manda su primer
--    mensaje, la IA se calla en ese chat". `security definer` para poder
--    escribir en `conversations` sin depender de qué rol haya insertado el
--    mensaje (hoy siempre `authenticated` desde `api/messages/send`, pero
--    `human-handled.ts` ya advierte que eso puede cambiar -- CLAUDE.md).
--    Dispara DESPUÉS del insert (no antes: necesita `new.conversation_id`
--    ya resuelto) y el UPDATE que hace es atómico con esa misma
--    transacción -- ni el route ni ningún otro código tienen que acordarse
--    de apagar la IA por su cuenta.
--
--    `WHERE ... AND ai_enabled` de guarda: si la IA ya estaba apagada (un
--    segundo mensaje del mismo asesor, o alguien ya la había pausado a
--    mano) el UPDATE no toca ninguna fila y el trigger de dueño no dispara
--    -- sin esto, un WHEN "de más" en handle_conversation_ownership_change
--    escribiría una segunda fila silenciada_por_asesor cada vez que el
--    asesor siguiera escribiendo.
-- ---------------------------------------------------------------------------
create function public.handle_agent_message_silences_ai()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.conversations
  set ai_enabled = false
  where id = new.conversation_id
    and ai_enabled;

  return new;
end;
$$;

comment on function public.handle_agent_message_silences_ai is
  'Apaga conversations.ai_enabled en cuanto un asesor manda un mensaje real al cliente (sender_type=agent, saliente, que no sea nota interna) -- requisito 6 del cliente ("en el instante en que el asesor manda su primer mensaje, la IA se calla en ese chat"), plan "Seba atiende el mostrador" (18/9/2026). El UPDATE es atómico con el INSERT que lo dispara y deja rastro vía handle_conversation_ownership_change (reason=silenciada_por_asesor). El WHERE ... AND ai_enabled evita un UPDATE (y una fila de bitácora) por cada mensaje siguiente del mismo asesor.';

revoke execute on function public.handle_agent_message_silences_ai() from public;
revoke execute on function public.handle_agent_message_silences_ai() from anon, authenticated;

drop trigger if exists messages_agent_silences_ai_trigger on public.messages;

create trigger messages_agent_silences_ai_trigger
  after insert on public.messages
  for each row
  when (
    new.sender_type = 'agent'
    and not new.is_internal_note
    and new.direction = 'outbound'
  )
  execute function public.handle_agent_message_silences_ai();

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real (pg_constraint/pg_trigger/
-- has_function_privilege), no el texto de este archivo -- mismo criterio que
-- 20260914010000/20260916010000 (ver CLAUDE.md, "Cerrar una función
-- security definer...").
-- ---------------------------------------------------------------------------
do $$
declare
  def_reason text;
  trg_count integer;
begin
  select pg_get_constraintdef(oid) into def_reason
    from pg_constraint
    where conrelid = 'public.conversation_handoffs'::regclass
      and conname = 'conversation_handoffs_reason_check';

  if def_reason is null or def_reason not like '%silenciada_por_asesor%' then
    raise exception '20260917010000: conversation_handoffs_reason_check no quedó con silenciada_por_asesor (definición: %)', def_reason;
  end if;

  if def_reason not like '%fuera_de_tema_repetido%' then
    raise exception '20260917010000: conversation_handoffs_reason_check no quedó con fuera_de_tema_repetido (definición: %)', def_reason;
  end if;

  select count(*) into trg_count
    from pg_trigger
    where tgrelid = 'public.messages'::regclass
      and tgname = 'messages_agent_silences_ai_trigger'
      and not tgisinternal;

  if trg_count is distinct from 1 then
    raise exception '20260917010000: messages_agent_silences_ai_trigger no quedó creado (encontrados: %)', trg_count;
  end if;

  if has_function_privilege('anon', 'public.handle_agent_message_silences_ai()', 'execute') then
    raise exception '20260917010000: anon puede ejecutar handle_agent_message_silences_ai()';
  end if;

  if has_function_privilege('authenticated', 'public.handle_agent_message_silences_ai()', 'execute') then
    raise exception '20260917010000: authenticated puede ejecutar handle_agent_message_silences_ai()';
  end if;

  raise notice '20260917010000: autoverificación del CHECK ampliado, el trigger de silencio y sus permisos, correcta.';
end $$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y el CHECK/trigger
-- nuevos dan 400 hasta que alguien lo recargue a mano -- revisión "Seba sale
-- sin pisar a nadie" (19/9/2026, tarea T5, hallazgo M1: ninguna de las cinco
-- migraciones de esta corrida lo traía).
notify pgrst, 'reload schema';

-- Cierra el `begin;` explícito de la cabecera (hallazgo B, tarea C5,
-- 20/9/2026) -- ver el comentario de arriba de todo el archivo para el
-- porqué. NOTIFY entrega su aviso a los LISTENers recién al COMMIT de la
-- transacción que lo emitió -- comportamiento normal de Postgres, no un
-- efecto de este cambio -- así que ponerlo antes de este `commit;` es
-- exactamente donde tiene que estar.
commit;
