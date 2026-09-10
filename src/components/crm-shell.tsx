"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  AgentSettings,
  Conversation,
  ConversationSummary,
  InboxDayScope,
  Message,
  Note,
  QuickReply,
  Tag,
  WhatsappTemplate,
} from "@/lib/types";
import { useInboxDay } from "@/lib/use-inbox-day";
import { createClient } from "@/lib/supabase/client";
import {
  CHAT_MESSAGES_WINDOW,
  INBOX_PAGE_SIZE,
  fetchConversation,
  fetchConversationIdByPhone,
  fetchConversationRow,
  fetchConversations,
  fetchInboxCounts,
  fetchMessages,
  fetchMessagesBefore,
  fetchNotes,
  fetchQuickReplies,
  fetchTags,
  fetchTemplates,
  fetchAgentSettings,
  type InboxCounts,
} from "@/lib/data";
import { cursorAfterPage, mergeById } from "@/lib/inbox-paging";
import {
  closeConversation,
  markConversationRead,
  markConversationUnread,
  reopenConversation,
  sendMessage,
  sendReadReceipt,
} from "@/lib/mutations";
import { decideReadOnArrival, shouldFlushDeferred } from "@/lib/read-on-arrival";
import {
  discardItem,
  enqueueText,
  markFailed,
  markSent,
  pruneDelivered,
  retryItem,
  sendableHeads,
  type OutboxItem,
} from "@/lib/outbox";
import { useInboxPager } from "@/lib/use-inbox-pager";
import { useLiveConversations } from "@/lib/use-live-conversations";
import { REALTIME_DEBOUNCE_MS, useLiveRefresh } from "@/lib/use-live-refresh";
import { nextRealtimeAction, type RealtimeStatus } from "@/lib/realtime-status";
import {
  dayRangeFrom,
  fetchAgentDaySummary,
  fetchAiAssignmentsToday,
  type AgentDaySummary,
  type AiAssignment,
} from "@/lib/agent-day-data";
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";
import { AgentHomePanel } from "@/components/inbox/agent-home-panel";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";
import { ChatPanel } from "@/components/chat/chat-panel";
import { ContextPanel } from "@/components/context-panel/context-panel";
import { AppRail } from "@/components/app-rail";
import "@/components/crm.css";

interface CrmShellProps {
  currentAgent: Agent;
  initialConversations: ConversationSummary[];
  /** Los contadores del panel de inicio, ya contados en el servidor. */
  initialInboxCounts: InboxCounts;
  /**
   * Las filas de la píldora que abre por defecto ya resueltas en el
   * servidor. Siembra `InboxSidebar` para que esa píldora abra con datos en
   * vez del cartel "Buscando…"; el efecto de red del montar los refresca
   * igual. Opcional (y no `[]` por defecto acá arriba, sino en el
   * destructuring de abajo) para no obligar a cada instanciación existente
   * de `CrmShell` a conocer este dato nuevo.
   *
   * Se llamó `initialUnreadConversations` mientras la píldora por defecto
   * era "No leídas"; la reforma del 30/8/2026 devolvió el filtro por
   * defecto a "Pendientes" (231 chats leídos y sin responder no aparecían en
   * ninguna píldora) y el nombre se actualizó con ella.
   */
  initialPendingConversations?: ConversationSummary[];
  /**
   * TODAS las etiquetas creadas, incluidas las que nadie usa todavía:
   * `ContextPanel` (`ManageTagsModal` y la lista de "aplicar etiqueta" al
   * contacto) necesita poder ofrecer una categoría recién creada aunque
   * ningún contacto la lleve aún. `fetchTags` (`@/lib/data`), sembrada desde
   * `page.tsx`.
   */
  allTags: Tag[];
  /**
   * Las etiquetas EN USO, para la barra de filtro de `InboxSidebar`
   * (`InboxSidebar.allTags` — mismo nombre de prop, lista distinta a
   * propósito: ver el comentario de esa prop en `inbox-sidebar.tsx`).
   * `fetchTagsInUse` (`@/lib/data`), sembrada desde `page.tsx`.
   *
   * Reforma del 30/8/2026: antes `InboxSidebar` recibía `allTags` (arriba) y
   * derivaba "en uso" recorriendo la ventana cargada (`conversations`, ~30
   * filas) — una etiqueta aplicada a un contacto fuera de esa ventana no
   * aparecía nunca en la barra, y como la IA suele etiquetar conversaciones
   * que atiende sola, más abajo en la lista, el sesgo se notaba justo con
   * las suyas. Opcional, con `allTags` de respaldo (todas, no solo las
   * usadas) para no obligar a cada instanciación existente de `CrmShell` a
   * conocer esta prop nueva — producción siempre la pasa explícita (ver
   * `page.tsx`); las pruebas que no la pasan (`InboxSidebar` va mockeado en
   * `crm-shell.test.tsx`) quedan con el respaldo sin que les importe.
   */
  tagsInUse?: Tag[];
  initialQuickReplies: QuickReply[];
  /** Tasa del BCV del día, ya resuelta en el servidor. Null si no se pudo obtener ninguna. */
  bcvRate: BcvRateSummary | null;
  /** Hilo a abrir al entrar, por ejemplo al llegar desde una tarjeta del dashboard. */
  initialConversationId?: string;
  /**
   * Interruptor general de la IA y tope de gasto, resueltos en el servidor.
   * El cartel de cada conversación los necesita para no anunciar que la IA
   * responde cuando está apagada para todo el CRM.
   */
  initialAgentSettings: AgentSettings;
  /**
   * El resumen del día del asesor logueado (T4, "Los números del día",
   * 10/9/2026), ya resuelto en el servidor: alimenta las tarjetas "Tu día"
   * de `AgentHomePanel`. `null` cuando el RPC falló o la siembra del
   * servidor no llegó a pedirlo — nunca se inventa un cero (ver el
   * comentario de `AgentHomePanel`). Opcional con default `null`, mismo
   * criterio que el resto de las props de siembra nuevas: las pruebas que no
   * conocen esta tarea no tienen que enterarse.
   */
  initialAgentDay?: AgentDaySummary | null;
  /**
   * Lo último que la IA le pasó al asesor HOY (T4, 10/9/2026), ya resuelto
   * en el servidor, para la lista "La IA te pasó hoy" de `AgentHomePanel`.
   * Opcional con default `[]`, mismo criterio que `initialAgentDay`.
   */
  initialAiAssignments?: AiAssignment[];
}

/**
 * Callback común de `channel.subscribe` para los canales de este archivo que
 * solo necesitan reaccionar a una caída y a la reconexión (F9, 4/9/2026): el
 * resto de canales, hasta ahora, ignoraba el estado del WebSocket — si se
 * caía y reconectaba solo, la vista se quedaba con lo último que alcanzó a
 * bajar hasta que algo más disparara un refetch. `onResync` es lo que hay
 * que rehacer al volver (pedir el catálogo entero, en la mayoría de estos
 * canales angostos).
 *
 * Guarda el estado anterior en un cierre propio de cada llamada —no en un
 * ref del componente— porque cada canal de este archivo se suscribe una vez
 * por efecto y este helper se invoca una vez por canal: no hace falta
 * compartir el estado entre canales distintos.
 */
/**
 * Bajo su propia llave, por visor (T1, 8/9/2026) — distinta de
 * `sbk:inbox:{agentId}`, que `inbox-sidebar.tsx` usa para `filter`/`sort`:
 * ese es estado propio del sidebar, y el scope vive en el shell (ver el
 * comentario de `dayScope` más abajo) porque también gobiernan la cabecera
 * de "Todos" y los seis contadores.
 */
function dayScopeStorageKey(agentId: string): string {
  return `sbk.inbox.scope.${agentId}`;
}

function realtimeStatusHandler(channelName: string, onResync: () => void) {
  let previousStatus: RealtimeStatus | null = null;
  return (status: RealtimeStatus) => {
    const action = nextRealtimeAction(previousStatus, status);
    previousStatus = status;
    if (action === "log_down") {
      // `log.ts` es `server-only`: no se puede importar desde un componente
      // cliente. `console.warn` con el mismo nombre de evento deja el rastro
      // sin arrastrar ese módulo al navegador.
      console.warn("realtime_canal_caido", { channelName, status });
    } else if (action === "resync") {
      onResync();
    }
  };
}

export function CrmShell({
  currentAgent,
  initialConversations,
  initialInboxCounts,
  initialPendingConversations = [],
  allTags,
  tagsInUse = allTags,
  initialQuickReplies,
  bcvRate,
  initialConversationId,
  initialAgentSettings,
  initialAgentDay = null,
  initialAiAssignments = [],
}: CrmShellProps) {
  const supabase = useMemo(() => createClient(), []);

  const [inboxCounts, setInboxCounts] = useState<InboxCounts>(initialInboxCounts);

  /**
   * "Habló hoy" (T1 del plan "Seis frentes del buzón", 8/9/2026): la bandeja
   * abre mostrando solo lo que se movió HOY —cliente, asesor o IA,
   * cualquiera de los tres mueve `last_message_at`— y el interruptor "Ver
   * todo" (el botón vive en `InboxSidebar`, el estado acá) lo apaga.
   *
   * Vive en el shell y no en `InboxSidebar` (que sí guarda `filter`/`sort`
   * por su cuenta, bajo `sbk:inbox:{agentId}`) porque el corte también
   * gobierna dos consultas que solo el shell hace: la cabecera de "Todos"
   * (`fetchInboxHead`, más abajo) y los seis contadores (`fetchInboxCounts`).
   * Arranca en `"today"` porque `app/inbox/page.tsx` (el servidor, sin
   * `localStorage`) siembra `initialConversations`/`initialInboxCounts` con
   * ESE corte — el primer render del cliente tiene que coincidir, o
   * hidratar con "Ver todo" pisaría en silencio lo que el servidor ya
   * resolvió. Si el visor tenía "Ver todo" guardado, el efecto de abajo lo
   * restaura después de montar y el de `dayStart` (junto a
   * `useLiveConversations`, más abajo) hace el refetch.
   */
  const [dayScope, setDayScope] = useState<InboxDayScope>("today");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(dayScopeStorageKey(currentAgent.id));
      if (stored === "today" || stored === "all") {
        // Sincroniza React con lo que ya vive en localStorage al montar —
        // mismo patrón que la preferencia de píldora/orden de
        // `inbox-sidebar.tsx`: no hay otra forma de traer un valor externo
        // adentro salvo un setState directo acá.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDayScope(stored);
      }
    } catch {
      // Modo incógnito o almacenamiento bloqueado: se queda en "today", el
      // corte con el que el servidor ya sembró todo.
    }
  }, [currentAgent.id]);

  const handleDayScopeChange = useCallback(
    (scope: InboxDayScope) => {
      setDayScope(scope);
      try {
        localStorage.setItem(dayScopeStorageKey(currentAgent.id), scope);
      } catch {
        // Sin almacenamiento, la preferencia vale solo para esta pestaña.
      }
    },
    [currentAgent.id]
  );

  /**
   * ÚNICA fuente del corte (`useInboxDay`, `src/lib/use-inbox-day.ts`): el
   * mismo string viaja a `fetchInboxHead`/`fetchInboxCounts`/`allPager` de
   * acá abajo y a `InboxSidebar` (que lo repite en sus propias consultas y
   * en `applyInboxFilters`). `null` con "Ver todo" — nada que cortar.
   */
  const dayStart = useInboxDay(dayScope);

  /**
   * El corte de "Tu día" (T4, "Los números del día", 10/9/2026): SIEMPRE
   * hoy, sin importar el interruptor "Ver todo" de la bandeja — el resumen
   * del día del asesor no es una vista de la bandeja, es su día de verdad, y
   * "Ver todo" no debería vaciarlo. Por eso es un `useInboxDay("today")`
   * aparte de `dayStart` (arriba, que sí seguía a `dayScope`) y no una
   * reutilización: las dos fuentes coinciden casi siempre (el default de
   * `dayScope` YA es "today"), pero divergen justo cuando el asesor prende
   * "Ver todo", que es el caso que este panel tiene que ignorar.
   */
  const agentDayStart = useInboxDay("today");

  const [agentDay, setAgentDay] = useState<AgentDaySummary | null>(initialAgentDay);
  const [aiAssignments, setAiAssignments] = useState<AiAssignment[]>(initialAiAssignments);

  /**
   * Vuelve a pedir el resumen del día y los últimos traspasos de la IA. Se
   * llama (a) de rebote desde `fetchInboxHead`/`refreshInboxCounts` —ya que
   * de todos modos consultan la base por otro motivo—, (b) cuando rueda la
   * medianoche de Caracas (efecto más abajo) y (c) desde el canal
   * `agent-day-handoffs`. En error conserva lo que ya había: el próximo
   * pulso o la próxima mutación reintenta, y el panel no se queda pintando
   * "—" cuando lo que falló fue el refresco, no la primera carga.
   */
  const refreshAgentDay = useCallback(async () => {
    // "today" nunca da null (ver `useInboxDay`); la guarda es solo para TS.
    if (!agentDayStart) return;
    try {
      const range = dayRangeFrom(agentDayStart);
      const [summary, assignments] = await Promise.all([
        fetchAgentDaySummary(supabase, range),
        fetchAiAssignmentsToday(supabase, currentAgent.id, agentDayStart),
      ]);
      setAgentDay(summary);
      setAiAssignments(assignments);
    } catch {
      // Se queda con el resumen anterior; el próximo pulso lo reintenta.
    }
  }, [supabase, currentAgent.id, agentDayStart]);

  /**
   * Sube cada vez que `fetchInboxHead` trae una cabecera fresca de la base
   * (disparado por realtime, por la pasada de fondo, o por un refresco
   * manual tras una mutación fallida). Es el pulso que `InboxSidebar` usa
   * para saber que algo cambió y volver a consultar SU PROPIA cabecera —
   * "No leídas"/"Mías" son consultas aparte (`unreadOnly`/`assignedTo` en
   * `data.ts`) que este mismo canal de realtime no toca, ver el efecto junto
   * a `serverRows` en inbox-sidebar.tsx — sin abrir un canal de realtime
   * propio para esa píldora. Un contador y no un booleano: dos pulsos
   * seguidos (dos eventos de realtime muy pegados) deben disparar dos
   * reconciliaciones, y un booleano que ya está en `true` no dispara nada la
   * segunda vez.
   */
  const [livePulse, setLivePulse] = useState(0);

  /**
   * El refresco en vivo pide solo la cabecera y conserva lo que el asesor
   * bajó. Antes rearmaba la ventana entera: quien había bajado seis veces
   * pagaba 135 KB y 1,2 s en cada evento que no se resolviera en memoria.
   * La cabecera basta porque una conversación con movimiento sube al tope, y
   * lo que cambia sin subir se pide de a una fila (`fetchRow`).
   *
   * De paso refresca los contadores del panel de inicio: cambian por los
   * mismos eventos y el viaje ya está hecho. Y de paso sube `livePulse`: es
   * la señal de que la base tiene algo nuevo, que "No leídas"/"Mías" también
   * necesitan aunque esta consulta en sí (`fetchConversations` sin filtro)
   * no las mire.
   */
  const fetchInboxHead = useCallback(
    async (current: ConversationSummary[]) => {
      const since = dayStart ?? undefined;
      const [head, counts] = await Promise.all([
        fetchConversations(supabase, { limit: INBOX_PAGE_SIZE, since }),
        fetchInboxCounts(supabase, currentAgent.id, undefined, { since }),
      ]);
      setInboxCounts(counts);
      setLivePulse((p) => p + 1);
      // De rebote (T4, 10/9/2026): el viaje a la base ya está hecho por otro
      // motivo, y sin bloquear a este `Promise.all` — el panel de inicio no
      // tiene que atrasar la bandeja.
      void refreshAgentDay();
      return mergeById(head, current);
    },
    [supabase, currentAgent.id, dayStart, refreshAgentDay]
  );

  const fetchInboxRow = useCallback(
    (id: string) => fetchConversationRow(supabase, id),
    [supabase]
  );

  /**
   * Vuelve a pedir los contadores de las píldoras, sin tocar la lista.
   *
   * Marcar leído/no leído aplica el cambio en memoria por el camino corto de
   * `useLiveConversations` (`applyConversationRow`, use-live-conversations.ts
   * líneas 157-193 devuelve "applied" y no llega a `fetchInboxHead`), así que
   * el contador de "No leídas" quedaría con el valor viejo hasta la pasada de
   * fondo de 5 minutos si nadie lo pide de nuevo a mano.
   */
  const refreshInboxCounts = useCallback(async () => {
    try {
      setInboxCounts(
        await fetchInboxCounts(supabase, currentAgent.id, undefined, { since: dayStart ?? undefined })
      );
    } catch {
      // Los contadores se quedan con el valor anterior; el próximo evento en
      // vivo o la próxima mutación reintenta.
    }
    // De rebote, igual que en `fetchInboxHead` (T4, 10/9/2026): sin bloquear
    // esta función por un panel que no es lo que ella refresca.
    void refreshAgentDay();
  }, [supabase, currentAgent.id, dayStart, refreshAgentDay]);

  /**
   * "Sin dueño" en vivo (T1.6): un canal PROPIO y angosto, no el genérico de
   * `conversations` que ya usa `useLiveConversations` más abajo — a
   * propósito. `conversation_handoffs` es una bitácora de EVENTOS, así que
   * "algo cambió" ahí no se puede reconciliar en memoria como una fila de
   * `conversations` (no hay "la fila tal cambió a tal valor", hay "se
   * insertó un traspaso más"): la única respuesta correcta es volver a
   * preguntarle a la base el conjunto entero. Por eso este canal no aplica
   * nada en memoria — sube `livePulse`, y quien tiene la píldora abierta
   * (`inbox-sidebar.tsx`) rehace su consulta y se queda con lo que siga
   * calificando. El dato no se guarda dos veces.
   *
   * Suscrito SOLO a los INSERT con `to_kind = 'unassigned'` —el filtro va en
   * la suscripción misma, no se aplica después— para no meterle ruido: cada
   * mensaje entrante toca `conversations`, no `conversation_handoffs`, así
   * que este canal se queda callado el resto del tiempo. Debounced con el
   * mismo margen que el resto de los refrescos agrupados del shell
   * (`REALTIME_DEBOUNCE_MS`, 750 ms) por si el reconciliador o el cron
   * insertan varios traspasos seguidos.
   *
   * No cubre la dirección contraria (un traspaso de `unassigned` a `ai`/
   * `human`, es decir "ya se la agarraron"): ese INSERT tiene
   * `to_kind` distinto de `unassigned` y este filtro no lo ve pasar. Se
   * repara igual en la próxima carga de la página o el próximo traspaso A
   * `unassigned` que sí dispare este canal — no hay pérdida de datos, solo
   * una demora en que la lista deje de contar una conversación que ya
   * atendieron. Cerrar esa ventana entera es la Etapa 2 del plan (un
   * `owner_kind` en vivo sobre `conversations`, no un traspaso a mirar en
   * retrospectiva).
   */
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const channel = supabase
      .channel("unassigned-handoffs")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "conversation_handoffs",
          filter: "to_kind=eq.unassigned",
        },
        () => {
          if (timeout) clearTimeout(timeout);
          timeout = setTimeout(() => {
            timeout = null;
            setLivePulse((n) => n + 1);
          }, REALTIME_DEBOUNCE_MS);
        }
      )
      .subscribe(realtimeStatusHandler("unassigned-handoffs", () => setLivePulse((n) => n + 1)));

    return () => {
      if (timeout) clearTimeout(timeout);
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  /**
   * Arranca el panel en cero solo cuando rueda la medianoche de Caracas (T4,
   * 10/9/2026): `agentDayStart` cambia de valor (dos veces por día, ver
   * `useInboxDay`) y este efecto vuelve a pedir el resumen. Salta su primera
   * pasada con el mismo patrón que `didSkipInitialDayFetchRef` más abajo: al
   * montar, `initialAgentDay`/`initialAiAssignments` YA vienen resueltos por
   * el servidor con el corte de HOY — pedirlos de nuevo ahí sería una
   * consulta idéntica de balde.
   */
  const didSkipInitialAgentDayFetchRef = useRef(false);

  useEffect(() => {
    if (!didSkipInitialAgentDayFetchRef.current) {
      didSkipInitialAgentDayFetchRef.current = true;
      return;
    }
    void refreshAgentDay();
  }, [refreshAgentDay]);

  /**
   * "La IA te pasó hoy" en vivo (T4, 10/9/2026): un canal PROPIO, filtrado
   * en el servidor por `to_kind = 'human'` — no puede filtrar además por
   * `to_id` porque ese valor depende de quién soy, no algo que se pueda fijar
   * en la suscripción (mismo motivo que documenta `assignment-notifier.tsx`
   * para su propio canal). El chequeo de `to_id === currentAgent.id` queda
   * del lado del cliente, adentro del handler.
   *
   * `useLiveRefresh` agrupa ráfagas (varios traspasos seguidos del
   * reconciliador o de un lote sin asesores) igual que hace
   * `dashboard-view.tsx` con su propio canal angosto — mismo patrón, no uno
   * nuevo. `realtimeStatusHandler` (arriba en este archivo) resincroniza si
   * el canal se cae y reconecta.
   */
  const requestAgentDayRefresh = useLiveRefresh(refreshAgentDay);

  useEffect(() => {
    const channel = supabase
      .channel("agent-day-handoffs")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "conversation_handoffs",
          filter: "to_kind=eq.human",
        },
        (payload) => {
          const raw = payload.new as Record<string, unknown>;
          if (raw.to_id === currentAgent.id) {
            requestAgentDayRefresh();
          }
        }
      )
      .subscribe(realtimeStatusHandler("agent-day-handoffs", requestAgentDayRefresh));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, currentAgent.id, requestAgentDayRefresh]);

  // La lista viva: aplica en memoria lo que el evento ya trae, agrupa los
  // refetch inevitables, y no trabaja contra una pestaña que nadie mira.
  const { conversations, setConversations, refreshConversations } = useLiveConversations(
    supabase,
    initialConversations,
    {
      fetcher: fetchInboxHead,
      fetchRow: fetchInboxRow,
      watchContactTags: true,
      channelName: "conversations-changes",
    }
  );

  /**
   * Paginación por cursor de "Todos", vía `useInboxPager` (ver el comentario
   * grande del hook para el porqué de cada guarda). La primera página ya la
   * resolvió el servidor —viene en `initialConversations`—, así que se siembra
   * en vez de volver a pedirla: `sessionKey` fija evita que el shell reabra
   * sesión propia, cosa que este pager sembrado no necesita.
   */
  const allPager = useInboxPager({
    sessionKey: "all",
    pageSize: INBOX_PAGE_SIZE,
    seed: {
      cursor: cursorAfterPage(initialConversations),
      reachedEnd: initialConversations.length < INBOX_PAGE_SIZE,
    },
    // `since` se lee de `dayStart` en cada llamada (la clausura del hook
    // captura `fetchPage` recién al salir a la red — ver "CLAUSURA
    // CAPTURADA" en `use-inbox-pager.ts`), así que "cargar más" después de
    // tocar el interruptor ya sale con el corte vigente. El cursor sigue
    // siendo válido para seguir bajando aunque `since` cambie a mitad de
    // camino: es un predicado de POSICIÓN sobre `last_message_at`/`id`, que
    // `since` no toca.
    fetchPage: (cursor) =>
      fetchConversations(supabase, {
        cursor: cursor ?? undefined,
        limit: INBOX_PAGE_SIZE,
        since: dayStart ?? undefined,
      }),
    onPage: (page) => setConversations((current) => mergeById(current, page)),
  });

  /**
   * Refresca la cabecera de "Todos" cuando cambia el corte de "hoy" (T1,
   * 8/9/2026): tocar el interruptor "Ver todo", o que ruede la medianoche de
   * Caracas. NO usa `allPager.retry()`/un `sessionKey` nuevo —el pager de
   * "Todos" nace SEMBRADO (`seed`, arriba) y `useInboxPager` bloquea para
   * siempre la primera página de un pager sembrado (`hasSeedRef`, fijado en
   * el primer montaje): cambiar su `sessionKey` no lo haría volver a pedir
   * nada. En su lugar, esto pide una cabecera nueva a mano y la MEZCLA con
   * `mergeById` sobre lo que ya está cargado.
   *
   * Es asimétrico a propósito, y es un límite conocido (no un bug): pasar de
   * "hoy" a "Ver todo" SÍ trae lo viejo de una vez —lo de hoy ya estaba en
   * `conversations`, y lo viejo entra al fondo por `mergeById`, que nunca
   * pisa lo que ya hay—; pasar de "Ver todo" a "hoy" NO saca de memoria lo
   * viejo que ya se había cargado, solo dejan de pintarse (`matchesDay`,
   * `inbox-filters.ts`, corre en cada render sobre lo que haya en
   * `conversations`) — total, sigue viviendo ahí sin ocupar una consulta de
   * más, y desaparece del todo en la próxima carga completa de la página.
   *
   * `didSkipInitialFetchRef` salta la primera pasada: al montar,
   * `initialConversations`/`initialInboxCounts` (`page.tsx`) YA vienen con
   * el corte de HOY —el default de `dayScope`—, así que pedir de nuevo ahí
   * sería una consulta idéntica de balde. Si el visor tenía "Ver todo"
   * guardado, el efecto que restaura `dayScope` desde `localStorage` cambia
   * `dayStart` en un commit POSTERIOR al de montar — la primera pasada de
   * ESTE efecto ya alcanzó a marcar el ref, así que esa restauración sí
   * dispara el refetch, con el corte correcto.
   */
  const didSkipInitialDayFetchRef = useRef(false);

  useEffect(() => {
    if (!didSkipInitialDayFetchRef.current) {
      didSkipInitialDayFetchRef.current = true;
      return;
    }

    let cancelled = false;
    const since = dayStart ?? undefined;

    Promise.all([
      fetchConversations(supabase, { limit: INBOX_PAGE_SIZE, since }),
      fetchInboxCounts(supabase, currentAgent.id, undefined, { since }),
    ])
      .then(([head, counts]) => {
        if (cancelled) return;
        setConversations((current) => mergeById(current, head));
        setInboxCounts(counts);
      })
      .catch(() => {
        // La lista se queda con lo que ya tenía cargado; el próximo pulso en
        // vivo o un cambio de scope siguiente lo vuelve a intentar.
      });

    return () => {
      cancelled = true;
    };
  }, [dayStart, supabase, currentAgent.id, setConversations]);

  // Sin conversación de inicio no se abre ninguna: abrir la primera de la
  // lista ponía al asesor a leer un chat que no eligió —y lo daba por leído—
  // antes de decidir nada. El id explícito (llegar desde una tarjeta del
  // dashboard) sí abre directo, porque ahí la elección ya está hecha — y se
  // respeta aunque el hilo no esté en la ventana cargada: el detalle se pide
  // por id, no se busca en la lista.
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId ?? null);
  /**
   * Sincroniza `selectedId` con `initialConversationId` cuando el prop
   * cambia DESPUÉS del montaje — no en el montaje, que ya lo cubre el
   * `useState` de arriba.
   *
   * Antes esto no existía: `useState` solo lee el prop una vez. El asesor ya
   * parado en `/inbox` y un `router.push("/inbox?conversation=<id>")` (el
   * aviso de asignación, 8/9/2026) cambiaban el searchParam y por lo tanto
   * `initialConversationId`, pero como no hay montaje nuevo `selectedId` no
   * se movía: el clic del aviso no abría nada. Estando en otra sección sí
   * funcionaba, porque ahí sí hay montaje.
   *
   * Se resuelve con "estado derivado durante el render" (el patrón oficial
   * de React para ajustar estado cuando cambia un prop, sin `useEffect`) en
   * vez de un `useEffect` con `[initialConversationId]` en las dependencias:
   * ese efecto ingenuo dispara `setSelectedId` cada vez que el prop es
   * distinto a como estaba, sin poder distinguir "el prop trae un id nuevo"
   * de "sigue siendo el mismo pero el asesor ya seleccionó otro hilo a
   * mano" — comparando contra el valor ANTERIOR sí se puede. El valor
   * anterior va en `useState`, no en un `useRef`: la regla de lint
   * `react-hooks/refs` (activa en este repo) prohíbe leer Y escribir
   * `.current` durante el render —el `useRef` original pasaba `tsc` pero no
   * `rtk npm run lint`—, y este bloque corre en el cuerpo del componente, no
   * dentro de un evento o un efecto. Con `useState` no hay ref que tocar, así
   * que la regla queda satisfecha sin cambiar el comportamiento. Un rerender
   * con el mismo prop no toca el estado previo, así que no pisa la selección
   * manual (si el asesor clickea "B" con el prop todavía en "A", queda "B").
   * Y un prop que llega `null` no dispara nada: `null` sigue significando
   * "no abras nada" (ver el comentario de arriba), nunca "cierra lo que el
   * asesor tiene abierto".
   */
  const [previousInitialConversationId, setPreviousInitialConversationId] = useState(
    initialConversationId
  );
  if (initialConversationId !== previousInitialConversationId) {
    setPreviousInitialConversationId(initialConversationId);
    if (initialConversationId) {
      setSelectedId(initialConversationId);
    }
  }
  /**
   * El hilo cargado, con la conversación a la que pertenece pegada al lado.
   *
   * Guardar el id junto a los mensajes —en vez de vaciar la lista al cambiar
   * de chat— hace imposible por construcción que se vean los mensajes de una
   * conversación bajo el nombre de otra: si el id no coincide con el chat
   * abierto, lo que hay guardado sencillamente no es de este hilo.
   */
  const [loadedThread, setLoadedThread] = useState<{
    conversationId: string;
    messages: Message[];
    notes: Note[];
    /** No queda nada más viejo que traer en este hilo. */
    reachedStart: boolean;
  } | null>(null);
  const [templates, setTemplates] = useState<WhatsappTemplate[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>(initialQuickReplies);
  const [tags, setTags] = useState<Tag[]>(allTags);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(initialAgentSettings);

  // El interruptor general se toca desde Control de IA, que es otra pantalla:
  // sin escucharlo, el cartel de la bandeja se quedaría con lo que había al
  // cargar y volvería a mentir hasta que alguien recargue.
  useEffect(() => {
    const channel = supabase
      .channel("agent-settings-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_settings" }, () => {
        fetchAgentSettings(supabase).then(setAgentSettings).catch(() => {});
      })
      .subscribe(
        realtimeStatusHandler("agent-settings-changes", () => {
          fetchAgentSettings(supabase).then(setAgentSettings).catch(() => {});
        })
      );

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  // El tope se mide igual que en `agent_can_run()`: sin tope configurado no
  // hay nada que alcanzar.
  const spendCapReached =
    agentSettings.dailySpendCapUsd !== null &&
    agentSettings.spentTodayUsd >= agentSettings.dailySpendCapUsd;

  // En pantallas estrechas la bandeja y la conversación no caben a la vez, así
  // que se turnan. En pantallas anchas este estado no afecta a nada.
  const [mobileView, setMobileView] = useState<"list" | "chat">(
    initialConversationId ? "chat" : "list"
  );

  /**
   * La cola de envío de textos. Vive acá y no en el cuadro de texto a
   * propósito: el composer se desmonta al cambiar de chat, y un envío en
   * vuelo atado a él moría con el cambio — el texto volvía al cuadro de un
   * chat que ya no estaba abierto, o se perdía. Desde acá, el mensaje se
   * entrega (o falla a la vista, con su reintento) sin importar por dónde
   * ande el asesor.
   */
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  /** Los envíos que ya salieron por la red, para no dispararlos dos veces. */
  const outboxInFlight = useRef(new Set<string>());

  const enqueueOutboxText = useCallback(
    (conversationId: string, content: string, replyToMessageId: string | null) => {
      setOutbox((queue) => enqueueText(queue, conversationId, content, replyToMessageId));
    },
    []
  );

  const retryOutboxItem = useCallback((localId: string) => {
    setOutbox((queue) => retryItem(queue, localId));
  }, []);

  const discardOutboxItem = useCallback((localId: string) => {
    setOutbox((queue) => discardItem(queue, localId));
  }, []);

  // El motor de la cola: cada cambio en ella dispara, si toca, los envíos que
  // siguen. Dentro de una conversación va uno a la vez —el que está en vuelo
  // sigue siendo la cabeza y frena a los suyos— para que el cliente lea los
  // mensajes en el orden en que se escribieron; entre conversaciones no hay
  // orden que cuidar y avanzan en paralelo. El estado solo cambia cuando el
  // servidor contesta: quién está en vuelo lo recuerda el ref, no el estado.
  useEffect(() => {
    for (const head of sendableHeads(outbox)) {
      if (outboxInFlight.current.has(head.localId)) continue;
      const localId = head.localId;
      outboxInFlight.current.add(localId);

      sendMessage(head.conversationId, head.content, false, head.replyToMessageId)
        .then((sentMessageId) => {
          setOutbox((queue) => markSent(queue, localId, sentMessageId));
        })
        .catch((err: unknown) => {
          setOutbox((queue) =>
            markFailed(queue, localId, err instanceof Error ? err.message : null)
          );
        })
        .finally(() => {
          outboxInFlight.current.delete(localId);
        });
    }
  }, [outbox]);

  // Cuando el mensaje real ya llegó al hilo por tiempo real, su burbuja
  // provisional sobra y se retira de la cola. Es un ajuste de estado durante
  // el render —el patrón de la guía de React, como el de ChatPanel al cambiar
  // de conversación—: pruneDelivered devuelve la misma referencia cuando no
  // hay nada que limpiar, así que no hay bucle.
  if (loadedThread) {
    const presentes = new Set(loadedThread.messages.map((m) => m.id));
    const limpia = pruneDelivered(outbox, presentes);
    if (limpia !== outbox) setOutbox(limpia);
  }

  // Cerrar la pestaña con mensajes sin entregar los perdería en silencio:
  // el navegador pregunta antes, que es lo único que puede hacerse por ellos.
  const hayEnviosPendientes = outbox.some((item) => item.status !== "sent");
  useEffect(() => {
    if (!hayEnviosPendientes) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hayEnviosPendientes]);

  function openConversation(id: string) {
    setSelectedId(id);
    setMobileView("chat");
  }

  /**
   * "Agregar contacto" (T6, 8/9/2026): la conversación que acaba de crear
   * `NewContactModal` (vía `inbox-sidebar.tsx`) todavía no está en
   * `conversations` -- nadie la bajó todavía, nació recién en la base --
   * así que abrir el chat sola no alcanza. El realtime de INSERT en
   * `conversations` (`use-live-conversations.ts:193`, todo evento que no
   * sea UPDATE cae a `requestListRefresh()`) también la traería, pero eso
   * puede tardar un ciclo entero; pedir la cabecera de una vez con
   * `refreshConversations` evita que el asesor vea el chat abierto y la
   * fila ausente de la bandeja al mismo tiempo.
   *
   * Sin traspaso a `conversation_handoffs`: la invariante "ningún lead
   * invisible" exige uno cuando `awaiting_reply` queda en `true` sin dueño,
   * y acá no hay ningún mensaje del cliente todavía -- esa columna
   * generada nace en `false` (ver el comentario en
   * `createContactConversation`, `lib/mutations.ts`).
   */
  function handleContactCreated(conversationId: string) {
    openConversation(conversationId);
    refreshConversations();
  }

  /**
   * La conversación completa del chat abierto (canal, ficha, venta), pedida
   * por id al seleccionarla. La lista ya no la trae: sus filas son filas de
   * bandeja, y cargar el detalle de 30 conversaciones para abrir una era el
   * grueso del payload medido.
   */
  const [detail, setDetail] = useState<Conversation | null>(null);

  const selectedSummary = conversations.find((c) => c.id === selectedId) ?? null;

  // El detalle llega una vez; lo que cambia en vivo (contador, vista previa,
  // estado, etiquetas) sigue llegando por la lista y se le superpone. Lo que
  // la fila no trae (asignación, venta) lo refresca el listener del detalle.
  const selectedConversation: Conversation | null =
    detail && detail.id === selectedId
      ? selectedSummary
        ? {
            ...detail,
            status: selectedSummary.status,
            unreadCount: selectedSummary.unreadCount,
            manuallyUnread: selectedSummary.manuallyUnread,
            aiEnabled: selectedSummary.aiEnabled,
            dealStatus: selectedSummary.dealStatus,
            dealVerified: selectedSummary.dealVerified,
            lastCustomerMessageAt: selectedSummary.lastCustomerMessageAt,
            lastMessageAt: selectedSummary.lastMessageAt,
            lastMessagePreview: selectedSummary.lastMessagePreview,
            lastMessageDirection: selectedSummary.lastMessageDirection,
            lastMessageStatus: selectedSummary.lastMessageStatus,
            journeyStage: selectedSummary.journeyStage,
            intent: selectedSummary.intent,
            activeTool: selectedSummary.activeTool,
            welcomeSentAt: selectedSummary.welcomeSentAt,
            contact: { ...detail.contact, tags: selectedSummary.contact.tags },
          }
        : detail
      : null;

  // Al abrir un chat solo se traen los últimos mensajes. Esto pide el tramo
  // anterior cuando el asesor lo pide, y recuerda cuándo ya no queda nada
  // atrás para dejar de ofrecerlo.
  const [loadingOlder, setLoadingOlder] = useState(false);

  const isLoadedThread = loadedThread?.conversationId === selectedId;
  const messages = isLoadedThread ? loadedThread.messages : [];
  const notes = isLoadedThread ? loadedThread.notes : [];
  const reachedStart = isLoadedThread ? loadedThread.reachedStart : false;
  /** El hilo abierto todavía no llegó: el panel muestra un esqueleto, no un vacío. */
  const loadingMessages = selectedId !== null && !isLoadedThread;

  const loadOlderMessages = useCallback(async () => {
    // Se lee del estado y no de `messages`: ese es un derivado condicional, y
    // depender de él recrearía este callback en cada render.
    const oldest =
      loadedThread?.conversationId === selectedId ? loadedThread.messages[0] : undefined;
    if (!selectedId || !oldest || loadingOlder) return;

    setLoadingOlder(true);
    try {
      const older = await fetchMessagesBefore(supabase, selectedId, oldest.createdAt);
      setLoadedThread((current) => {
        // El asesor pudo cambiar de chat mientras esto viajaba: lo que llegó
        // es de otro hilo y no tiene dónde ir.
        if (current?.conversationId !== selectedId) return current;
        if (older.length === 0) return { ...current, reachedStart: true };
        return { ...current, messages: [...older, ...current.messages] };
      });
    } catch {
      // Falló el tramo viejo: el chat sigue usable con lo que ya está cargado.
    } finally {
      setLoadingOlder(false);
    }
  }, [supabase, selectedId, loadedThread, loadingOlder]);

  /**
   * Apartar y desapartar un chat desde el menú de la bandeja.
   *
   * El estado local se mueve antes que la base: el asesor acaba de elegir la
   * acción en un menú y espera verla aplicada, no esperar el viaje de ida y
   * vuelta. Si la escritura falla, el refetch devuelve la lista a la verdad.
   */
  const markUnread = useCallback(
    async (conversationId: string) => {
      setConversations((current) =>
        current.map((c) => (c.id === conversationId ? { ...c, manuallyUnread: true } : c))
      );
      // Un chat apartado que sigue abierto se contradice a sí mismo: el
      // asesor lo está leyendo. Se cierra, como en WhatsApp.
      setSelectedId((current) => (current === conversationId ? null : current));
      setMobileView("list");
      try {
        await markConversationUnread(supabase, conversationId);
        // La fila ya se movió sola en memoria; lo que falta es que la
        // píldora "No leídas" refleje el nuevo total (ver refreshInboxCounts).
        refreshInboxCounts();
      } catch {
        refreshConversations();
      }
    },
    [supabase, refreshConversations, refreshInboxCounts, setConversations]
  );

  const markRead = useCallback(
    async (conversationId: string) => {
      setConversations((current) =>
        current.map((c) =>
          c.id === conversationId ? { ...c, manuallyUnread: false, unreadCount: 0 } : c
        )
      );
      try {
        await markConversationRead(supabase, conversationId);
        refreshInboxCounts();
      } catch {
        refreshConversations();
      }
    },
    [supabase, refreshConversations, refreshInboxCounts, setConversations]
  );

  /**
   * Cerrar y reabrir desde el menú de la bandeja (T2.1, 5/9/2026). Mismo
   * patrón optimista que `markUnread`/`markRead`: el estado local se mueve
   * antes que la base y un refetch corrige si la escritura falla. El
   * traspaso que la ruta deja en `conversation_handoffs` no necesita
   * reflejo acá — la fila lo pinta a través de `status`, que ya viaja por
   * el canal de realtime de "Todos" (outcome "applied" en
   * use-live-conversations.ts) sin que este componente sepa nada de
   * bitácoras.
   */
  const handleCloseConversation = useCallback(
    async (conversationId: string) => {
      setConversations((current) =>
        current.map((c) => (c.id === conversationId ? { ...c, status: "closed" } : c))
      );
      try {
        await closeConversation(conversationId);
        refreshInboxCounts();
      } catch {
        refreshConversations();
      }
    },
    [refreshConversations, refreshInboxCounts, setConversations]
  );

  const handleReopenConversation = useCallback(
    async (conversationId: string) => {
      setConversations((current) =>
        current.map((c) => (c.id === conversationId ? { ...c, status: "open" } : c))
      );
      try {
        await reopenConversation(conversationId);
        refreshInboxCounts();
      } catch {
        refreshConversations();
      }
    },
    [refreshConversations, refreshInboxCounts, setConversations]
  );

  /**
   * El botón "Abrir el chat de {newPhone}" del aviso de cambio de número
   * (D2, "El cliente que cambió de número", 6/9/2026; botón del 8/9/2026):
   * cuando el número nuevo ya tenía conversación propia el webhook no
   * fusiona nada, y esto es lo que le da al asesor el salto directo en vez
   * de tener que buscar el otro chat a mano. `openConversation` funciona
   * aunque la fila no esté en la ventana cargada de la lista — el detalle se
   * pide por id (líneas ~477-500).
   */
  const handleOpenConversationByPhone = useCallback(
    async (phone: string): Promise<boolean> => {
      try {
        const conversationId = await fetchConversationIdByPhone(supabase, phone);
        if (!conversationId) return false;
        openConversation(conversationId);
        return true;
      } catch (err) {
        // `log.ts` es `server-only` (ver `realtimeStatusHandler` más arriba
        // en este mismo archivo): `console.error` con el nombre del evento
        // deja el rastro sin arrastrar ese módulo al navegador.
        console.error("conversacion_por_telefono_no_resuelta", err);
        return false;
      }
    },
    [supabase]
  );

  // Mensajes rápidos compartidos entre agentes: se sincronizan en vivo.
  useEffect(() => {
    const channel = supabase
      .channel("quick-replies-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "quick_replies" }, () => {
        fetchQuickReplies(supabase).then(setQuickReplies).catch(() => {});
      })
      .subscribe(
        realtimeStatusHandler("quick-replies-changes", () => {
          fetchQuickReplies(supabase).then(setQuickReplies).catch(() => {});
        })
      );

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  // Catálogo de etiquetas compartido entre agentes: se sincroniza en vivo.
  useEffect(() => {
    const channel = supabase
      .channel("tags-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "tags" }, () => {
        fetchTags(supabase).then(setTags).catch(() => {});
      })
      .subscribe(
        realtimeStatusHandler("tags-changes", () => {
          fetchTags(supabase).then(setTags).catch(() => {});
        })
      );

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  // Carga el detalle de la conversación seleccionada y se suscribe a sus mensajes y notas nuevas.
  useEffect(() => {
    if (!selectedId) return;
    const conversationId = selectedId;

    let cancelled = false;
    // La fila que la bandeja tiene de este hilo, si lo tiene: es la que está
    // al día por realtime, así que manda sobre el detalle para decidir si el
    // chat estaba sin leer o apartado.
    const summaryAtOpen = conversations.find((c) => c.id === conversationId);
    // Las notas se suscriben recién cuando el detalle dice quién es el
    // contacto; la variable vive acá para que el cleanup la alcance.
    let notesChannel: ReturnType<typeof supabase.channel> | null = null;

    function refreshNotes(contactId: string) {
      fetchNotes(supabase, contactId).then((data) => {
        if (cancelled) return;
        setLoadedThread((current) =>
          current?.conversationId === conversationId ? { ...current, notes: data } : current
        );
      });
    }

    (async () => {
      // El detalle y los mensajes viajan en paralelo; las plantillas y las
      // notas esperan al detalle, que es quien sabe el canal y el contacto.
      const [detailData, messagesData] = await Promise.all([
        fetchConversation(supabase, conversationId),
        fetchMessages(supabase, conversationId, { limit: CHAT_MESSAGES_WINDOW }),
      ]);
      if (cancelled) return;

      if (!detailData) {
        // El hilo ya no existe, o el enlace vino con un id inválido: dejarlo
        // seleccionado sería una pantalla de carga eterna.
        setSelectedId((current) => (current === conversationId ? null : current));
        setMobileView("list");
        return;
      }

      setDetail(detailData);
      setLoadedThread({
        conversationId,
        messages: messagesData,
        notes: [],
        reachedStart: messagesData.length < CHAT_MESSAGES_WINDOW,
      });

      const contactId = detailData.contact.id;
      refreshNotes(contactId);
      fetchTemplates(supabase, detailData.channel.id).then((data) => {
        if (!cancelled) setTemplates(data);
      });

      notesChannel = supabase
        .channel(`notes-${contactId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "notes", filter: `contact_id=eq.${contactId}` },
          () => refreshNotes(contactId)
        )
        .subscribe();

      // También cuando el contador está en cero: el chat puede estar apartado
      // a mano, y abrirlo es exactamente lo que deshace ese apartado.
      const flags = summaryAtOpen ?? detailData;
      if (flags.unreadCount > 0 || flags.manuallyUnread) {
        // Abrir el chat es lo que lo saca de "No leídas": la píldora tiene
        // que enterarse ahora, no en la pasada de fondo (ver refreshInboxCounts).
        markConversationRead(supabase, conversationId)
          .then(refreshInboxCounts)
          .catch(() => {});
        // El doble check azul (T3.1, 4/9/2026) es un efecto aparte hacia
        // Meta, no hacia el CRM: abrir el chat es "de verdad se leyó", así
        // que viaja junto con el marcado de arriba.
        sendReadReceipt(conversationId);
      }
    })();

    // Timer propio de esta ejecución del efecto (no un useRef del componente):
    // así, al cambiar de conversación, el cleanup de abajo cancela cualquier
    // refetch pendiente en vez de dejarlo disparar para la conversación vieja.
    let messagesRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
    function scheduleMessagesRefresh() {
      if (messagesRefreshTimeout) clearTimeout(messagesRefreshTimeout);
      messagesRefreshTimeout = setTimeout(() => {
        messagesRefreshTimeout = null;
        fetchMessages(supabase, conversationId, { limit: CHAT_MESSAGES_WINDOW }).then((data) => {
          if (cancelled) return;
          setLoadedThread((current) =>
            current?.conversationId === conversationId ? { ...current, messages: data } : current
          );
        });
      }, REALTIME_DEBOUNCE_MS);
    }

    // La fila de la lista no trae la asignación ni la venta: cuando cambian,
    // el detalle del chat abierto se vuelve a pedir por id. Debounced igual
    // que los mensajes para no refetchear por cada UPDATE encadenado.
    let detailRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
    function scheduleDetailRefresh() {
      if (detailRefreshTimeout) clearTimeout(detailRefreshTimeout);
      detailRefreshTimeout = setTimeout(() => {
        detailRefreshTimeout = null;
        fetchConversation(supabase, conversationId).then((data) => {
          if (cancelled || !data) return;
          setDetail((current) => (current?.id === conversationId || current === null ? data : current));
        });
      }, REALTIME_DEBOUNCE_MS);
    }

    // T1.1 (4/9/2026): lo que llega mientras el asesor no está mirando este
    // chat de verdad —pestaña de fondo, o esta ventana sin el foco— no se
    // puede dar por leído todavía. Antes, el INSERT marcaba leído sin
    // preguntar nada: con dos pestañas abiertas (una al frente, esta de
    // fondo con el mismo chat) un mensaje nuevo apagaba "No leídas" en la de
    // atrás sin que nadie lo hubiera visto — F5 en la de adelante lo
    // delataba, porque ahí la píldora seguía encendida.
    let pendingRead = false;

    function markReadNow() {
      markConversationRead(supabase, conversationId)
        .then(refreshInboxCounts)
        .catch(() => {});
      // Mismo motivo que al abrir el chat: esto solo corre cuando de verdad
      // se marca leído (el chat al frente y con foco, o recién recuperó el
      // foco con algo pendiente) — nunca en el apartado/desapartado a mano de
      // markRead/markUnread, que no prueban que el asesor haya mirado nada.
      sendReadReceipt(conversationId);
    }

    // Se enteran del regreso por cualquiera de las dos señales: cambiar de
    // pestaña dispara "visibilitychange"; volver a esta ventana desde otra
    // (la pestaña ya estaba al frente, solo faltaba el foco) dispara "focus".
    function onPresenceReturn() {
      if (!pendingRead) return;
      // `document.hidden` y no `visibilityState` directo: es la misma señal
      // que ya usa `use-live-refresh.ts` para la pestaña oculta, y las dos
      // viajan sincronizadas en todo navegador real.
      if (!shouldFlushDeferred(document.hidden ? "hidden" : "visible")) return;
      pendingRead = false;
      markReadNow();
    }

    document.addEventListener("visibilitychange", onPresenceReturn);
    window.addEventListener("focus", onPresenceReturn);

    // "*" y no "INSERT": media_url llega tarde —el webhook guarda el mensaje
    // sin archivo para contestarle a Meta dentro de sus 20s y baja el archivo
    // después, en un after()— y los checks de entrega (sent/delivered/read)
    // que confirma WhatsApp también son UPDATE sobre una fila que ya existe.
    // Escuchando solo INSERT, la burbuja se quedaba clavada en "no se pudo
    // recibir" y el doble check nunca avanzaba.
    const messagesChannel = supabase
      .channel(`messages-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `conversation_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          scheduleMessagesRefresh();
          // Dar por leído es cosa de mensajes nuevos. Rellenar el archivo de
          // uno viejo no significa que nadie lo haya mirado, y marcarlo aquí
          // escribiría en conversations por cada descarga que termina.
          if (payload.eventType === "INSERT" && row.direction === "inbound") {
            // Mismo motivo que al abrir el chat: el mensaje entra y sale
            // leído al toque porque el chat ya está abierto, y la píldora
            // tiene que verlo sin esperar la pasada de fondo — pero solo si
            // de verdad está abierto delante del asesor ahora mismo.
            const decision = decideReadOnArrival({
              visibilityState: document.hidden ? "hidden" : "visible",
              hasFocus: document.hasFocus(),
            });
            if (decision === "mark") {
              markReadNow();
            } else {
              pendingRead = true;
            }
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${selectedId}` },
        () => scheduleDetailRefresh()
      )
      .subscribe(realtimeStatusHandler(`messages-${selectedId}`, () => scheduleMessagesRefresh()));

    return () => {
      cancelled = true;
      if (messagesRefreshTimeout) clearTimeout(messagesRefreshTimeout);
      if (detailRefreshTimeout) clearTimeout(detailRefreshTimeout);
      document.removeEventListener("visibilitychange", onPresenceReturn);
      window.removeEventListener("focus", onPresenceReturn);
      supabase.removeChannel(messagesChannel);
      if (notesChannel) supabase.removeChannel(notesChannel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, supabase]);

  return (
    <div className="crm" data-view={mobileView}>
      <AppRail active="bandeja" variant="crm" />

      <div className="crm-columns">
        <section className="crm-column crm-inbox">
          <InboxSidebar
            conversations={conversations}
            selectedId={selectedId}
            onSelect={openConversation}
            currentAgent={currentAgent}
            // `tagsInUse`, no el estado `tags` de abajo (ese alimenta a
            // `ContextPanel`, que necesita ver TODAS las etiquetas — ver el
            // comentario de la prop `tagsInUse` en `CrmShellProps`).
            allTags={tagsInUse}
            bcvRate={bcvRate}
            onMarkUnread={markUnread}
            onMarkRead={markRead}
            onCloseConversation={handleCloseConversation}
            onReopenConversation={handleReopenConversation}
            hasMore={allPager.hasMore}
            loadingMore={allPager.loadingMore}
            onLoadMore={allPager.loadMore}
            // A.T4 (29/8/2026): si la página siguiente de "Todos" se cae,
            // el sidebar necesita saberlo para avisar en vez de seguir
            // ofreciendo "Cargar más" como si nada hubiera pasado — mismo
            // `allPager` que ya presta las tres props de arriba.
            lastPageFailed={allPager.lastPageFailed}
            counts={inboxCounts}
            initialPendingRows={initialPendingConversations}
            livePulse={livePulse}
            onContactCreated={handleContactCreated}
            dayScope={dayScope}
            dayStart={dayStart}
            onDayScopeChange={handleDayScopeChange}
          />
        </section>

        <section className="crm-column crm-chat">
          {selectedConversation ? (
            <ChatPanel
              conversation={selectedConversation}
              messages={messages}
              templates={templates}
              quickReplies={quickReplies}
              currentAgent={currentAgent}
              loadingMessages={loadingMessages}
              aiGloballyEnabled={agentSettings.aiGloballyEnabled}
              spendCapReached={spendCapReached}
              hasOlderMessages={!reachedStart}
              loadingOlderMessages={loadingOlder}
              onLoadOlderMessages={loadOlderMessages}
              onBack={() => setMobileView("list")}
              outboxItems={outbox.filter((item) => item.conversationId === selectedConversation.id)}
              onSendText={(content, replyToMessageId) =>
                enqueueOutboxText(selectedConversation.id, content, replyToMessageId)
              }
              onRetryOutbox={retryOutboxItem}
              onDiscardOutbox={discardOutboxItem}
              onOpenConversationByPhone={handleOpenConversationByPhone}
            />
          ) : selectedId ? (
            // El detalle del hilo está en camino. Sin este estado intermedio,
            // el panel de inicio parpadearía entre el clic y la respuesta.
            <p className="crm-empty">Abriendo la conversación…</p>
          ) : (
            <AgentHomePanel
              currentAgent={currentAgent}
              counts={inboxCounts}
              agentSettings={agentSettings}
              agentDay={agentDay}
              aiAssignments={aiAssignments}
            />
          )}
        </section>

        <aside className="crm-column crm-context">
          {selectedConversation ? (
            <ContextPanel
              conversation={selectedConversation}
              messages={messages}
              notes={notes}
              allTags={tags}
              currentAgent={currentAgent}
            />
          ) : (
            // Sin esto la columna queda como un panel blanco sin explicación:
            // parece un fallo de carga, no un lugar esperando contenido.
            <p className="crm-context-empty">Datos del cliente</p>
          )}
        </aside>
      </div>
    </div>
  );
}
