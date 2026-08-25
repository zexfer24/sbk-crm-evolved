"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  AgentSettings,
  Conversation,
  Message,
  Note,
  QuickReply,
  Tag,
  WhatsappTemplate,
} from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import {
  CHAT_MESSAGES_WINDOW,
  INBOX_CONVERSATIONS_LIMIT,
  fetchMessages,
  fetchMessagesBefore,
  fetchNotes,
  fetchQuickReplies,
  fetchTags,
  fetchTemplates,
  fetchAgentSettings,
} from "@/lib/data";
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

interface CrmShellProps {
  currentAgent: Agent;
  initialConversations: Conversation[];
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
  allTags,
  initialQuickReplies,
  bcvRate,
  initialConversationId,
  initialAgentSettings,
}: CrmShellProps) {
  const supabase = useMemo(() => createClient(), []);

  // La lista viva: aplica en memoria lo que el evento ya trae, agrupa los
  // refetch inevitables, y no trabaja contra una pestaña que nadie mira.
  const { conversations, setConversations, refreshConversations } = useLiveConversations(
    supabase,
    initialConversations,
    { limit: INBOX_CONVERSATIONS_LIMIT, watchContactTags: true, channelName: "conversations-changes" }
  );
  // Sin conversación de inicio no se abre ninguna: abrir la primera de la
  // lista ponía al asesor a leer un chat que no eligió —y lo daba por leído—
  // antes de decidir nada. El id explícito (llegar desde una tarjeta del
  // dashboard) sí abre directo, porque ahí la elección ya está hecha.
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversations.find((c) => c.id === initialConversationId)?.id ?? null
  );
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

  const selectedConversation = conversations.find((c) => c.id === selectedId) ?? null;

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
      } catch {
        refreshConversations();
      }
    },
    [supabase, refreshConversations, setConversations]
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
      } catch {
        refreshConversations();
      }
    },
    [supabase, refreshConversations, setConversations]
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
    const conversation = conversations.find((c) => c.id === selectedId);
    const contactId = conversation?.contact.id;


    (async () => {
      const [messagesData, notesData, templatesData] = await Promise.all([
        fetchMessages(supabase, selectedId, { limit: CHAT_MESSAGES_WINDOW }),
        contactId ? fetchNotes(supabase, contactId) : Promise.resolve([]),
        conversation ? fetchTemplates(supabase, conversation.channel.id) : Promise.resolve([]),
      ]);
      if (cancelled) return;
      setLoadedThread({
        conversationId,
        messages: messagesData,
        notes: notesData,
        reachedStart: messagesData.length < CHAT_MESSAGES_WINDOW,
      });
      setTemplates(templatesData);

      // También cuando el contador está en cero: el chat puede estar apartado
      // a mano, y abrirlo es exactamente lo que deshace ese apartado.
      if (conversation && (conversation.unreadCount > 0 || conversation.manuallyUnread)) {
        markConversationRead(supabase, selectedId).catch(() => {});
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
            markConversationRead(supabase, selectedId).catch(() => {});
          }
        }
      )
      .subscribe();

    const notesChannel = contactId
      ? supabase
          .channel(`notes-${contactId}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "notes", filter: `contact_id=eq.${contactId}` },
            () => {
              fetchNotes(supabase, contactId).then((data) => {
                if (cancelled) return;
                setLoadedThread((current) =>
                  current?.conversationId === conversationId ? { ...current, notes: data } : current
                );
              });
            }
          )
          .subscribe()
      : null;

    return () => {
      cancelled = true;
      if (messagesRefreshTimeout) clearTimeout(messagesRefreshTimeout);
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
          ) : (
            <AgentHomePanel
              currentAgent={currentAgent}
              conversations={conversations}
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
