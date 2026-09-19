"use client";

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link2, Pencil, Plus, Trash2, TriangleAlert, Zap } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { CatalogLink, QuickReply } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createQuickReply, deleteQuickReply, updateQuickReply } from "@/lib/mutations";
import { catalogMarkerFor, hasRawUrl, resolveCatalogMarkers } from "@/lib/catalog-links";
import { insertAtCaret } from "@/lib/composer-text";

interface QuickRepliesModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  quickReplies: QuickReply[];
  /**
   * Los catálogos ACTIVOS (T4b, "Nada sin leer, un solo catálogo y la
   * factura Saint", 18/9/2026): alimentan el botón "Insertar catálogo" (una
   * entrada por clave, más "Todos los catálogos") y la marca de "marcador
   * sin resolver" sobre cada mensaje rápido de la lista.
   */
  catalogLinks: CatalogLink[];
  onSelect: (content: string) => void;
}

export function QuickRepliesModal({ isOpen, onOpenChange, quickReplies, catalogLinks, onSelect }: QuickRepliesModalProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [content, setContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isCatalogMenuOpen, setIsCatalogMenuOpen] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // El menú solo ofrece los catálogos ACTIVOS, en el orden del panel: uno
  // inactivo dejaría el marcador SIN RESOLVER apenas se pegara (D6).
  const activeCatalogLinks = catalogLinks
    .filter((link) => link.isActive)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  function startCreate() {
    setEditingId(null);
    setLabel("");
    setContent("");
    setIsFormOpen(true);
    setIsCatalogMenuOpen(false);
  }

  function startEdit(reply: QuickReply) {
    setEditingId(reply.id);
    setLabel(reply.label);
    setContent(reply.content);
    setIsFormOpen(true);
    setIsCatalogMenuOpen(false);
  }

  /**
   * "Insertar catálogo" (D4, T4b, 18/9/2026): pega el marcador en la
   * posición del cursor, nunca al final -- el supervisor puede estar
   * redactando "Acá va nuestro catálogo: <cursor> ¡Cualquier cosa
   * pregunta!". `flushSync` antes de reposicionar el cursor, mismo motivo
   * que `insertEmoji`/`wrapSelection` en `composer.tsx`: sin el commit
   * forzado, `setSelectionRange` puede perder la carrera contra el commit
   * de React bajo CPU contendida (29/8/2026).
   */
  function insertCatalogMarker(marker: string) {
    const textarea = contentRef.current;
    const start = textarea?.selectionStart ?? content.length;
    const end = textarea?.selectionEnd ?? content.length;
    const { text: nextText, caret } = insertAtCaret(content, start, end, marker);

    flushSync(() => setContent(nextText));

    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
    setIsCatalogMenuOpen(false);
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
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="qr-content">Mensaje</Label>
                      <div className="relative">
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => setIsCatalogMenuOpen((open) => !open)}
                          aria-expanded={isCatalogMenuOpen}
                        >
                          <Link2 size={13} />
                          Insertar catálogo
                        </Button>
                        {isCatalogMenuOpen && (
                          <div
                            role="menu"
                            aria-label="Catálogos"
                            className="lm-catalog-menu absolute right-0 z-10 mt-1 flex min-w-40 flex-col gap-0.5 rounded-field border border-border bg-surface p-1 shadow-md"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="lm-catalog-menu-item rounded-field px-2 py-1 text-left text-sm hover:bg-default"
                              onClick={() => insertCatalogMarker("{{catalogos}}")}
                            >
                              Todos los catálogos
                            </button>
                            {activeCatalogLinks.map((link) => (
                              <button
                                key={link.id}
                                type="button"
                                role="menuitem"
                                className="lm-catalog-menu-item rounded-field px-2 py-1 text-left text-sm hover:bg-default"
                                onClick={() => insertCatalogMarker(catalogMarkerFor(link.key))}
                              >
                                {link.label}
                              </button>
                            ))}
                            {activeCatalogLinks.length === 0 && (
                              <p className="px-2 py-1 text-xs text-muted">Todavía no hay catálogos cargados.</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <TextArea
                      id="qr-content"
                      ref={contentRef}
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      rows={3}
                      fullWidth
                    />
                    {hasRawUrl(content) && (
                      <p className="flex items-center gap-1 text-xs text-warning">
                        <TriangleAlert size={12} />
                        Este texto lleva un enlace escrito a mano; si es un catálogo, usa el marcador para que se
                        actualice solo.
                      </p>
                    )}
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
                {quickReplies.map((reply) => {
                  // D6: un `{{catalogo:<key>}}` que no calza con ningún
                  // catálogo activo se queda TAL CUAL en el texto -- acá se
                  // marca en la lista para que el asesor lo vea antes de
                  // "Usar", no solo después de pegarlo (el toast de
                  // `composer.tsx` avisa recién en ese momento).
                  const unresolved = resolveCatalogMarkers(reply.content, catalogLinks).missing;
                  return (
                    <div
                      key={reply.id}
                      className="flex items-start justify-between gap-3 rounded-field border border-border bg-surface p-3"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          {reply.label}
                          {unresolved.length > 0 && (
                            <span className="inline-flex items-center gap-1 text-xs font-normal text-warning">
                              <TriangleAlert size={11} />
                              Marcador sin resolver
                            </span>
                          )}
                        </p>
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
                  );
                })}
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
