"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2, Zap } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { QuickReply } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createQuickReply, deleteQuickReply, updateQuickReply } from "@/lib/mutations";

interface QuickRepliesModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  quickReplies: QuickReply[];
  onSelect: (content: string) => void;
}

export function QuickRepliesModal({ isOpen, onOpenChange, quickReplies, onSelect }: QuickRepliesModalProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [content, setContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);

  function startCreate() {
    setEditingId(null);
    setLabel("");
    setContent("");
    setIsFormOpen(true);
  }

  function startEdit(reply: QuickReply) {
    setEditingId(reply.id);
    setLabel(reply.label);
    setContent(reply.content);
    setIsFormOpen(true);
  }

  async function handleSave() {
    if (!label.trim() || !content.trim()) {
      toast.danger("Completa el título y el contenido.");
      return;
    }
    setIsSaving(true);
    try {
      const supabase = createClient();
      if (editingId) {
        await updateQuickReply(supabase, editingId, label.trim(), content.trim());
      } else {
        await createQuickReply(supabase, label.trim(), content.trim());
      }
      setIsFormOpen(false);
    } catch {
      toast.danger("No se pudo guardar el mensaje rápido.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const supabase = createClient();
      await deleteQuickReply(supabase, id);
    } catch {
      toast.danger("No se pudo borrar el mensaje rápido.");
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <Zap size={18} />
              </Modal.Icon>
              <Modal.Heading>Mensajes rápidos</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              {!isFormOpen && (
                <Button variant="secondary" size="sm" onPress={startCreate} className="self-start">
                  <Plus size={14} />
                  Nuevo mensaje rápido
                </Button>
              )}

              {isFormOpen && (
                <div className="flex flex-col gap-2 rounded-field border border-border bg-surface p-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="qr-label">Título</Label>
                    <Input id="qr-label" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="qr-content">Mensaje</Label>
                    <TextArea id="qr-content" value={content} onChange={(e) => setContent(e.target.value)} rows={3} fullWidth />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onPress={() => setIsFormOpen(false)}>
                      Cancelar
                    </Button>
                    <Button size="sm" variant="primary" onPress={handleSave} isDisabled={isSaving}>
                      {editingId ? "Guardar cambios" : "Agregar"}
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {quickReplies.map((reply) => (
                  <div
                    key={reply.id}
                    className="flex items-start justify-between gap-3 rounded-field border border-border bg-surface p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{reply.label}</p>
                      <p className="truncate text-xs text-muted">{reply.content}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="ghost" isIconOnly onPress={() => startEdit(reply)} aria-label="Editar">
                        <Pencil size={13} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        onPress={() => handleDelete(reply.id)}
                        aria-label="Borrar"
                      >
                        <Trash2 size={13} />
                      </Button>
                      <Button size="sm" variant="secondary" onPress={() => onSelect(reply.content)}>
                        Usar
                      </Button>
                    </div>
                  </div>
                ))}
                {quickReplies.length === 0 && !isFormOpen && (
                  <p className="text-sm text-muted">Todavía no hay mensajes rápidos creados.</p>
                )}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => onOpenChange(false)}>
                Cerrar
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
