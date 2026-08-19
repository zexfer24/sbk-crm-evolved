"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inbox, LogOut, MessageCircle, Route } from "lucide-react";
import type { Agent, Conversation, Message, Note, QuickReply, Tag, WhatsappTemplate } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchConversations, fetchMessages, fetchNotes, fetchQuickReplies, fetchTemplates } from "@/lib/data";
import { markConversationRead } from "@/lib/mutations";
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";
import { ChatPanel } from "@/components/chat/chat-panel";
import { ContextPanel } from "@/components/context-panel/context-panel";
import "@/components/crm.css";

interface CrmShellProps {
  currentAgent: Agent;
  initialConversations: Conversation[];
  allTags: Tag[];
  initialQuickReplies: QuickReply[];
  /** Hilo a abrir al entrar, por ejemplo al llegar desde una tarjeta del dashboard. */
  initialConversationId?: string;
}

export function CrmShell({
  currentAgent,
  initialConversations,
  allTags,
  initialQuickReplies,
  initialConversationId,
}: CrmShellProps) {
  const router = useRouter();
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

  const refreshConversations = useCallback(async () => {
    try {
      const data = await fetchConversations(supabase);
      setConversations(data);
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase]);

  // Mantiene la bandeja sincronizada entre todos los agentes conectados.
  useEffect(() => {
    const channel = supabase
      .channel("conversations-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        refreshConversations();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, refreshConversations]);

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

  // Carga el detalle de la conversación seleccionada y se suscribe a sus mensajes nuevos.
  useEffect(() => {
    if (!selectedId) return;

    let cancelled = false;

    (async () => {
      const conversation = conversations.find((c) => c.id === selectedId);
      const [messagesData, notesData, templatesData] = await Promise.all([
        fetchMessages(supabase, selectedId),
        conversation ? fetchNotes(supabase, conversation.contact.id) : Promise.resolve([]),
        conversation ? fetchTemplates(supabase, conversation.channel.id) : Promise.resolve([]),
      ]);
      if (cancelled) return;
      setMessages(messagesData);
      setNotes(notesData);
      setTemplates(templatesData);

      if (conversation && conversation.unreadCount > 0) {
        markConversationRead(supabase, selectedId).catch(() => {});
      }
    })();

    const channel = supabase
      .channel(`messages-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          fetchMessages(supabase, selectedId).then((data) => {
            if (!cancelled) setMessages(data);
          });
          if (row.direction === "inbound") {
            markConversationRead(supabase, selectedId).catch(() => {});
          }
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, supabase]);

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="crm" data-view={mobileView}>
      <nav className="crm-rail" aria-label="Secciones">
        <Link className="crm-rail-btn" href="/" aria-label="Recorrido">
          <Route size={17} />
        </Link>
        <Link className="crm-rail-btn" href="/inbox" data-active="true" aria-label="Bandeja">
          <Inbox size={17} />
        </Link>
        <span className="crm-rail-spacer" />
        <button className="crm-rail-btn" type="button" onClick={signOut} aria-label="Cerrar sesión">
          <LogOut size={17} />
        </button>
      </nav>

      <div className="crm-columns">
        <section className="crm-column crm-inbox">
          <InboxSidebar
            conversations={conversations}
            selectedId={selectedId}
            onSelect={openConversation}
            currentAgent={currentAgent}
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
              notes={notes}
              allTags={allTags}
              currentAgent={currentAgent}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
