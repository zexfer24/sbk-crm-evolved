"use client";

import { useState } from "react";
import { Copy, Link2, Pencil, Plus, TriangleAlert, Trash2 } from "lucide-react";
import { Button, Input, Label, toast } from "@heroui/react";
import type { CatalogLink, Playbook, QuickReply } from "@/lib/types";
import {
  CATALOG_MARKER,
  catalogMarkerFor,
  slugifyKey,
  validateCatalogLinkDraft,
  type CatalogLinkDraft,
  type CatalogLinkField,
} from "@/lib/catalog-links";

// ---------------------------------------------------------------------------
// "Enlaces de catálogo" (T4a, plan "Nada sin leer, un solo catálogo y la
// factura Saint", 18/9/2026, D3/D4). Se monta ARRIBA de los escenarios,
// dentro de "Respuestas predeterminadas" (`playbooks-panel.tsx`), porque
// alimenta a los dos consumidores que viven ahí: los escenarios de la IA y
// los mensajes rápidos de los asesores. Es la pantalla que reemplaza a las
// URLs de Google Drive pegadas a mano — el catálogo de cascos tuvo cuatro IDs
// distintos en 25 días y el 18/9/2026 circulaban dos versiones a la vez.
//
// El formulario es una fila inline (no un Modal, a diferencia de
// `playbooks-panel.tsx`): son tres campos cortos y va arriba de una lista
// corta (siete catálogos hoy), un modal completo era más ceremonia de la que
// hace falta acá.
// ---------------------------------------------------------------------------

interface CatalogLinksPanelProps {
  links: CatalogLink[];
  canEdit: boolean;
  onCreate: (draft: CatalogLinkDraft) => Promise<void>;
  onUpdate: (id: string, draft: CatalogLinkDraft) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, isActive: boolean) => Promise<void>;
  /**
   * Para avisar, al borrar, cuántos escenarios y mensajes rápidos quedarían
   * con un marcador sin resolver (D3: "avisa cuántos escenarios y mensajes
   * rápidos usan esa clave"). `playbooks-panel.tsx` ya recibe las dos listas
   * completas para "Importar desde mensajes rápidos"; acá se reutilizan en
   * vez de volver a pedirlas.
   */
  playbooks: Playbook[];
  quickReplies: QuickReply[];
}

interface DraftState {
  key: string;
  label: string;
  url: string;
}

const EMPTY_DRAFT: DraftState = { key: "", label: "", url: "" };

/**
 * Las claves que un texto referencia con `{{catalogo:<key>}}`, en minúsculas.
 * `matchAll` (a diferencia de `.test()`/`.exec()`) clona el regex por spec,
 * así que reutilizar la constante `CATALOG_MARKER` con flag `g` acá es
 * seguro sin resetear `lastIndex` a mano (ver el docblock de `catalog-links.ts`).
 */
function referencedKeys(text: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!text) return keys;
  for (const match of text.matchAll(CATALOG_MARKER)) {
    keys.add(match[1].toLowerCase());
  }
  return keys;
}

export function CatalogLinksPanel({
  links,
  canEdit,
  onCreate,
  onUpdate,
  onDelete,
  onToggle,
  playbooks,
  quickReplies,
}: CatalogLinksPanelProps) {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<CatalogLinkField, string>>>({});
  const [keyTouched, setKeyTouched] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const activeCount = links.filter((l) => l.isActive).length;
  const sortedLinks = links.slice().sort((a, b) => a.sortOrder - b.sortOrder);

  function startCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFieldErrors({});
    setKeyTouched(false);
    setIsFormOpen(true);
  }

  function startEdit(link: CatalogLink) {
    setEditingId(link.id);
    setDraft({ key: link.key, label: link.label, url: link.url });
    setFieldErrors({});
    // Al editar, la clave ya existe: no se le pisa con el slug de la
    // etiqueta cada vez que se retoca el nombre.
    setKeyTouched(true);
    setIsFormOpen(true);
  }

  function cancelForm() {
    setIsFormOpen(false);
    setFieldErrors({});
  }

  function handleLabelChange(value: string) {
    setDraft((current) => ({
      ...current,
      label: value,
      key: keyTouched ? current.key : slugifyKey(value),
    }));
  }

  function handleKeyChange(value: string) {
    setKeyTouched(true);
    setDraft((current) => ({ ...current, key: value }));
  }

  async function handleSave() {
    const otherLinks = links.filter((link) => link.id !== editingId);
    const candidate: CatalogLinkDraft = {
      key: draft.key.trim(),
      label: draft.label.trim(),
      url: draft.url.trim(),
    };
    const errors = validateCatalogLinkDraft(candidate, otherLinks);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setIsSaving(true);
    try {
      if (editingId) {
        await onUpdate(editingId, candidate);
      } else {
        await onCreate(candidate);
      }
      setIsFormOpen(false);
      setFieldErrors({});
    } catch {
      toast.danger("No se pudo guardar el catálogo.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggle(link: CatalogLink) {
    setTogglingId(link.id);
    try {
      await onToggle(link.id, !link.isActive);
    } catch {
      toast.danger("No se pudo cambiar el estado del catálogo.");
    } finally {
      setTogglingId(null);
    }
  }

  /** Cuántos escenarios y mensajes rápidos quedarían con un marcador sin resolver si se borra esta clave (D3). */
  function usageOf(key: string): { enEscenarios: number; enMensajesRapidos: number } {
    const target = key.toLowerCase();
    const enEscenarios = playbooks.filter(
      (p) => referencedKeys(p.responseText).has(target) || referencedKeys(p.attachmentUrl).has(target)
    ).length;
    const enMensajesRapidos = quickReplies.filter((r) => referencedKeys(r.content).has(target)).length;
    return { enEscenarios, enMensajesRapidos };
  }

  function deleteButtonLabel(link: CatalogLink): string {
    if (confirmingDeleteId !== link.id) return "Borrar";
    const { enEscenarios, enMensajesRapidos } = usageOf(link.key);
    const partes: string[] = [];
    if (enEscenarios > 0) partes.push(`${enEscenarios} ${enEscenarios === 1 ? "escenario" : "escenarios"}`);
    if (enMensajesRapidos > 0) {
      partes.push(`${enMensajesRapidos} ${enMensajesRapidos === 1 ? "mensaje rápido" : "mensajes rápidos"}`);
    }
    return partes.length > 0 ? `¿Borrar? Lo usan ${partes.join(" y ")}` : "¿Confirmar borrado?";
  }

  async function handleDeleteClick(link: CatalogLink) {
    if (confirmingDeleteId !== link.id) {
      setConfirmingDeleteId(link.id);
      return;
    }
    try {
      await onDelete(link.id);
    } catch {
      toast.danger("No se pudo borrar el catálogo.");
    } finally {
      setConfirmingDeleteId(null);
    }
  }

  async function handleCopyMarker(link: CatalogLink) {
    try {
      await navigator.clipboard.writeText(catalogMarkerFor(link.key));
      toast.success("Marcador copiado");
    } catch {
      toast.danger("No se pudo copiar el marcador.");
    }
  }

  return (
    <section className="dash-panel">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Enlaces de catálogo</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">
          {links.length} en total · {activeCount} activos
        </span>
      </div>

      <p className="ac-pb-intro">
        La fuente única de los enlaces (catálogos de Drive, ubicación…). Se cargan acá UNA vez y se usan con un
        marcador —<code>{"{{catalogo:clave}}"}</code> para uno solo, <code>{"{{catalogos}}"}</code> para la lista
        completa de activos— en los escenarios de la IA y en los mensajes rápidos de los asesores: cambiar la URL
        acá la cambia en los dos lados sin tocar ningún texto.
      </p>

      {canEdit && !isFormOpen && (
        <div className="ac-pb-actions">
          <Button variant="secondary" size="sm" onPress={startCreate}>
            <Plus size={14} />
            Nuevo catálogo
          </Button>
        </div>
      )}

      {isFormOpen && (
        <div className="flex flex-col gap-3 ac-pb-card">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-label" className="lm-required">
              Etiqueta
            </Label>
            <Input
              id="cat-label"
              value={draft.label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="Cascos"
              fullWidth
            />
            {fieldErrors.label && (
              <p role="alert" className="lm-field-error">
                {fieldErrors.label}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-key" className="lm-required">
              Clave del marcador
            </Label>
            <Input
              id="cat-key"
              value={draft.key}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="cascos"
              fullWidth
            />
            <span className="lm-hint">Se usa como {catalogMarkerFor(draft.key || "clave")}</span>
            {fieldErrors.key && (
              <p role="alert" className="lm-field-error">
                {fieldErrors.key}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-url" className="lm-required">
              URL
            </Label>
            <Input
              id="cat-url"
              value={draft.url}
              onChange={(e) => setDraft((current) => ({ ...current, url: e.target.value }))}
              placeholder="https://drive.google.com/..."
              fullWidth
            />
            {fieldErrors.url && (
              <p role="alert" className="lm-field-error">
                {fieldErrors.url}
              </p>
            )}
          </div>

          <div className="ac-pb-actions">
            <Button variant="ghost" size="sm" onPress={cancelForm}>
              Cancelar
            </Button>
            <Button variant="primary" size="sm" onPress={handleSave} isDisabled={isSaving}>
              {editingId ? "Guardar cambios" : "Crear catálogo"}
            </Button>
          </div>
        </div>
      )}

      {links.length === 0 ? (
        <div className="dash-empty">
          <p className="dash-empty-title">Todavía no hay catálogos cargados</p>
          <p className="dash-empty-hint">
            Mientras no haya ninguno, un marcador <code>{"{{catalogo:...}}"}</code> en un escenario o un mensaje
            rápido queda sin resolver.
          </p>
        </div>
      ) : (
        <div className="ac-pb-list">
          {sortedLinks.map((link) => (
            <div className="ac-pb-card" key={link.id} data-active={link.isActive}>
              <div className="ac-pb-card-head">
                <div className="ac-pb-card-who">
                  <span className="ac-pb-card-name">{link.label}</span>
                  <span className="ac-pb-card-trigger">
                    {catalogMarkerFor(link.key)} · {link.url}
                  </span>
                </div>

                {canEdit && (
                  <div className="ac-agent-card-toggle">
                    <span className="ac-agent-card-toggle-label">{link.isActive ? "Activo" : "Apagado"}</span>
                    <button
                      className="ac-switch"
                      type="button"
                      data-on={link.isActive}
                      onClick={() => handleToggle(link)}
                      disabled={togglingId === link.id}
                      aria-label={link.isActive ? `Apagar el catálogo ${link.label}` : `Activar el catálogo ${link.label}`}
                    />
                  </div>
                )}
              </div>

              {!link.isActive && (
                <div className="ac-pb-card-foot">
                  <span className="ac-badge" data-tone="wait">
                    <TriangleAlert size={11} />
                    Apagado: deja sin resolver cualquier marcador que lo use
                  </span>
                </div>
              )}

              <div className="ac-pb-card-foot">
                <Button size="sm" variant="ghost" onPress={() => handleCopyMarker(link)}>
                  <Copy size={13} />
                  Copiar marcador
                </Button>
                <span className="dash-panel-spacer" />
                {canEdit && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      onPress={() => startEdit(link)}
                      aria-label={`Editar ${link.label}`}
                    >
                      <Pencil size={13} />
                    </Button>
                    <Button size="sm" variant="ghost" onPress={() => handleDeleteClick(link)}>
                      <Trash2 size={13} />
                      {deleteButtonLabel(link)}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!canEdit && (
        <p className="ac-pb-intro">
          <Link2 size={12} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} aria-hidden="true" />
          Solo un supervisor o admin puede cargar o cambiar catálogos.
        </p>
      )}
    </section>
  );
}
