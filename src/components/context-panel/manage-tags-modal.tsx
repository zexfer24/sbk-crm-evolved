"use client";

import { useState } from "react";
import { Check, Minus, Pencil, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { Button, Input, Label, Modal, toast } from "@heroui/react";
import type { Tag, TagColor } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { addTagToContact, createTag, deleteTag, removeTagFromContact, updateTag } from "@/lib/mutations";

interface ManageTagsModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  tags: Tag[];
  /**
   * El contacto de la conversación abierta y las etiquetas que ya lleva —
   * D4, plan "El mostrador busca sin salir del chat" (27/9/2026). Antes de
   * esta corrida `ContextPanel` pintaba, debajo de las aplicadas, una
   * segunda lista con TODAS las disponibles como botones "+": era lo que le
   * quitaba el espacio a la búsqueda de inventario que pide D5. Esa acción
   * se mudó acá, a la sección "En este chat" — `ContextPanel` sigue siendo
   * quien la aplica/quita de verdad (mismo `addTagToContact`/
   * `removeTagFromContact`), solo que ahora vive detrás de "Gestionar".
   */
  contactId: string;
  contactTags: Tag[];
  /**
   * Avisa a `crm-shell.tsx` que ESTE agente acaba de aplicar o quitar una
   * etiqueta, para que pida el detalle del chat abierto de una vez —
   * hallazgo 1 (`code-review high` sobre d38a7e1..HEAD, 27/9/2026): el canal
   * `contact-tags-<id>` filtrado por `contact_id` no entrega DELETE
   * filtrados (Supabase Realtime no manda el registro viejo completo salvo
   * `REPLICA IDENTITY FULL`), así que las acciones propias no pueden
   * depender de ese canal para verse reflejadas — necesitan su propio
   * aviso, inmediato, sin esperar a un evento que puede no llegar nunca.
   * Opcional para no obligar a los tests que no lo necesitan (los propios de
   * este módulo) a pasarlo.
   */
  onContactTagsChanged?: () => void;
}

const COLOR_OPTIONS: { value: TagColor; label: string }[] = [
  { value: "default", label: "Gris" },
  { value: "accent", label: "Azul" },
  { value: "success", label: "Verde" },
  { value: "warning", label: "Ámbar" },
  { value: "danger", label: "Rojo" },
];

export function ManageTagsModal({
  isOpen,
  onOpenChange,
  tags,
  contactId,
  contactTags,
  onContactTagsChanged,
}: ManageTagsModalProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<TagColor>("default");
  const [isSaving, setIsSaving] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /**
   * Etiquetas en vuelo (aplicando o quitando) en la sección "En este chat":
   * deshabilita el botón del lado donde la etiqueta QUEDÓ tras el movimiento
   * optimista (ver `optimisticTags`, abajo) — no el de origen, que ya
   * desapareció de esa lista. El error real ya lo maneja la mutación con su
   * propio toast.
   *
   * Corrección del hallazgo 5 (`code-review high` sobre d38a7e1..HEAD,
   * 27/9/2026): antes era un `busyTagId` ÚNICO para todas — un clic en A y
   * enseguida en B (A todavía en vuelo) pisaba el id de A, y el `finally` de
   * A (la primera en resolver) volvía a habilitar el botón de B aunque B
   * siguiera viajando. Un `Set` de ids en vuelo deja que cada etiqueta lleve
   * su propio estado, sin que una pise a la otra.
   */
  const [busyTagIds, setBusyTagIds] = useState<ReadonlySet<string>>(new Set());

  /**
   * Operaciones optimistas AÚN EN VUELO (mismo motivo del hallazgo 5): la
   * reconciliación con la prop, más abajo, corría al recibir CUALQUIER
   * `contactTags` nuevo y reemplazaba `optimisticTags` entero por esa prop —
   * si la prop llegaba con la confirmación de A pero B seguía en vuelo (el
   * servidor todavía no la confirmó), B "parpadeaba" de vuelta a
   * disponibles hasta que su propia respuesta llegara.
   *
   * En ESTADO, no en un `ref`: la reconciliación de abajo la lee DURANTE el
   * render (patrón "Adjusting state when a prop changes"), y
   * `react-hooks/refs` prohíbe leer un `ref` ahí — un `ref` es un valor que
   * React no necesita para pintar, así que leerlo en el cuerpo del
   * componente puede quedar desincronizado con lo que de verdad se pintó.
   */
  const [pendingOps, setPendingOps] = useState(new Map<string, { type: "apply" | "remove"; tag: Tag }>());

  /**
   * Copia local de `contactTags`, movida al instante en cada clic —sin
   * esperar el viaje a la base— para que el asesor no vea la etiqueta
   * seguir en "disponibles" y la vuelva a pulsar (revisión del orquestador
   * de T6, 28/9/2026: esa segunda pulsación chocaba con la clave única de
   * `contact_tags` y salía un toast de error). Se reconcilia con la prop
   * DURANTE el render, no en un efecto —mismo patrón "Adjusting state when a
   * prop changes" que ya usa `close-sale-modal.tsx` (R2, 19/9/2026)—: cuando
   * `contactTags` cambia de referencia (la base ya confirmó el cambio, vía
   * `crm-shell.tsx`), la copia local adopta ese valor como la nueva verdad
   * y REAPLICA encima cualquier operación que siga en vuelo (`pendingOps`,
   * hallazgo 5) — así una A confirmada y una B pendiente no se pisan. Si la
   * mutación falla, el `catch` revierte a mano — no hay que esperar a que la
   * prop cambie, que en ese caso nunca iba a cambiar.
   */
  const [optimisticTags, setOptimisticTags] = useState(contactTags);
  const [syncedContactTags, setSyncedContactTags] = useState(contactTags);
  if (contactTags !== syncedContactTags) {
    setSyncedContactTags(contactTags);
    let next = contactTags;
    for (const [tagId, op] of pendingOps) {
      if (op.type === "apply") {
        if (!next.some((t) => t.id === tagId)) next = [...next, op.tag];
      } else if (next.some((t) => t.id === tagId)) {
        next = next.filter((t) => t.id !== tagId);
      }
    }
    setOptimisticTags(next);
  }

  const contactTagIds = new Set(optimisticTags.map((t) => t.id));
  const availableForContact = tags.filter((t) => !contactTagIds.has(t.id));

  function markBusy(tagId: string) {
    setBusyTagIds((current) => new Set(current).add(tagId));
  }

  function clearBusy(tagId: string) {
    setBusyTagIds((current) => {
      const next = new Set(current);
      next.delete(tagId);
      return next;
    });
  }

  function setPendingOp(tagId: string, op: { type: "apply" | "remove"; tag: Tag }) {
    setPendingOps((current) => {
      const next = new Map(current);
      next.set(tagId, op);
      return next;
    });
  }

  function clearPendingOp(tagId: string) {
    setPendingOps((current) => {
      const next = new Map(current);
      next.delete(tagId);
      return next;
    });
  }

  async function handleApplyTag(tag: Tag) {
    markBusy(tag.id);
    setPendingOp(tag.id, { type: "apply", tag });
    setOptimisticTags((current) => [...current, tag]);
    try {
      await addTagToContact(createClient(), contactId, tag.id);
      onContactTagsChanged?.();
    } catch {
      setOptimisticTags((current) => current.filter((t) => t.id !== tag.id));
      toast.danger("No se pudo añadir la etiqueta.");
    } finally {
      clearPendingOp(tag.id);
      clearBusy(tag.id);
    }
  }

  async function handleRemoveTag(tag: Tag) {
    markBusy(tag.id);
    setPendingOp(tag.id, { type: "remove", tag });
    setOptimisticTags((current) => current.filter((t) => t.id !== tag.id));
    try {
      await removeTagFromContact(createClient(), contactId, tag.id);
      onContactTagsChanged?.();
    } catch {
      setOptimisticTags((current) => [...current, tag]);
      toast.danger("No se pudo quitar la etiqueta.");
    } finally {
      clearPendingOp(tag.id);
      clearBusy(tag.id);
    }
  }

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
              <div className="flex flex-col gap-2">
                <Label>En este chat</Label>
                <div className="crm-tags">
                  {optimisticTags.map((tag) => (
                    <span className="crm-tag" key={tag.id} data-color={tag.color}>
                      {tag.label}
                      <button
                        className="crm-tag-x"
                        type="button"
                        aria-label={`Quitar etiqueta ${tag.label} de este contacto`}
                        onClick={() => handleRemoveTag(tag)}
                        disabled={busyTagIds.has(tag.id)}
                      >
                        <Minus size={11} />
                      </button>
                    </span>
                  ))}
                  {optimisticTags.length === 0 && (
                    <span className="text-sm text-muted">Sin etiquetas todavía.</span>
                  )}
                </div>

                {availableForContact.length > 0 ? (
                  <div className="crm-tags">
                    {availableForContact.map((tag) => (
                      <button
                        className="crm-tag crm-tag-add"
                        key={tag.id}
                        type="button"
                        aria-label={`Aplicar etiqueta ${tag.label} a este contacto`}
                        onClick={() => handleApplyTag(tag)}
                        disabled={busyTagIds.has(tag.id)}
                      >
                        <Plus size={11} />
                        {tag.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  tags.length > 0 && <p className="text-sm text-muted">Ya tiene todas las etiquetas creadas.</p>
                )}
              </div>

              {/*
               * La lista de abajo (crear/editar/borrar) se confundía con "En
               * este chat" — sin encabezado propio ni separador, las dos
               * secciones se leían como una sola (captura `04-gestionar-
               * etiquetas.png` de la verificación visual de T6, 27/9/2026).
               * `<hr>` con la clase de línea que ya usa el resto del CRM
               * (`--lm-line`, ver `crm-divider` en `crm.css`) en vez de un
               * `border-top` puntual, para no inventar una regla nueva.
               */}
              <hr className="crm-divider" />
              <Label>Todas las etiquetas</Label>

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
