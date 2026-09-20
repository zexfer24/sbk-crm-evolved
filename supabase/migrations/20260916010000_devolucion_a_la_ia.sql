-- ============================================================================
-- Tarea 1 · "La IA solo atiende lo que llegó después de que se la
-- devolvieron" -- plan "La IA no vuelve a pedir lo que ya pidió", revisión
-- del 16/9/2026.
--
-- El caso reportado: un cliente pide un asesor, la IA escala y se despide
-- ("te paso con un asesor", is_auto_reply=true para no apagar
-- awaiting_reply). Un asesor DESASIGNA la conversación y REACTIVA la IA a
-- mano. En menos de un minuto el reconciliador la reencola, y la IA repite
-- la misma promesa sobre el MISMO mensaje viejo -- el mecanismo que el
-- 13/9/2026 volvió a escalar 63 casos.
--
-- Esta migración reemplaza a 20260915020000 (commit 56fa2df, deshecho con
-- `git reset --soft`, nunca salió de esta máquina). Ese diseño -- una
-- columna `awaiting_any_reply` que preguntaba "¿salió algo después del
-- último mensaje del cliente?" comparando contra `last_message_at` -- medía
-- la pregunta equivocada. La validación y la revisión adversarial del
-- 15-16/9 le encontraron cinco fallas:
--
--   1. Envíos fallidos: `send.ts` inserta la fila también cuando Meta
--      rechaza el envío, esa fila adelanta `last_message_at` igual, y el
--      reconciliador dejaba de reintentar `entrega_fallida`.
--   2. Carrera de ráfaga: el cliente escribe mientras la IA redacta, la
--      respuesta queda con fecha posterior a ese mensaje, la guarda del
--      turno siguiente lo calla, y el mensaje sale de Pendientes sin
--      respuesta.
--   3. Bienvenida: la plantilla se inserta justo después del primer mensaje
--      del cliente. Con esa guarda, la IA callaría el primer turno de cada
--      lead nuevo.
--   4. "Sin dueño": la fila `devuelto_a_ia` iba siempre a `'ai'`, así que un
--      cliente con una promesa pendiente salía de "Sin dueño".
--   5. El cliente escribe mientras espera al asesor: con la IA apagada por
--      la escalada, el webhook encola igual y el turno sale por `pausada`
--      -- queda un mensaje del cliente POSTERIOR a la despedida. Cualquier
--      reloj basado en "última salida" lo ve como pendiente al devolver el
--      chat, y la IA contesta un mensaje anterior a la devolución.
--
-- El enfoque nuevo no mira salidas: mira el MOMENTO de la devolución. La
-- IA solo atiende mensajes del cliente posteriores a la última vez que un
-- humano le devolvió el chat -- un sello que un trigger BEFORE UPDATE
-- escribe al ENTRAR al estado "la IA gobierna sin asesor", copiando
-- `last_customer_message_at` de ese instante (nunca `now()`: `created_at`
-- de un entrante es la marca de tiempo de Meta -- ver
-- src/app/api/webhooks/whatsapp/route.ts:1343 --, así que un mensaje
-- enviado un segundo antes de la devolución pero ENTREGADO después
-- quedaría detrás de `now()`; contra el último mensaje ya conocido en ese
-- instante, cualquier mensaje que llegue después queda por delante del
-- sello sin necesitar tolerancia de reloj). No sufre la falla 1 (nada mira
-- salidas), ni la 2 (el sello no se mueve con una salida, solo con una
-- devolución), ni la 3 (la bienvenida no toca `ai_enabled`/
-- `assigned_agent_id`), y las fallas 4 y 5 las resuelve el traspaso de la
-- Tarea 3 (código, no esta migración) leyendo la columna generada de acá.
--
-- Nombre nuevo (20260916010000 en vez de reformar 20260915020000): una base
-- que ya hubiera registrado la versión vieja no se saltaría la corregida
-- sin avisar -- en la práctica esta migración vieja nunca llegó a
-- aplicarse en ningún entorno compartido, pero el nombre nuevo documenta
-- que el diseño cambió de raíz, no que se corrigió un detalle.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. `lock_timeout` corto: agregar una columna GENERADA reescribe la tabla
--    entera con un lock ACCESS EXCLUSIVE (a diferencia de una columna común
--    con default, que desde PG11 es solo metadato). `conversations` es la
--    tabla del camino caliente de cada mensaje de WhatsApp -- mejor que la
--    migración falle y se reintente a que un ACCESS EXCLUSIVE prolongado
--    encole detrás suyo a los webhooks entrantes.
--
--    ESTA MIGRACIÓN TIENE QUE APLICARSE DENTRO DE UNA SOLA TRANSACCIÓN --
--    `psql -1 -v ON_ERROR_STOP=1` -- (hallazgo de `/code-review high`,
--    revisión del 16/9/2026): `set local` FUERA de una transacción es un
--    NO-OP silencioso -- en autocommit (el comando de docs/PRODUCCION.md
--    antes de esta revisión, sin `-1`) cada sentencia corre en su propia
--    transacción implícita, así que el `lock_timeout` corto de acá abajo
--    quedaría en 0 (sin tope) justo para el `alter table ... add column
--    ... generated ... stored` que este bloque existe para proteger. Y sin
--    `ON_ERROR_STOP=1`, si una sentencia de en medio falla, psql sigue con
--    las siguientes y termina con código 0: el trigger AFTER de la
--    sección 5 quedaría creado leyendo `new.new_since_ai_resume` sin que
--    la columna generada de la sección 2 exista, y CUALQUIER desasignación
--    o reactivación de la IA -- no solo un turno -- rompería con "record
--    new has no field new_since_ai_resume". El CI y `supabase db push` ya
--    envuelven cada migración en su propia transacción; esta advertencia
--    es para quien la aplique a mano contra `supabase-db`.
--
--    CORRECCIÓN (revisión "El resguardo antes del push", tarea C5,
--    20/9/2026): esa frase es cierta A MEDIAS. `npx supabase db reset` SÍ
--    aplica cada migración de forma atómica (sondeado el 20/9/2026 por el
--    orquestador: una migración de prueba `create table …; select 1/0;`
--    falla y la tabla NO queda), pero con una transacción IMPLÍCITA del
--    protocolo (un lote sin `BEGIN`), no con un BLOQUE de transacción. Para
--    `set local` alcanza -- por eso la guarda nunca disparó ahí --; para un
--    `lock table` (necesario para el hallazgo del gemelo, más abajo) NO:
--    Postgres exige un bloque explícito y con ese applier fallaba con
--    "LOCK TABLE can only be used in transaction blocks", incluso en un
--    archivo mínimo de prueba. Por eso este archivo ahora se envuelve en
--    `begin;`/`commit;` EXPLÍCITOS (ver más abajo): abre su propio bloque
--    sin depender de quién lo aplique. Efecto colateral aceptado: aplicado
--    sin `-1`, la guarda "abortar si no hay transacción" ya no dispara
--    nunca (el archivo trae la suya), que es el lado seguro. Aplicado con
--    `psql -1` (el método que sigue pidiendo
--    docs/PRODUCCION.md §11) produce dos WARNING inofensivos ("there is
--    already a transaction in progress" / "there is no transaction in
--    progress"), el mismo patrón ya documentado de
--    `scripts/sql/2026-09-18-catalogos-iniciales.sql`.
-- ---------------------------------------------------------------------------
begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0b. Guarda contra el no-op silencioso de arriba (hallazgo 10, revisión
--     `/code-review high` del 19/9/2026, corrección sobre T5 de "Seba sale
--     sin pisar a nadie"): `set local` fuera de una transacción no lanza
--     ningún error, solo un WARNING ("SET LOCAL can only be used in
--     transaction blocks") -- `ON_ERROR_STOP` no frena con warnings, así
--     que si alguien aplica este archivo sin `psql -1` el DDL de la
--     sección 2 en adelante corre igual, con `lock_timeout = 0` (sin
--     tope): el mismo ACCESS EXCLUSIVE prolongado que el bloque de arriba
--     existe para evitar. Mejor fallar cerrado acá que confiar en que
--     nadie se salte `-1`. La comparación contra `'0'`/`'0ms'` distingue
--     el no-op de un `lock_timeout` real heredado de la SESIÓN -- p. ej.
--     `PGOPTIONS="-c lock_timeout=5s"`, que docs/PRODUCCION.md ya
--     recomienda junto con `-1` -- ahí sí hay un tope activo y esta guarda
--     no debe disparar. Verificado a mano contra la base local
--     (`supabase_db_Liminal_CRM`, Postgres 17.6.1.167): dentro de
--     `begin … rollback` pasa (`current_setting('lock_timeout')` da `5s`);
--     en autocommit sin `-1` lanza y `psql -v ON_ERROR_STOP=1` sale con
--     código ≠ 0; en autocommit con `PGOPTIONS="-c lock_timeout=5s"` pasa
--     igual que dentro de la transacción. El CI
--     (`.github/workflows/ci.yml`, job `migraciones`, `supabase db
--     start`) y `supabase db push` aplican cada archivo de migración
--     dentro de su propio pipeline/transacción -- no se encontró ningún
--     `\i` de estas cinco migraciones fuera de un `begin` en
--     `supabase/tests/` ni en `scripts/` -- así que esta guarda no
--     debería disparar nunca ahí.
-- ---------------------------------------------------------------------------
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Candado de TABLA por adelantado (hallazgo del "gemelo plausible" de
-- 20260917010000/hallazgo B, revisión "El resguardo antes del push", tarea
-- C5, 20/9/2026) -- interbloqueo real, reproducido contra la base local
-- (30.000 conversaciones ya sembradas, 20 conexiones concurrentes llamando
-- `select public.record_handoff(...)` -- el mismo camino que
-- reconciler.ts/mutations.ts -- durante toda la aplicación de esta
-- migración):
--
--   Proceso 1087 (esta migración) espera AccessExclusiveLock sobre
--   `conversation_handoffs`; bloqueado por el proceso 1094.
--   Proceso 1094 espera RowShareLock sobre `conversations` (el chequeo de
--   FK de `record_handoff`); bloqueado por el proceso 1087.
--   ERROR: deadlock detected (en la sentencia `alter table
--   conversation_handoffs drop constraint` de la sección 4, más abajo) --
--   y, en la misma corrida, 16 de los 20 llamadores concurrentes de
--   `record_handoff` también recibieron `deadlock detected` en cadena
--   (Postgres fue liberando víctimas una por una a medida que cada backend
--   cumplía su propio `deadlock_timeout` mientras el ciclo seguía vivo,
--   porque el generador reintentaba de inmediato con una conversación
--   nueva): cada uno de esos 16 es un traspaso que se pierde en silencio
--   si el llamador real no reintenta -- exactamente lo que la invariante
--   "ningún lead invisible" prohíbe.
--
-- La causa es la misma que en 20260917010000: `alter table public.
-- conversations add column new_since_ai_resume generated always as (...)
-- stored` (sección 2, más abajo) reescribe la tabla entera con
-- ACCESS EXCLUSIVE sobre `conversations`, y ese candado se retiene hasta el
-- COMMIT -- no hasta que el ALTER termine. Un `record_handoff(...)` en
-- vuelo toma ROW EXCLUSIVE sobre `conversation_handoffs` (para su propio
-- INSERT) y, en el chequeo de la FK hacia `conversations` (RI_FKey_check_ins,
-- un `select ... for key share` interno), se queda esperando el
-- ACCESS EXCLUSIVE que esta migración ya tiene. Mientras tanto, esta
-- migración sigue de largo y, en la sección 4, pide ACCESS EXCLUSIVE sobre
-- `conversation_handoffs` para el `drop constraint`/`add constraint` -- y
-- ahí se topa con el ROW EXCLUSIVE que ya tienen uno o más `record_handoff`
-- en vuelo. Interbloqueo, mismo mecanismo, tabla distinta.
--
-- Mismo remedio que 20260917010000, mismo orden (alfabético, para que dos
-- migraciones que necesiten ambas tablas las pidan siempre en el mismo
-- orden entre sí): tomar el candado de `conversation_handoffs` ACÁ, ANTES
-- de tocar una sola fila de `conversations`, para que un `record_handoff`
-- en vuelo quede esperando SIN HABER TOMADO NADA TODAVÍA. `SHARE ROW
-- EXCLUSIVE` (no `ACCESS EXCLUSIVE`): solo hace falta bloquear el INSERT de
-- `record_handoff` (pide ROW EXCLUSIVE, que choca con SHARE ROW EXCLUSIVE);
-- las lecturas de la bitácora (`escalationOpen()`, `humanClaimsChat`, todas
-- `select` simples que piden ACCESS SHARE) siguen sin bloquearse. No hace
-- falta un candado propio sobre `messages` acá: esta migración no la toca.
--
-- Verificado el 20/9/2026 (misma tarea, con el archivo ya en su forma FINAL
-- -- incluido el `begin;`/`commit;` explícito de la cabecera): 3 corridas
-- seguidas contra el mismo escenario de carga (30.000 conversaciones, 20
-- llamadores concurrentes de `record_handoff` durante TODA la aplicación,
-- vía `psql -1 -v ON_ERROR_STOP=1`) terminaron con RC=0, sin ningún
-- deadlock, y con 0 errores del generador en las 3 corridas (43, 84 y 36
-- llamadas a `record_handoff` completadas, ninguna perdida). El generador
-- quedó bloqueado 4,1 s / 15,2 s / 4,3 s por corrida (el tiempo de la
-- migración completa hasta el COMMIT) -- ver el reporte de la tarea C5
-- para el detalle completo.
-- ---------------------------------------------------------------------------
lock table public.conversation_handoffs in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. ai_resume_cutoff_at -- el sello. Nace null: ninguna conversación
--    existente "acaba de ser devuelta", así que no hay nada que sellar con
--    un backfill.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column ai_resume_cutoff_at timestamptz;

comment on column public.conversations.ai_resume_cutoff_at is
  'Último instante en que un humano le devolvió el gobierno de esta conversación a la IA (ai_enabled=true y sin asesor asignado), copiado de last_customer_message_at en ESE momento -- lo escribe handle_conversation_ai_resume(). Caso real: un cliente pide un asesor, la IA escala y se despide; un asesor desasigna y reactiva la IA a mano en menos de un minuto, y sin este sello el reconciliador reencolaba el mismo mensaje viejo y la IA repetía la misma promesa. Se copia last_customer_message_at y no now() porque created_at de un entrante es la marca de tiempo de Meta (route.ts:1343): un mensaje enviado un segundo antes de la devolución pero entregado después quedaría detrás de now(), y contra el último mensaje ya conocido no hace falta tolerancia. Null hasta la primera devolución -- ninguna conversación existente al desplegar esta migración "acaba de ser devuelta", así que no hay backfill.';

-- ---------------------------------------------------------------------------
-- 2. new_since_ai_resume -- columna generada: ¿el último mensaje del
--    cliente es posterior al sello (o no hay sello todavía, y sí hay
--    mensaje)? Sin índice nuevo a propósito: el filtro que la consume
--    (Tareas 2/3, código) siempre va acompañado de awaiting_reply/
--    assigned_agent_id is null/status <> 'closed' -- el mismo predicado que
--    ya cubre conversations_free_unanswered_idx (20260905010000) -- así que
--    un índice propio solo duplicaría el trabajo de escritura en cada
--    mensaje sin ganar nada en la lectura: new_since_ai_resume es MÁS
--    angosto que ese predicado (awaiting_reply implica lcma is not null;
--    new_since_ai_resume además exige lcma > cutoff), nunca más ancho, así
--    que el índice existente ya deja el conjunto de filas candidatas chico
--    antes de evaluar la columna nueva.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column new_since_ai_resume boolean
  generated always as (
    last_customer_message_at is not null
    and (ai_resume_cutoff_at is null or last_customer_message_at > ai_resume_cutoff_at)
  ) stored;

comment on column public.conversations.new_since_ai_resume is
  'true si el último mensaje del cliente llegó DESPUÉS de la última devolución a la IA (o si nunca hubo devolución todavía y sí hay mensaje). El reconciliador y el botón de atraso filtran por esta columna en vez de "algo salió después del último mensaje" -- esa pregunta vieja (awaiting_any_reply, migración 20260915020000, deshecha el 16/9/2026) confundía una despedida automática con una respuesta real y no distinguía "el cliente escribió mientras esperaba al asesor" de "el cliente escribió recién después de que lo devolvieron". Sin índice propio: el filtro es más angosto que el predicado de conversations_free_unanswered_idx (awaiting_reply and assigned_agent_id is null and status <> closed), que ya reduce el conjunto antes de evaluar esta columna.';

-- ---------------------------------------------------------------------------
-- 3. handle_conversation_ai_resume() -- BEFORE UPDATE, sella al ENTRAR al
--    estado "la IA gobierna sin asesor" viniendo de cualquier otro estado
--    (asignada a un humano, o con la IA apagada). Cubre los dos órdenes
--    (desasignar y luego reactivar, o reactivar y luego desasignar) y un
--    UPDATE masivo por SQL que toque las dos columnas a la vez, porque el
--    WHEN dispara con CUALQUIER cambio de ai_enabled o assigned_agent_id y
--    la condición de adentro mira el estado FINAL contra el estado previo,
--    no el paso intermedio.
--
--    Una escalada SALE de ese estado (ai_enabled pasa a false, o se asigna
--    un asesor), así que nunca sella -- coincide con la primera línea de
--    la condición (`new.ai_enabled and new.assigned_agent_id is null`)
--    siendo falsa en cuanto se escala.
--
--    Postgres calcula las columnas GENERADAS después de los triggers
--    BEFORE (así llega el valor final a la fila que se escribe), y ANTES
--    de los triggers AFTER -- por eso handle_conversation_ownership_change
--    (más abajo, AFTER) puede leer new.new_since_ai_resume ya con el sello
--    de este trigger aplicado, sin tener que recalcularlo a mano.
-- ---------------------------------------------------------------------------
create function public.handle_conversation_ai_resume()
returns trigger
language plpgsql
as $$
begin
  if new.ai_enabled
    and new.assigned_agent_id is null
    and not (old.ai_enabled and old.assigned_agent_id is null)
  then
    new.ai_resume_cutoff_at := new.last_customer_message_at;
  end if;

  return new;
end;
$$;

comment on function public.handle_conversation_ai_resume is
  'Sella conversations.ai_resume_cutoff_at cuando la fila ENTRA al estado "la IA gobierna sin asesor" (ai_enabled=true, assigned_agent_id=null) viniendo de cualquier otro estado -- copia last_customer_message_at de ese instante, nunca now() (ver comentario de la columna). Disparado por conversations_ai_resume_before_trigger, BEFORE UPDATE, mismo WHEN que el trigger AFTER de handle_conversation_ownership_change.';

revoke execute on function public.handle_conversation_ai_resume() from public;
revoke execute on function public.handle_conversation_ai_resume() from anon, authenticated;

drop trigger if exists conversations_ai_resume_before_trigger on public.conversations;

create trigger conversations_ai_resume_before_trigger
  before update on public.conversations
  for each row
  when (
    old.ai_enabled is distinct from new.ai_enabled
    or old.assigned_agent_id is distinct from new.assigned_agent_id
  )
  execute function public.handle_conversation_ai_resume();

-- ---------------------------------------------------------------------------
-- 4. conversation_handoffs.reason -- copia COMPLETA de los 26 valores
--    vigentes en 20260914010000_intenciones_y_traspasos_completos.sql más
--    dos: `desasignada_por_asesor` (un asesor suelta el caso -- el trigger
--    de más abajo la escribe) y `mensaje_previo_a_devolucion` (reservada
--    para el código de la Tarea 3 de esta corrida: el turno se calla
--    porque el mensaje del cliente es anterior o igual al sello).
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
    -- Tarea 1, "La IA no vuelve a pedir lo que ya pidió" (16/9/2026):
    'desasignada_por_asesor',
    'mensaje_previo_a_devolucion'
  ));

comment on column public.conversation_handoffs.reason is
  'Por qué ocurrió el traspaso. Lista cerrada por CHECK (no enum, a propósito: ver 20260830040000). T2.1 (5/9/2026) sumó cerrada_por_asesor/reabierta_por_asesor/reabierta_por_cliente; "La IA ve lo que llega" (8/9/2026) sumó sin_contenido_legible; "La voz cercana y la espera visible" (14/9/2026) sumó cortesia_tras_escalada; "La IA no vuelve a pedir lo que ya pidió" (16/9/2026, Tarea 1) suma desasignada_por_asesor (un asesor suelta el caso -- lo escribe handle_conversation_ownership_change) y mensaje_previo_a_devolucion (el turno se calla porque el mensaje del cliente es anterior o igual al sello de devolución -- Tarea 3, código, misma corrida).';

-- ---------------------------------------------------------------------------
-- 5. handle_conversation_ownership_change() -- AFTER UPDATE, security
--    definer (mismo WHEN que el trigger BEFORE). Deja rastro en
--    conversation_handoffs de los TRES movimientos de dueño que
--    mutations.ts hace hoy sin escribir bitácora -- exactamente lo que
--    prohíbe la invariante "ningún lead invisible" de CLAUDE.md.
--
--    `security definer set search_path = public` porque mutations.ts corre
--    estas escrituras como `authenticated` (RLS normal de conversations, no
--    un cliente admin) y conversation_handoffs solo admite INSERT de
--    service_role (20260830040000) -- el trigger necesita saltarse esa RLS
--    para dejar su rastro, igual que handle_new_message/
--    handle_message_status_change.
--
--    to_kind se calcula UNA sola vez y es el mismo para todas las filas que
--    dispare el mismo UPDATE (comparten created_at, y tienen que coincidir
--    para no contradecirse en la bitácora):
--      - 'closed' si la conversación está cerrada (new.status = 'closed'),
--        ANTES de mirar quién quedó asignado -- revisión del 16/9/2026,
--        `/code-review high`: sin esta rama, desasignar (o que el `on
--        delete set null` de un asesor borrado) una conversación CERRADA la
--        dejaba como 'unassigned' y `unassigned_waiting_count()` la contaba
--        en "Sin dueño" aunque estuviera cerrada;
--      - 'human' con to_id = new.assigned_agent_id si sigue asignada (y no
--        está cerrada);
--      - 'unassigned' si la IA quedó apagada, o si queda un mensaje del
--        cliente sin atender que es ANTERIOR a la devolución (awaiting_reply
--        y no new_since_ai_resume): ese cliente sigue esperando a una
--        PERSONA, no a la IA que acaba de recuperar el chat, y tiene que
--        verse en "Sin dueño" hasta que alguien -- humano o la IA con un
--        mensaje nuevo -- lo atienda;
--      - 'ai' en cualquier otro caso.
--
--    Las tres razones que puede escribir, sin solaparse nunca entre sí en
--    el mismo UPDATE (cada `if` exige lo contrario de los otros dos sobre
--    new.assigned_agent_id/ai_enabled, así que como mucho dos de las tres
--    disparan juntas -- 'desasignada_por_asesor' + 'devuelto_a_ia', ya
--    cubierto por el caso 4 del test):
--      - 'desasignada_por_asesor': un asesor suelta el caso (old asignado,
--        new sin asignar).
--      - 'devuelto_a_ia': la IA se reactiva (old.ai_enabled=false,
--        new.ai_enabled=true).
--      - 'reclamado' (revisión del 16/9/2026, `/code-review high`): un
--        asesor toma un caso donde antes no lo tenía -- new.assigned_agent_id
--        pasa a valer algo distinto de old.assigned_agent_id SIN que
--        ai_enabled cambie en el mismo UPDATE (una escalada sí cambia las
--        dos cosas a la vez y escribe su propia fila 'escalada' después --
--        por eso el caso 1 del test, "escalada simulada", sigue sin dejar
--        ninguna fila). `reclamado` ya vivía en el CHECK desde
--        20260830040000 sin que nadie lo escribiera: es la razón natural
--        para "un asesor tomó el chat" que faltaba entre `assignToMe` e
--        `intervene` (mutations.ts) -- sin esta fila, un chat que pasaba de
--        un asesor a otro (o de "sin dueño" a un asesor) quedaba con la
--        última fila de la bitácora en 'unassigned' mientras alguien ya lo
--        tenía, y `unassigned_waiting_count()` lo seguía contando en "Sin
--        dueño". `from_kind`/`from_id` de esta fila son el dueño ANTERIOR a
--        ESE update: 'human' + old.assigned_agent_id si había asesor,
--        si no 'ai' si old.ai_enabled, si no 'unassigned'.
--
--    created_by: 'user' si auth.uid() no es null (un asesor actuando desde
--    el panel), 'system' si no (un script SQL directo, el borrado de un
--    asesor por `on delete set null` en assigned_agent_id, o la carrera del
--    UPDATE ciego de escalate.ts:84 corriendo con service_role, donde
--    auth.uid() es null).
-- ---------------------------------------------------------------------------
create function public.handle_conversation_ownership_change()
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
  -- asesor) sin que ai_enabled cambie en el mismo UPDATE -- una escalada
  -- (escalate.ts) cambia las dos columnas a la vez y escribe su propia fila
  -- 'escalada' después, así que no coincide con esta condición (caso 1 del
  -- test, "escalada simulada", sigue sin dejar fila).
  if new.assigned_agent_id is not null
    and old.assigned_agent_id is distinct from new.assigned_agent_id
    and old.ai_enabled = new.ai_enabled
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

  return new;
end;
$$;

comment on function public.handle_conversation_ownership_change is
  'Deja rastro en conversation_handoffs cuando un asesor desasigna una conversación, la IA se reactiva, o un asesor reclama un caso -- los tres movimientos de dueño que mutations.ts hace sin escribir bitácora. security definer para saltarse la RLS de conversation_handoffs (solo service_role inserta ahí). to_kind se calcula una sola vez para todas las filas del mismo UPDATE: closed si la conversación está cerrada (revisión del 16/9/2026: sin esta rama, desasignar un chat cerrado lo hacía contar en "Sin dueño"), unassigned si la IA quedó apagada o si queda un mensaje del cliente anterior a la devolución sin atender (awaiting_reply and not new_since_ai_resume) -- ese cliente espera a una persona, no a la IA que acaba de recuperar el chat. reclamado (revisión del 16/9/2026) dispara cuando assigned_agent_id cambia a un valor no nulo sin que ai_enabled cambie a la vez -- eso excluye a la escalada, que cambia las dos columnas juntas. Disparado por conversations_ownership_change_handoff_trigger, AFTER UPDATE, mismo WHEN que el trigger BEFORE de handle_conversation_ai_resume.';

-- El EXECUTE de fábrica de Postgres a PUBLIC y el `alter default privileges`
-- de Supabase a anon/authenticated son las dos vías independientes de
-- siempre (ver CLAUDE.md, "Cerrar una función security definer a anon exige
-- LOS DOS revokes"). Sin grant: es una función de trigger, y Postgres no
-- comprueba EXECUTE del rol que dispara la operación al ejecutar un trigger
-- (mismo criterio que enforce_conversation_pins_limit en 20260905040000).
revoke execute on function public.handle_conversation_ownership_change() from public;
revoke execute on function public.handle_conversation_ownership_change() from anon, authenticated;

drop trigger if exists conversations_ownership_change_handoff_trigger on public.conversations;

create trigger conversations_ownership_change_handoff_trigger
  after update on public.conversations
  for each row
  when (
    old.assigned_agent_id is distinct from new.assigned_agent_id
    or old.ai_enabled is distinct from new.ai_enabled
  )
  execute function public.handle_conversation_ownership_change();

-- ---------------------------------------------------------------------------
-- Autoverificación: lee el catálogo real (information_schema/pg_indexes/
-- pg_trigger/pg_constraint/has_function_privilege), no el texto de este
-- archivo -- mismo criterio que 20260914010000, adoptado justo después de
-- que confiar en el .sql en vez de en la base dejara dos migraciones sin
-- cerrar un agujero de permisos (ver CLAUDE.md, "Cerrar una función
-- security definer...").
-- ---------------------------------------------------------------------------
do $$
declare
  col_cutoff_exists boolean;
  col_generated text;
  trg_before_count integer;
  trg_after_count integer;
  def_reason text;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'conversations'
      and column_name = 'ai_resume_cutoff_at'
  ) into col_cutoff_exists;

  if not col_cutoff_exists then
    raise exception '20260916010000: conversations.ai_resume_cutoff_at no quedó creada';
  end if;

  select is_generated into col_generated
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'conversations'
      and column_name = 'new_since_ai_resume';

  if col_generated is distinct from 'ALWAYS' then
    raise exception '20260916010000: conversations.new_since_ai_resume no quedó como columna generada (is_generated: %)', col_generated;
  end if;

  select count(*) into trg_before_count
    from pg_trigger
    where tgrelid = 'public.conversations'::regclass
      and tgname = 'conversations_ai_resume_before_trigger'
      and not tgisinternal;

  if trg_before_count is distinct from 1 then
    raise exception '20260916010000: conversations_ai_resume_before_trigger no quedó creado (encontrados: %)', trg_before_count;
  end if;

  select count(*) into trg_after_count
    from pg_trigger
    where tgrelid = 'public.conversations'::regclass
      and tgname = 'conversations_ownership_change_handoff_trigger'
      and not tgisinternal;

  if trg_after_count is distinct from 1 then
    raise exception '20260916010000: conversations_ownership_change_handoff_trigger no quedó creado (encontrados: %)', trg_after_count;
  end if;

  select pg_get_constraintdef(oid) into def_reason
    from pg_constraint
    where conrelid = 'public.conversation_handoffs'::regclass
      and conname = 'conversation_handoffs_reason_check';

  if def_reason is null or def_reason not like '%desasignada_por_asesor%' then
    raise exception '20260916010000: conversation_handoffs_reason_check no quedó con desasignada_por_asesor (definición: %)', def_reason;
  end if;

  if def_reason not like '%mensaje_previo_a_devolucion%' then
    raise exception '20260916010000: conversation_handoffs_reason_check no quedó con mensaje_previo_a_devolucion (definición: %)', def_reason;
  end if;

  if has_function_privilege('anon', 'public.handle_conversation_ai_resume()', 'execute') then
    raise exception '20260916010000: anon puede ejecutar handle_conversation_ai_resume()';
  end if;

  if has_function_privilege('anon', 'public.handle_conversation_ownership_change()', 'execute') then
    raise exception '20260916010000: anon puede ejecutar handle_conversation_ownership_change()';
  end if;

  raise notice '20260916010000: autoverificación del sello de devolución, la columna generada, los dos triggers, el CHECK ampliado y los permisos, correcta.';
end $$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y la columna/CHECK
-- nuevos dan 400 hasta que alguien lo recargue a mano -- revisión "Seba sale
-- sin pisar a nadie" (19/9/2026, tarea T5, hallazgo M1: ninguna de las cinco
-- migraciones de esta corrida lo traía).
notify pgrst, 'reload schema';

-- Cierra el `begin;` explícito de la cabecera (hallazgo del gemelo, tarea
-- C5, 20/9/2026). NOTIFY entrega su aviso a los LISTENers recién al COMMIT
-- de la transacción que lo emitió -- comportamiento normal de Postgres, así
-- que ponerlo antes de este `commit;` es exactamente donde tiene que estar.
commit;
