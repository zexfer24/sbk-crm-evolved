"use client";

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { BookOpen, FileText, FolderPlus, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { Agent, KnowledgeCategory, KnowledgeEntry } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import {
  createKnowledgeCategory,
  createKnowledgeEntry,
  deleteKnowledgeCategory,
  deleteKnowledgeEntry,
  setKnowledgeEntryActive,
  updateKnowledgeEntry,
} from "@/lib/mutations";
import "@/components/agent-control/knowledge.css";

interface KnowledgePanelProps {
  currentAgent: Agent;
  categories: KnowledgeCategory[];
  entries: KnowledgeEntry[];
  canEdit: boolean;
}

interface EntryDraft {
  title: string;
  categoryId: string;
  content: string;
  sourceFilename: string | null;
}

/** Extensiones que se importan leyendo el texto tal cual. Un PDF o un Word no son texto plano: se rechazan con explicación. */
const TEXT_FILE_PATTERN = /\.(md|markdown|txt)$/i;

/** Un .md de más de medio MB no es conocimiento curado, es un vaciado de datos: mejor partirlo en entradas. */
const MAX_FILE_BYTES = 500_000;

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("es-VE", { day: "numeric", month: "short" });
}

/**
 * La biblioteca del agente: lo que la IA sabe de la tienda más allá del
 * catálogo. Se escribe acá (texto directo o importando un .md/.txt) y la IA
 * lo consulta en sus turnos con la herramienta "consultar_biblioteca".
 */
export function KnowledgePanel({ currentAgent, categories, entries, canEdit }: KnowledgePanelProps) {
  const [filterCategoryId, setFilterCategoryId] = useState<string | null>(null);

  const [isEntryOpen, setIsEntryOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft>({ title: "", categoryId: "", content: "", sourceFilename: null });
  const [isSaving, setIsSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryDescription, setCategoryDescription] = useState("");
  const [isSavingCategory, setIsSavingCategory] = useState(false);
  /** Borrar una categoría arrastra sus entradas: el primer clic arma la pregunta, el segundo confirma. */
  const [confirmingDeleteCategoryId, setConfirmingDeleteCategoryId] = useState<string | null>(null);

  const entryCountByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.categoryId, (counts.get(entry.categoryId) ?? 0) + 1);
    return counts;
  }, [entries]);

  const visibleEntries = useMemo(
    () => (filterCategoryId ? entries.filter((e) => e.categoryId === filterCategoryId) : entries),
    [entries, filterCategoryId]
  );

  const activeCount = entries.filter((e) => e.isActive).length;

  function startCreate() {
    setEditingId(null);
    setDraft({ title: "", categoryId: filterCategoryId ?? categories[0]?.id ?? "", content: "", sourceFilename: null });
    setIsEntryOpen(true);
  }

  function startEdit(entry: KnowledgeEntry) {
    setEditingId(entry.id);
    setDraft({
      title: entry.title,
      categoryId: entry.categoryId,
      content: entry.content,
      sourceFilename: entry.sourceFilename,
    });
    setIsEntryOpen(true);
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!TEXT_FILE_PATTERN.test(file.name)) {
      toast.danger("Por ahora solo se importan archivos de texto: .md o .txt. Copia el contenido y pégalo si viene de otro formato.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast.danger("Ese archivo es muy grande (máximo 500 KB). Pártelo en entradas más pequeñas: la IA busca por tema.");
      return;
    }

    try {
      const text = await file.text();
      setDraft((d) => ({
        ...d,
        content: text,
        sourceFilename: file.name,
        title: d.title.trim() ? d.title : file.name.replace(TEXT_FILE_PATTERN, ""),
      }));
    } catch {
      toast.danger("No se pudo leer el archivo.");
    }
  }

  async function handleSaveEntry() {
    if (!draft.title.trim() || !draft.content.trim() || !draft.categoryId) {
      toast.danger("Completa el título, la categoría y el contenido.");
      return;
    }

    setIsSaving(true);
    try {
      const supabase = createClient();
      const payload = {
        categoryId: draft.categoryId,
        title: draft.title.trim(),
        content: draft.content.trim(),
        sourceFilename: draft.sourceFilename,
      };
      if (editingId) {
        await updateKnowledgeEntry(supabase, currentAgent, editingId, payload);
      } else {
        await createKnowledgeEntry(supabase, currentAgent, payload);
      }
      setIsEntryOpen(false);
    } catch {
      toast.danger("No se pudo guardar la entrada.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggleEntry(entry: KnowledgeEntry) {
    setTogglingId(entry.id);
    try {
      await setKnowledgeEntryActive(createClient(), entry.id, !entry.isActive);
    } catch {
      toast.danger("No se pudo cambiar el estado de la entrada.");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDeleteEntry(id: string) {
    try {
      await deleteKnowledgeEntry(createClient(), id);
    } catch {
      toast.danger("No se pudo borrar la entrada.");
    }
  }

  async function handleSaveCategory() {
    if (!categoryName.trim()) {
      toast.danger("Ponle nombre a la categoría.");
      return;
    }
    setIsSavingCategory(true);
    try {
      await createKnowledgeCategory(createClient(), categoryName.trim(), categoryDescription.trim() || null);
      setCategoryName("");
      setCategoryDescription("");
      setIsCategoryOpen(false);
    } catch (err) {
      const isDuplicate = err instanceof Error && err.message.includes("duplicate key");
      toast.danger(isDuplicate ? "Ya existe una categoría con ese nombre." : "No se pudo crear la categoría.");
    } finally {
      setIsSavingCategory(false);
    }
  }

  async function handleDeleteCategory(category: KnowledgeCategory) {
    if (confirmingDeleteCategoryId !== category.id) {
      setConfirmingDeleteCategoryId(category.id);
      return;
    }
    try {
      await deleteKnowledgeCategory(createClient(), category.id);
      if (filterCategoryId === category.id) setFilterCategoryId(null);
    } catch {
      toast.danger("No se pudo borrar la categoría.");
    } finally {
      setConfirmingDeleteCategoryId(null);
    }
  }

  return (
    <>
      <section className="dash-panel">
        <div className="dash-panel-head">
          <h2 className="dash-panel-title">Lo que la IA sabe de la tienda</h2>
          <span className="dash-panel-spacer" />
          <span className="dash-panel-note">
            {entries.length} entradas · {activeCount} activas
          </span>
        </div>

        <p className="ac-pb-intro">
          Todo lo que escribas acá, la IA lo puede consultar al responder: envíos, formas de pago, garantías,
          horarios, promociones… Escribe directo o importa un archivo .md o .txt. La IA usa esta información para
          redactar con sus palabras — si buscas que responda un texto exacto, eso es una respuesta predeterminada.
        </p>

        {canEdit && (
          <div className="ac-pb-actions">
            <Button variant="secondary" size="sm" onPress={startCreate} isDisabled={categories.length === 0}>
              <Plus size={14} />
              Nueva entrada
            </Button>
            <Button variant="ghost" size="sm" onPress={() => setIsCategoryOpen(true)}>
              <FolderPlus size={14} />
              Nueva categoría
            </Button>
          </div>
        )}

        <div className="kb-filter" role="group" aria-label="Filtrar por categoría">
          <button
            className="kb-chip"
            type="button"
            data-active={filterCategoryId === null}
            onClick={() => setFilterCategoryId(null)}
          >
            Todas<span className="kb-chip-count">{entries.length}</span>
          </button>
          {categories.map((category) => (
            <button
              className="kb-chip"
              type="button"
              key={category.id}
              data-active={filterCategoryId === category.id}
              onClick={() => setFilterCategoryId(category.id)}
              title={category.description ?? undefined}
            >
              {category.name}
              <span className="kb-chip-count">{entryCountByCategory.get(category.id) ?? 0}</span>
            </button>
          ))}
        </div>

        {visibleEntries.length === 0 ? (
          <div className="dash-empty">
            <p className="dash-empty-title">
              {entries.length === 0 ? "La biblioteca está vacía" : "No hay entradas en esta categoría"}
            </p>
            <p className="dash-empty-hint">
              {entries.length === 0
                ? "Mientras no haya nada cargado, la IA responde que esa información se la confirma un asesor."
                : "Elige otra categoría o crea la primera entrada de esta."}
            </p>
          </div>
        ) : (
          <div className="ac-pb-list">
            {visibleEntries.map((entry) => (
              <div className="ac-pb-card" key={entry.id} data-active={entry.isActive}>
                <div className="ac-pb-card-head">
                  <div className="ac-pb-card-who">
                    <span className="ac-pb-card-name">{entry.title}</span>
                    <span className="ac-pb-card-trigger">
                      {entry.categoryName} · actualizada el {dateLabel(entry.updatedAt)}
                    </span>
                  </div>

                  {canEdit && (
                    <div className="ac-agent-card-toggle">
                      <span className="ac-agent-card-toggle-label">{entry.isActive ? "Visible" : "Oculta"}</span>
                      <button
                        className="ac-switch"
                        type="button"
                        data-on={entry.isActive}
                        onClick={() => handleToggleEntry(entry)}
                        disabled={togglingId === entry.id}
                        aria-label={
                          entry.isActive
                            ? `Ocultarle "${entry.title}" a la IA`
                            : `Hacer visible "${entry.title}" para la IA`
                        }
                      />
                    </div>
                  )}
                </div>

                <p className="ac-pb-card-response kb-entry-content">{entry.content}</p>

                <div className="ac-pb-card-foot">
                  {entry.sourceFilename && (
                    <span className="ac-badge kb-file-chip" data-tone="muted" title={entry.sourceFilename}>
                      <FileText size={11} />
                      {entry.sourceFilename}
                    </span>
                  )}
                  {!entry.isActive && (
                    <span className="ac-badge" data-tone="wait">
                      La IA no la ve
                    </span>
                  )}
                  <span className="dash-panel-spacer" />
                  {canEdit && (
                    <>
                      <Button size="sm" variant="ghost" isIconOnly onPress={() => startEdit(entry)} aria-label="Editar">
                        <Pencil size={13} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        onPress={() => handleDeleteEntry(entry.id)}
                        aria-label="Borrar"
                      >
                        <Trash2 size={13} />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {canEdit && (
        <section className="dash-panel">
          <div className="dash-panel-head">
            <h2 className="dash-panel-title">Categorías</h2>
            <span className="dash-panel-spacer" />
            <span className="dash-panel-note">{categories.length} en total</span>
          </div>

          <p className="ac-pb-intro">
            Las categorías ordenan la biblioteca para ti y ayudan a la IA a ubicar el tema. Borrar una borra también
            sus entradas.
          </p>

          <div className="ac-pb-missing">
            {categories.map((category) => (
              <div className="ac-pb-missing-row" key={category.id}>
                <span className="ac-pb-missing-text">
                  <strong>{category.name}</strong>
                  {category.description && <> — {category.description}</>}
                </span>
                <Button size="sm" variant="ghost" onPress={() => handleDeleteCategory(category)}>
                  <Trash2 size={13} />
                  {confirmingDeleteCategoryId === category.id
                    ? `¿Borrar con sus ${entryCountByCategory.get(category.id) ?? 0} entradas?`
                    : "Borrar"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <Modal isOpen={isEntryOpen} onOpenChange={setIsEntryOpen}>
        <Modal.Backdrop>
          <Modal.Container size="lg" placement="center">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Icon>
                  <BookOpen size={18} />
                </Modal.Icon>
                <Modal.Heading>{editingId ? "Editar entrada" : "Nueva entrada"}</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>

              <Modal.Body className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-title">Título</Label>
                  <Input
                    id="kb-title"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    placeholder="Envíos a todo el país"
                    fullWidth
                  />
                  <span className="lm-hint">Di el tema en pocas palabras: es lo primero que la IA mira al buscar.</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-category">Categoría</Label>
                  <select
                    id="kb-category"
                    value={draft.categoryId}
                    onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}
                    className="lm-select"
                  >
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="kb-content">Contenido</Label>
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() => fileInputRef.current?.click()}
                    >
                      <Upload size={14} />
                      Importar .md o .txt
                    </Button>
                    <input ref={fileInputRef} type="file" accept=".md,.markdown,.txt" hidden onChange={handleImportFile} />
                  </div>
                  <TextArea
                    id="kb-content"
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                    placeholder={"Hacemos envíos a todo el país con MRW y Zoom.\nBarinas ciudad: entrega el mismo día.\nEl envío lo paga el cliente al recibir."}
                    rows={10}
                    fullWidth
                  />
                  <span className="lm-hint">
                    Escríbelo como se lo explicarías a un asesor nuevo. Puedes usar Markdown. La IA lo lee y responde
                    con sus palabras — no le envía este texto al cliente.
                  </span>
                  {draft.sourceFilename && (
                    <span className="lm-hint">
                      Importado de <strong>{draft.sourceFilename}</strong>. Puedes editar el texto antes de guardar.
                    </span>
                  )}
                </div>
              </Modal.Body>

              <Modal.Footer>
                <Button variant="ghost" onPress={() => setIsEntryOpen(false)}>
                  Cancelar
                </Button>
                <Button variant="primary" onPress={handleSaveEntry} isDisabled={isSaving}>
                  {editingId ? "Guardar cambios" : "Crear entrada"}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal isOpen={isCategoryOpen} onOpenChange={setIsCategoryOpen}>
        <Modal.Backdrop>
          <Modal.Container size="md" placement="center">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Icon>
                  <FolderPlus size={18} />
                </Modal.Icon>
                <Modal.Heading>Nueva categoría</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>

              <Modal.Body className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-cat-name">Nombre</Label>
                  <Input
                    id="kb-cat-name"
                    value={categoryName}
                    onChange={(e) => setCategoryName(e.target.value)}
                    placeholder="Promociones"
                    fullWidth
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-cat-description">Descripción (opcional)</Label>
                  <Input
                    id="kb-cat-description"
                    value={categoryDescription}
                    onChange={(e) => setCategoryDescription(e.target.value)}
                    placeholder="Descuentos y combos vigentes"
                    fullWidth
                  />
                </div>
              </Modal.Body>

              <Modal.Footer>
                <Button variant="ghost" onPress={() => setIsCategoryOpen(false)}>
                  Cancelar
                </Button>
                <Button variant="primary" onPress={handleSaveCategory} isDisabled={isSavingCategory}>
                  Crear categoría
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
