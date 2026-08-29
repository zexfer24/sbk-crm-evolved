"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  AgentSettings,
  Conversation,
  ConversationSummary,
  Message,
  Note,
  QuickReply,
  Tag,
  WhatsappTemplate,
} from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import {
  CHAT_MESSAGES_WINDOW,
  INBOX_PAGE_SIZE,
  fetchConversation,
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
import { cursorAfterPage, type ConversationCursor } from "@/lib/inbox-paging";
import { markConversationRead, markConversationUnread, sendMessage } from "@/lib/mutations";
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
import { useLiveConversations } from "@/lib/use-live-conversations";
import { REALTIME_DEBOUNCE_MS } from "@/lib/use-live-refresh";
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";
import { AgentHomePanel } from "@/components/inbox/agent-home-panel";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";
import { ChatPanel } from "@/components/chat/chat-panel";
import { ContextPanel } from "@/components/context-panel/context-panel";
import { AppRail } from "@/components/app-rail";
import "@/components/crm.css";

/**
 * Une dos tramos de la lista sin repetir: el primero manda.
 *
 * Sirve para las dos costuras de la bandeja paginada. Al refrescar en vivo,
 * `mergeById(cabecera, actual)` deja mandar lo recién traído y conserva las
 * páginas viejas. Al bajar una página, `mergeById(actual, página)` la pega al
 * final. En los dos casos, una conversación que se movió entre medias aparece
 * una sola vez.
 */
function mergeById(
  first: ConversationSummary[],
  second: ConversationSummary[]
): ConversationSummary[] {
  const seen = new Set(first.map((c) => c.id));
  return [...first, ...second.filter((c) => !seen.has(c.id))];
}

interface CrmShellProps {
  currentAgent: Agent;
  initialConversations: ConversationSummary[];
  /** Los contadores del panel de inicio, ya contados en el servidor. */
  initialInboxCounts: InboxCounts;
  /**
   * Las filas de "No leídas" ya resueltas en el servidor. Siembra
   * `InboxSidebar` para que la píldora abra con datos en vez del cartel
   * "Buscando…"; el efecto de red del montar los refresca igual. Opcional (y
   * no `[]` por defecto acá arriba, sino en el destructuring de abajo) para
   * no obligar a cada instanciación existente de `CrmShell` a conocer este
   * dato nuevo.
   */
  initialUnreadConversations?: ConversationSummary[];
  allTags: Tag[];
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
}

export function CrmShell({
  currentAgent,
  initialConversations,
  initialInboxCounts,
  initialUnreadConversations = [],
  allTags,
  initialQuickReplies,
  bcvRate,
  initialConversationId,
  initialAgentSettings,
}: CrmShellProps) {
  const supabase = useMemo(() => createClient(), []);

  const [loadingMore, setLoadingMore] = useState(false);
  /** La última página vino corta: no queda nada más atrás que ofrecer. */
  const [reachedEnd, setReachedEnd] = useState(initialConversations.length < INBOX_PAGE_SIZE);
  const [inboxCounts, setInboxCounts] = useState<InboxCounts>(initialInboxCounts);

  /**
   * El refresco en vivo pide solo la cabecera y conserva lo que el asesor
   * bajó. Antes rearmaba la ventana entera: quien había bajado seis veces
   * pagaba 135 KB y 1,2 s en cada evento que no se resolviera en memoria.
   * La cabecera basta porque una conversación con movimiento sube al tope, y
   * lo que cambia sin subir se pide de a una fila (`fetchRow`).
   *
   * De paso refresca los contadores del panel de inicio: cambian por los
   * mismos eventos y el viaje ya está hecho.
   */
  const fetchInboxHead = useCallback(
    async (current: ConversationSummary[]) => {
      const [head, counts] = await Promise.all([
        fetchConversations(supabase, { limit: INBOX_PAGE_SIZE }),
        fetchInboxCounts(supabase, currentAgent.id),
      ]);
      setInboxCounts(counts);
      return mergeById(head, current);
    },
    [supabase, currentAgent.id]
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
      setInboxCounts(await fetchInboxCounts(supabase, currentAgent.id));
    } catch {
      // Los contadores se quedan con el valor anterior; el próximo evento en
      // vivo o la próxima mutación reintenta.
    }
  }, [supabase, currentAgent.id]);

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
   * El punto desde donde retomar la próxima página: la última fila de la
   * última página recibida (`inbox-paging.ts`), no un contador de posición.
   * Un `offset` se rompe apenas una fila cruza el borde de página mientras
   * el asesor sigue bajando la lista —sube al tope y corre a todas las de
   * abajo una posición— y la página siguiente, pedida por número de fila,
   * salta justo la que cruzó (confirmado en producción el 29/8/2026: la
   * píldora "Todos" reordenaba ~3 veces/minuto y esas filas no volvían
   * nunca). El cursor pide "lo que sigue después de esta fila", así que un
   * reordenamiento en el medio no le afecta. Vive en un ref y no en estado:
   * no pinta nada, y guardarlo en estado dispararía un render de más en cada
   * página.
   */
  const cursorRef = useRef<ConversationCursor | null>(cursorAfterPage(initialConversations));

  const loadMoreConversations = useCallback(async () => {
    if (loadingMore || reachedEnd) return;
    setLoadingMore(true);
    try {
      const page = await fetchConversations(supabase, {
        cursor: cursorRef.current ?? undefined,
        limit: INBOX_PAGE_SIZE,
      });
      if (page.length < INBOX_PAGE_SIZE) setReachedEnd(true);
      if (page.length > 0) {
        cursorRef.current = cursorAfterPage(page);
        setConversations((current) => mergeById(current, page));
      }
    } catch {
      // La bandeja sigue con lo que ya tiene; el próximo intento reintenta.
    } finally {
      setLoadingMore(false);
    }
  }, [supabase, loadingMore, reachedEnd, setConversations]);

  // Sin conversación de inicio no se abre ninguna: abrir la primera de la
  // lista ponía al asesor a leer un chat que no eligió —y lo daba por leído—
  // antes de decidir nada. El id explícito (llegar desde una tarjeta del
  // dashboard) sí abre directo, porque ahí la elección ya está hecha — y se
  // respeta aunque el hilo no esté en la ventana cargada: el detalle se pide
  // por id, no se busca en la lista.
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId ?? null);
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
      .subscribe();

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

  // Mensajes rápidos compartidos entre agentes: se sincronizan en vivo.
  useEffect(() => {
    const channel = supabase
      .channel("quick-replies-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "quick_replies" }, () => {
        fetchQuickReplies(supabase).then(setQuickReplies).catch(() => {});
      })
      .subscribe();

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
      .subscribe();

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
            // tiene que verlo sin esperar la pasada de fondo.
            markConversationRead(supabase, selectedId)
              .then(refreshInboxCounts)
              .catch(() => {});
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${selectedId}` },
        () => scheduleDetailRefresh()
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (messagesRefreshTimeout) clearTimeout(messagesRefreshTimeout);
      if (detailRefreshTimeout) clearTimeout(detailRefreshTimeout);
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
            allTags={tags}
            bcvRate={bcvRate}
            onMarkUnread={markUnread}
            onMarkRead={markRead}
            hasMore={!reachedEnd}
            loadingMore={loadingMore}
            onLoadMore={loadMoreConversations}
            counts={inboxCounts}
            initialUnreadRows={initialUnreadConversations}
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
