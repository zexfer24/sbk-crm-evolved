"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageCircle } from "lucide-react";
import type { Agent, Conversation, Message, Note, QuickReply, Tag, WhatsappTemplate } from "@/lib/types";
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
} from "@/lib/data";
import { markConversationRead } from "@/lib/mutations";
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
}

export function CrmShell({
  currentAgent,
  initialConversations,
  allTags,
  initialQuickReplies,
  bcvRate,
  initialConversationId,
}: CrmShellProps) {
  const supabase = useMemo(() => createClient(), []);

  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversations.find((c) => c.id === initialConversationId)?.id ??
      initialConversations[0]?.id ??
      null
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [templates, setTemplates] = useState<WhatsappTemplate[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>(initialQuickReplies);
  const [tags, setTags] = useState<Tag[]>(allTags);

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
  const [reachedStart, setReachedStart] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const loadOlderMessages = useCallback(async () => {
    const oldest = messages[0];
    if (!selectedId || !oldest || loadingOlder) return;

    setLoadingOlder(true);
    try {
      const older = await fetchMessagesBefore(supabase, selectedId, oldest.createdAt);
      if (older.length === 0) {
        setReachedStart(true);
        return;
      }
      setMessages((current) => [...older, ...current]);
    } catch {
      // Falló el tramo viejo: el chat sigue usable con lo que ya está cargado.
    } finally {
      setLoadingOlder(false);
    }
  }, [supabase, selectedId, messages, loadingOlder]);

  const refreshConversations = useCallback(async () => {
    try {
      const data = await fetchConversations(supabase, { limit: INBOX_CONVERSATIONS_LIMIT });
      setConversations(data);
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase]);

  const scheduleRefreshConversations = useDebouncedCallback(refreshConversations, REALTIME_DEBOUNCE_MS);

  // Mantiene la bandeja sincronizada entre todos los agentes conectados. También
  // escucha contact_tags: asignar/quitar una etiqueta no toca la fila de
  // conversations, así que sin esto el chip de etiquetas no se actualizaría en vivo.
  // Con 400 chats/día y varios agentes conectados, agrupar estos refrescos evita
  // saturar la base con un refetch completo por cada evento casi simultáneo.
  useEffect(() => {
    const channel = supabase
      .channel("conversations-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        scheduleRefreshConversations();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "contact_tags" }, () => {
        scheduleRefreshConversations();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, scheduleRefreshConversations]);

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
      setReachedStart(messagesData.length < CHAT_MESSAGES_WINDOW);
      setMessages(messagesData);
      setNotes(notesData);
      setTemplates(templatesData);

      if (conversation && conversation.unreadCount > 0) {
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
          if (!cancelled) setMessages(data);
        });
      }, REALTIME_DEBOUNCE_MS);
    }

    const messagesChannel = supabase
      .channel(`messages-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          scheduleMessagesRefresh();
          if (row.direction === "inbound") {
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
                if (!cancelled) setNotes(data);
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
