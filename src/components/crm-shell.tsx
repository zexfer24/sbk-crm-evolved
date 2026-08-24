"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
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
  fetchConversations,
  fetchMessages,
  fetchMessagesBefore,
  fetchNotes,
  fetchQuickReplies,
  fetchTags,
  fetchTemplates,
  fetchAgentSettings,
} from "@/lib/data";
import { markConversationRead, markConversationUnread } from "@/lib/mutations";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";

/**
 * Ventana de agrupación para refrescos disparados por tiempo real. Un
 * cliente que manda varios mensajes seguidos, o varios agentes moviendo
 * conversaciones a la vez, no deben disparar un refetch completo por cada
 * evento — mismo valor que ya usa el panel de Control de IA.
 */
const REALTIME_DEBOUNCE_MS = 750;
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";
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

  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversations.find((c) => c.id === initialConversationId)?.id ??
      initialConversations[0]?.id ??
      null
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

  const refreshConversations = useCallback(async () => {
    try {
      const data = await fetchConversations(supabase, { limit: INBOX_CONVERSATIONS_LIMIT });
      setConversations(data);
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase]);

  const scheduleRefreshConversations = useDebouncedCallback(refreshConversations, REALTIME_DEBOUNCE_MS);

  /**
   * Quedó un cambio sin atender porque la pestaña no estaba a la vista.
   *
   * Un asesor deja el CRM abierto todo el día en una pestaña de fondo, y cada
   * evento de realtime dispara un refetch de la bandeja entera —doscientas
   * conversaciones, unos 230 KB—. Multiplicado por los agentes conectados, es
   * trabajo constante que nadie está mirando y que le quita aire al que sí
   * tiene el CRM delante. Mientras no se ve, se anota; al volver, una sola
   * puesta al día.
   */
  const pendingWhileHidden = useRef(false);

  const requestRefreshConversations = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) {
      pendingWhileHidden.current = true;
      return;
    }
    scheduleRefreshConversations();
  }, [scheduleRefreshConversations]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.hidden || !pendingWhileHidden.current) return;
      pendingWhileHidden.current = false;
      // Directo y no por el agrupador: al volver a la pestaña se quiere la
      // bandeja al día ya, no tres cuartos de segundo después.
      refreshConversations();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshConversations]);

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
    [supabase, refreshConversations]
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
    [supabase, refreshConversations]
  );

  // Mantiene la bandeja sincronizada entre todos los agentes conectados. También
  // escucha contact_tags: asignar/quitar una etiqueta no toca la fila de
  // conversations, así que sin esto el chip de etiquetas no se actualizaría en vivo.
  // Con 400 chats/día y varios agentes conectados, agrupar estos refrescos evita
  // saturar la base con un refetch completo por cada evento casi simultáneo.
  useEffect(() => {
    const channel = supabase
      .channel("conversations-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        requestRefreshConversations();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "contact_tags" }, () => {
        requestRefreshConversations();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, requestRefreshConversations]);

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
            />
          ) : (
            <div className="crm-empty" style={{ margin: "auto" }}>
              <MessageCircle size={28} strokeWidth={1.6} />
              <p>Elige una conversación para empezar</p>
            </div>
          )}
        </section>

        <aside className="crm-column crm-context">
          {selectedConversation && (
            <ContextPanel
              conversation={selectedConversation}
              messages={messages}
              notes={notes}
              allTags={tags}
              currentAgent={currentAgent}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
