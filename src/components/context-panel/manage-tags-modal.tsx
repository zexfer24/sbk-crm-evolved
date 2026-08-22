"use client";

import { useState } from "react";
import { Check, Pencil, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { Button, Input, Label, Modal, toast } from "@heroui/react";
import type { Tag, TagColor } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createTag, deleteTag, updateTag } from "@/lib/mutations";

interface ManageTagsModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  tags: Tag[];
}

const COLOR_OPTIONS: { value: TagColor; label: string }[] = [
  { value: "default", label: "Gris" },
  { value: "accent", label: "Azul" },
  { value: "success", label: "Verde" },
  { value: "warning", label: "Ámbar" },
  { value: "danger", label: "Rojo" },
];

export function ManageTagsModal({ isOpen, onOpenChange, tags }: ManageTagsModalProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<TagColor>("default");
  const [isSaving, setIsSaving] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function startCreate() {
    setEditingId(null);
    setLabel("");
    setColor("default");
    setIsFormOpen(true);
  }

  function startEdit(tag: Tag) {
    setEditingId(tag.id);
    setLabel(tag.label);
    setColor(tag.color);
    setIsFormOpen(true);
  }

  async function handleSave() {
    const trimmed = label.trim();
    if (!trimmed) {
      toast.danger("Ponle un nombre a la etiqueta.");
      return;
    }
    setIsSaving(true);
    try {
      const supabase = createClient();
      if (editingId) {
        await updateTag(supabase, editingId, trimmed, color);
      } else {
        await createTag(supabase, trimmed, color);
      }
      setIsFormOpen(false);
    } catch {
      toast.danger("No se pudo guardar la etiqueta.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(tag: Tag) {
    setDeletingId(tag.id);
    try {
      const supabase = createClient();
      await deleteTag(supabase, tag.id);
    } catch {
      toast.danger("No se pudo borrar la etiqueta.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <TagIcon size={18} />
              </Modal.Icon>
              <Modal.Heading>Gestionar etiquetas</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              {!isFormOpen && (
                <Button variant="secondary" size="sm" onPress={startCreate} className="self-start">
                  <Plus size={14} />
                  Nueva etiqueta
                </Button>
              )}

              {isFormOpen && (
                <div className="flex flex-col gap-2 rounded-field border border-border bg-surface p-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="tag-label">Nombre</Label>
                    <Input id="tag-label" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>Color</Label>
                    <div className="flex flex-wrap gap-2">
                      {COLOR_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className="crm-tag"
                          data-color={option.value}
                          onClick={() => setColor(option.value)}
                          aria-pressed={color === option.value}
                        >
                          {color === option.value && <Check size={11} />}
                          {option.label}
                        </button>
                      ))}
                    </div>
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
                {tags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex items-center justify-between gap-3 rounded-field border border-border bg-surface p-2.5"
                  >
                    <span className="crm-tag" data-color={tag.color}>
                      {tag.label}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="ghost" isIconOnly onPress={() => startEdit(tag)} aria-label="Editar">
                        <Pencil size={13} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        onPress={() => handleDelete(tag)}
                        isDisabled={deletingId === tag.id}
                        aria-label="Borrar"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                ))}
                {tags.length === 0 && !isFormOpen && (
                  <p className="text-sm text-muted">Todavía no hay etiquetas creadas.</p>
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
