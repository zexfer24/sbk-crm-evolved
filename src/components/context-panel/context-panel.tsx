"use client";

import { useState } from "react";
import { Handshake, IdCard, MapPin, Phone, Plus, Radio, X } from "lucide-react";
import { Button, TextArea, toast } from "@heroui/react";
import type { Agent, Conversation, Note, Tag } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { addNote, addTagToContact, removeTagFromContact } from "@/lib/mutations";
import { formatFullDateTime } from "@/lib/format";
import { CloseSaleModal } from "@/components/context-panel/close-sale-modal";

interface ContextPanelProps {
  conversation: Conversation;
  notes: Note[];
  allTags: Tag[];
  currentAgent: Agent;
}

export function ContextPanel({ conversation, notes, allTags, currentAgent }: ContextPanelProps) {
  const [noteDraft, setNoteDraft] = useState("");
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isCloseSaleOpen, setIsCloseSaleOpen] = useState(false);

  const contact = conversation.contact;
  const contactTagIds = new Set(contact.tags.map((t) => t.id));
  const availableTags = allTags.filter((t) => !contactTagIds.has(t.id));
  const isDealWon = conversation.dealStatus === "won";
  const cedula = contact.cedulaType && contact.cedulaNumber ? `${contact.cedulaType}-${contact.cedulaNumber}` : null;
  const location = [contact.city, contact.state].filter(Boolean).join(", ");

  async function handleAddTag(tagId: string) {
    try {
      const supabase = createClient();
      await addTagToContact(supabase, contact.id, tagId);
    } catch {
      toast.danger("No se pudo añadir la etiqueta.");
    }
  }

  async function handleRemoveTag(tagId: string) {
    try {
      const supabase = createClient();
      await removeTagFromContact(supabase, contact.id, tagId);
    } catch {
      toast.danger("No se pudo quitar la etiqueta.");
    }
  }

  async function handleSaveNote() {
    const content = noteDraft.trim();
    if (!content) return;
    setIsSavingNote(true);
    try {
      const supabase = createClient();
      await addNote(supabase, contact.id, currentAgent, content);
      setNoteDraft("");
    } catch {
      toast.danger("No se pudo guardar la nota.");
    } finally {
      setIsSavingNote(false);
    }
  }

  return (
    <>
      <div className="crm-context-head">
        <Button
          variant={isDealWon ? "secondary" : "primary"}
          fullWidth
          isDisabled={isDealWon}
          onPress={() => setIsCloseSaleOpen(true)}
        >
          <Handshake size={16} />
          {isDealWon ? "Venta cerrada" : "Cerrar venta"}
        </Button>
      </div>

      <CloseSaleModal
        isOpen={isCloseSaleOpen}
        onOpenChange={setIsCloseSaleOpen}
        conversationId={conversation.id}
        contact={contact}
        agent={currentAgent}
      />

      <div className="crm-context-body">
        <section className="crm-context-section">
          <p className="crm-context-name">
            {contact.displayName ?? contact.profileName ?? "Contacto"}
          </p>
          <p className="crm-context-fact">
            <Phone size={13} />
            <span className="lm-num">{contact.phoneNumber}</span>
          </p>
          <p className="crm-context-fact">
            <Radio size={13} />
            <span>{conversation.channel.label}</span>
          </p>
          {cedula && (
            <p className="crm-context-fact">
              <IdCard size={13} />
              <span className="lm-num">{cedula}</span>
            </p>
          )}
          {(location || contact.address) && (
            <p className="crm-context-fact">
              <MapPin size={13} />
              <span>{[contact.address, location].filter(Boolean).join(" — ")}</span>
            </p>
          )}
        </section>

        <section className="crm-context-section">
          <p className="lm-eyebrow">Etiquetas</p>
          <div className="crm-tags">
            {contact.tags.map((tag) => (
              <span className="crm-tag" key={tag.id} data-color={tag.color}>
                {tag.label}
                <button
                  className="crm-tag-x"
                  type="button"
                  aria-label={`Quitar etiqueta ${tag.label}`}
                  onClick={() => handleRemoveTag(tag.id)}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {contact.tags.length === 0 && (
              <span style={{ color: "var(--lm-muted)", fontSize: 12 }}>Sin etiquetas todavía</span>
            )}
          </div>

          {availableTags.length > 0 && (
            <div className="crm-tags">
              {availableTags.map((tag) => (
                <button
                  className="crm-tag crm-tag-add"
                  key={tag.id}
                  type="button"
                  onClick={() => handleAddTag(tag.id)}
                >
                  <Plus size={11} />
                  {tag.label}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="crm-context-section">
          <p className="lm-eyebrow">Notas internas</p>
          <TextArea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Anota algo sobre este contacto…"
            rows={3}
            fullWidth
          />
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!noteDraft.trim() || isSavingNote}
            onPress={handleSaveNote}
            className="self-end"
          >
            Guardar nota
          </Button>

          <div className="flex flex-col gap-2">
            {notes.map((note) => (
              <div className="crm-note" key={note.id}>
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{note.content}</p>
                <p className="crm-note-meta">
                  {note.agent?.displayName ?? "Agente"} · {formatFullDateTime(note.createdAt)}
                </p>
              </div>
            ))}
            {notes.length === 0 && (
              <p style={{ color: "var(--lm-muted)", fontSize: 12, margin: 0 }}>Sin notas todavía.</p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
