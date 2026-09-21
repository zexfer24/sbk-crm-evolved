"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { flushSync } from "react-dom";
import { AlertTriangle, Link2, MessageSquarePlus, Paperclip, Pencil, Plus, Trash2, Upload, Zap } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { AgentTurn, CatalogLink, Playbook, PlaybookAfterSend, PlaybookAttachmentType, QuickReply, Tag } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createPlaybook, deletePlaybook, PlaybookIdentityError, setPlaybookActive, updatePlaybook } from "@/lib/mutations";
import { MEDIA_BUCKET, mediaUrlFor } from "@/lib/storage";
import { hasHardcodedPrice } from "@/lib/playbook-price";
import { catalogMarkerFor, hasRawUrl, resolveCatalogMarkers, type CatalogLinkDraft } from "@/lib/catalog-links";
import { insertAtCaret } from "@/lib/composer-text";
import { CatalogLinksPanel } from "@/components/agent-control/catalog-links-panel";

interface PlaybooksPanelProps {
  playbooks: Playbook[];
  unmatchedTurns: AgentTurn[];
  quickReplies: QuickReply[];
  /** El catálogo completo de etiquetas del CRM: es de donde se elige, no se crean acá. */
  tags: Tag[];
  canEdit: boolean;
  /**
   * Enlaces de catálogo (T4a, plan "Nada sin leer, un solo catálogo y la
   * factura Saint", 18/9/2026, D3): la sección se pinta ARRIBA de los
   * escenarios porque los dos alimentan el mismo marcador. La lista completa
   * (activos e inactivos) también sirve para marcar, en la lista de
   * escenarios de acá abajo, cuál quedó con un `{{catalogo:<key>}}` sin
   * resolver.
   */
  catalogLinks: CatalogLink[];
  onCreateCatalogLink: (draft: CatalogLinkDraft) => Promise<void>;
  onUpdateCatalogLink: (id: string, draft: CatalogLinkDraft) => Promise<void>;
  onDeleteCatalogLink: (id: string) => Promise<void>;
  onToggleCatalogLink: (id: string, isActive: boolean) => Promise<void>;
}

const AFTER_SEND_LABEL: Record<PlaybookAfterSend, string> = {
  wait: "Queda esperando al cliente",
  escalate: "Pasa a un asesor",
};

const ATTACHMENT_LABEL: Record<PlaybookAttachmentType, string> = {
  link: "Link",
  image: "Imagen",
  document: "Documento",
  video: "Video",
};

/** El marcador de la lista completa de catálogos activos (D4). Literal y no un regex: acá se INSERTA, no se busca. */
const CATALOG_LIST_TOKEN = "{{catalogos}}";

interface DraftState {
  name: string;
  triggerDescription: string;
  responseText: string;
  attachmentUrl: string;
  attachmentType: PlaybookAttachmentType | "";
  afterSend: PlaybookAfterSend;
  /**
   * Cuarta condición de "el repuesto manda" (T4, plan "El catálogo
   * configurado sale siempre", 21/9/2026). Apagada por default al crear:
   * producción medía el 30 % de las respuestas predeterminadas saliendo de
   * "CATALOGO CASCOS"/"Catálogo general", y cederlas todas de una sin que el
   * supervisor las marque a mano habría mandado escenarios de un solo
   * catálogo (cascos, maletas) al inventario real por error.
   */
  cedeAlInventario: boolean;
  tagIds: string[];
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  triggerDescription: "",
  responseText: "",
  attachmentUrl: "",
  attachmentType: "",
  afterSend: "wait",
  cedeAlInventario: false,
  tagIds: [],
};

export function PlaybooksPanel({
  playbooks,
  unmatchedTurns,
  quickReplies,
  tags,
  canEdit,
  catalogLinks,
  onCreateCatalogLink,
  onUpdateCatalogLink,
  onDeleteCatalogLink,
  onToggleCatalogLink,
}: PlaybooksPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const responseFieldRef = useRef<HTMLTextAreaElement>(null);

  const activeCount = playbooks.filter((p) => p.isActive).length;

  // El selector "Insertar catálogo" solo ofrece los catálogos ACTIVOS, en el
  // orden del panel de enlaces (sort_order) — corrección de la revisión
  // `code-review high` del 19/9/2026, punto 5: antes ofrecía CUALQUIER
  // catálogo, en el orden en que llegó del servidor; pegar la clave de uno
  // apagado (o desordenado, sin que importe, pero confuso para el
  // supervisor) dejaba el marcador SIN RESOLVER apenas se guardaba el
  // escenario (D6). Mismo filtro que `quick-replies-modal.tsx`
  // (`activeCatalogLinks`).
  const activeCatalogLinks = catalogLinks
    .filter((link) => link.isActive)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);

  function startCreate(prefill?: Partial<DraftState>) {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT, ...prefill });
    setIsFormOpen(true);
  }

  function startEdit(playbook: Playbook) {
    setEditingId(playbook.id);
    setDraft({
      name: playbook.name,
      triggerDescription: playbook.triggerDescription,
      responseText: playbook.responseText,
      attachmentUrl: playbook.attachmentUrl ?? "",
      attachmentType: playbook.attachmentType ?? "",
      afterSend: playbook.afterSend,
      cedeAlInventario: playbook.cedeAlInventario,
      tagIds: playbook.tags.map((tag) => tag.id),
    });
    setIsFormOpen(true);
  }

  function toggleTag(tagId: string) {
    setDraft((current) => ({
      ...current,
      tagIds: current.tagIds.includes(tagId)
        ? current.tagIds.filter((id) => id !== tagId)
        : [...current.tagIds, tagId],
    }));
  }

  /**
   * "Insertar catálogo" (T4a, D4): pega el marcador en la posición del
   * cursor de la Respuesta, no al final. Mismo patrón que `wrapSelection`/
   * `insertEmoji` de `composer.tsx` — `insertAtCaret` es el mismo módulo
   * puro, y el `flushSync` es el mismo arreglo del 29/8/2026: sin el commit
   * forzado, `setSelectionRange` puede perder la carrera contra el commit de
   * React bajo CPU contendida y el cursor queda mal puesto.
   */
  function insertCatalogMarker(marker: string) {
    const textarea = responseFieldRef.current;
    const start = textarea?.selectionStart ?? draft.responseText.length;
    const end = textarea?.selectionEnd ?? draft.responseText.length;
    const { text, caret } = insertAtCaret(draft.responseText, start, end, marker);

    flushSync(() => setDraft((current) => ({ ...current, responseText: text })));

    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  }

  async function handleSave() {
    if (!draft.name.trim() || !draft.triggerDescription.trim() || !draft.responseText.trim()) {
      toast.danger("Completa el nombre, cuándo aplica y la respuesta.");
      return;
    }

    const url = draft.attachmentUrl.trim();
    // La tabla exige que URL y tipo vayan juntos o ninguno de los dos.
    const type = url ? draft.attachmentType || "link" : null;

    setIsSaving(true);
    try {
      const supabase = createClient();
      const payload = {
        name: draft.name.trim(),
        triggerDescription: draft.triggerDescription.trim(),
        responseText: draft.responseText.trim(),
        attachmentUrl: url || null,
        attachmentType: type,
        afterSend: draft.afterSend,
        cedeAlInventario: draft.cedeAlInventario,
        tagIds: draft.tagIds,
      };

      if (editingId) {
        await updatePlaybook(supabase, editingId, payload);
      } else {
        await createPlaybook(supabase, payload);
      }
      setIsFormOpen(false);
    } catch (err) {
      // La guarda de identidad va primero: su mensaje trae el fragmento exacto
      // que rechazó («asistente automatizado», "me llamo…") para que el
      // supervisor sepa QUÉ corregir, no un "no se pudo guardar" a ciegas.
      if (err instanceof PlaybookIdentityError) {
        toast.danger(err.message);
      } else {
        const isDuplicate = err instanceof Error && err.message.includes("duplicate key");
        toast.danger(isDuplicate ? "Ya existe un escenario con ese nombre." : "No se pudo guardar el escenario.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setIsUploading(true);
    try {
      const supabase = createClient();
      // Ruta con id aleatorio: ni siquiera dentro de un bucket privado
      // conviene que el nombre del archivo insinúe qué hay adentro.
      const extension = file.name.includes(".") ? file.name.split(".").pop() : null;
      const path = `playbooks/${crypto.randomUUID()}${extension ? `.${extension}` : ""}`;
      const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type });
      if (error) throw error;

      const type: PlaybookAttachmentType = file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
          ? "video"
          : "document";

      setDraft((d) => ({ ...d, attachmentUrl: mediaUrlFor(path), attachmentType: type }));
    } catch {
      toast.danger("No se pudo subir el archivo.");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleToggle(playbook: Playbook) {
    setTogglingId(playbook.id);
    try {
      await setPlaybookActive(createClient(), playbook.id, !playbook.isActive);
    } catch {
      toast.danger("No se pudo cambiar el estado del escenario.");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deletePlaybook(createClient(), id);
    } catch {
      toast.danger("No se pudo borrar el escenario.");
    }
  }

  return (
    <>
      <CatalogLinksPanel
        links={catalogLinks}
        canEdit={canEdit}
        onCreate={onCreateCatalogLink}
        onUpdate={onUpdateCatalogLink}
        onDelete={onDeleteCatalogLink}
        onToggle={onToggleCatalogLink}
        playbooks={playbooks}
        quickReplies={quickReplies}
      />

      <section className="dash-panel">
        <div className="dash-panel-head">
          <h2 className="dash-panel-title">Respuestas que la IA envía sola</h2>
          <span className="dash-panel-spacer" />
          <span className="dash-panel-note">
            {playbooks.length} en total · {activeCount} activas
          </span>
        </div>

        <p className="ac-pb-intro">
          Cuando el mensaje de un cliente calza con uno de estos escenarios, la IA responde con el texto exacto que
          escribas acá — no lo reescribe ni lo resume. Si no calza con ninguno, atiende como siempre.
        </p>

        {canEdit && (
          <div className="ac-pb-actions">
            <Button variant="secondary" size="sm" onPress={() => startCreate()}>
              <Plus size={14} />
              Nuevo escenario
            </Button>
            {quickReplies.length > 0 && (
              <Button variant="ghost" size="sm" onPress={() => setIsImportOpen(true)}>
                <MessageSquarePlus size={14} />
                Importar desde mensajes rápidos
              </Button>
            )}
          </div>
        )}

        {playbooks.length === 0 ? (
          <div className="dash-empty">
            <p className="dash-empty-title">Todavía no hay respuestas predeterminadas</p>
            <p className="dash-empty-hint">
              Mientras no haya ninguna, la IA responde todo redactando por su cuenta.
            </p>
          </div>
        ) : (
          <div className="ac-pb-list">
            {playbooks.map((playbook) => (
              <div className="ac-pb-card" key={playbook.id} data-active={playbook.isActive}>
                <div className="ac-pb-card-head">
                  <div className="ac-pb-card-who">
                    <span className="ac-pb-card-name">{playbook.name}</span>
                    <span className="ac-pb-card-trigger">{playbook.triggerDescription}</span>
                  </div>

                  {canEdit && (
                    <div className="ac-agent-card-toggle">
                      <span className="ac-agent-card-toggle-label">{playbook.isActive ? "Activa" : "Apagada"}</span>
                      <button
                        className="ac-switch"
                        type="button"
                        data-on={playbook.isActive}
                        onClick={() => handleToggle(playbook)}
                        disabled={togglingId === playbook.id}
                        aria-label={
                          playbook.isActive
                            ? `Apagar el escenario ${playbook.name}`
                            : `Activar el escenario ${playbook.name}`
                        }
                      />
                    </div>
                  )}
                </div>

                <p className="ac-pb-card-response">{playbook.responseText}</p>

                <div className="ac-pb-card-foot">
                  {/* El texto sale tal cual: un precio escrito acá adentro no se
                      actualiza con el inventario ni con la tasa. No se bloquea
                      nada, solo se marca para que se revise. */}
                  {hasHardcodedPrice(playbook.responseText) && (
                    <span className="ac-badge" data-tone="wait" title="Este texto lleva un precio escrito a mano: no se actualiza solo. Revísalo.">
                      <AlertTriangle size={11} />
                      Precio a mano
                    </span>
                  )}
                  {/* D6: un `{{catalogo:<key>}}` de una clave apagada o borrada
                      queda igual de sin resolver que uno mal escrito — fase 0
                      del turno ya lo saca de los candidatos (`escenarios_
                      enlace_sin_resolver`), esto solo es el mismo aviso acá,
                      donde el supervisor puede corregirlo. */}
                  {(resolveCatalogMarkers(playbook.responseText, catalogLinks).missing.length > 0 ||
                    (playbook.attachmentUrl &&
                      resolveCatalogMarkers(playbook.attachmentUrl, catalogLinks).missing.length > 0)) && (
                    <span
                      className="ac-badge"
                      data-tone="wait"
                      title="Este escenario tiene un marcador de catálogo que no resuelve: no le llega al cliente."
                    >
                      <AlertTriangle size={11} />
                      Enlace sin resolver
                    </span>
                  )}
                  {/* T4, plan "El catálogo configurado sale siempre" (21/9/2026):
                      aviso discreto de la cuarta condición de "el repuesto
                      manda" — este escenario deja de mandar su texto cuando
                      el cliente pregunta por un repuesto puntual (y la
                      consulta de productos está encendida). */}
                  {playbook.cedeAlInventario && (
                    <span
                      className="ac-badge"
                      data-tone="muted"
                      title="Si el cliente pregunta por un repuesto puntual y la consulta de productos está encendida, la IA busca en el inventario en vez de mandar esta respuesta."
                    >
                      Cede al inventario
                    </span>
                  )}
                  <span className="ac-badge" data-tone={playbook.afterSend === "escalate" ? "plum" : "muted"}>
                    {AFTER_SEND_LABEL[playbook.afterSend]}
                  </span>
                  {playbook.attachmentType && (
                    <span className="ac-badge" data-tone="link">
                      {playbook.attachmentType === "link" ? <Link2 size={11} /> : <Paperclip size={11} />}
                      {ATTACHMENT_LABEL[playbook.attachmentType]}
                    </span>
                  )}
                  {playbook.tags.map((tag) => (
                    <span className="crm-tag" data-color={tag.color} key={tag.id}>
                      {tag.label}
                    </span>
                  ))}
                  <span className="dash-panel-spacer" />
                  {canEdit && (
                    <>
                      <Button size="sm" variant="ghost" isIconOnly onPress={() => startEdit(playbook)} aria-label="Editar">
                        <Pencil size={13} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        onPress={() => handleDelete(playbook.id)}
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

      <section className="dash-panel">
        <div className="dash-panel-head">
          <h2 className="dash-panel-title">Mensajes que no calzaron con ningún escenario</h2>
          <span className="dash-panel-spacer" />
          <span className="dash-panel-note">Los escenarios que te faltan por crear</span>
        </div>

        {unmatchedTurns.length === 0 ? (
          <div className="dash-empty">
            <p className="dash-empty-title">Nada pendiente por acá</p>
          </div>
        ) : (
          <div className="ac-pb-missing">
            {unmatchedTurns.map((turn) => (
              <div className="ac-pb-missing-row" key={turn.id}>
                <span className="ac-pb-missing-text">{turn.customerMessage}</span>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      startCreate({ triggerDescription: `el cliente escribe algo como: "${turn.customerMessage}"` })
                    }
                  >
                    <Plus size={13} />
                    Crear escenario
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal isOpen={isFormOpen} onOpenChange={setIsFormOpen}>
        <Modal.Backdrop>
          <Modal.Container size="lg" placement="center">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Icon>
                  <Zap size={18} />
                </Modal.Icon>
                <Modal.Heading>{editingId ? "Editar escenario" : "Nuevo escenario"}</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>

              <Modal.Body className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pb-name">Nombre</Label>
                  <Input
                    id="pb-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="Postventa Cashea"
                    fullWidth
                  />
                  <span className="lm-hint">Solo lo ves tú. Sirve para reconocerlo en esta lista.</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pb-trigger">¿Cuándo aplica?</Label>
                  <TextArea
                    id="pb-trigger"
                    value={draft.triggerDescription}
                    onChange={(e) => setDraft({ ...draft, triggerDescription: e.target.value })}
                    placeholder="el cliente dice que hizo una compra por Cashea"
                    rows={2}
                    fullWidth
                  />
                  <span className="lm-hint">
                    Descríbelo como se lo explicarías a un asesor nuevo. Es lo único que la IA usa para decidir si esta
                    respuesta corresponde.
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="pb-response">Respuesta</Label>
                    {/* "Insertar catálogo" (T4a, D4): pega el marcador en el
                        cursor, no reemplaza nada — se puede insertar más de
                        uno en el mismo texto. Sin ningún catálogo ACTIVO no
                        tiene sentido mostrarla: no hay nada que insertar
                        todavía (punto 5, corrección 19/9/2026 — antes miraba
                        `catalogLinks.length`, que cuenta también los
                        apagados). */}
                    {activeCatalogLinks.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          const value = e.target.value;
                          if (!value) return;
                          insertCatalogMarker(value === CATALOG_LIST_TOKEN ? value : catalogMarkerFor(value));
                          e.target.value = "";
                        }}
                        className="lm-select"
                        aria-label="Insertar catálogo"
                      >
                        <option value="">Insertar catálogo…</option>
                        <option value={CATALOG_LIST_TOKEN}>Todos los catálogos</option>
                        {activeCatalogLinks.map((link) => (
                          <option key={link.id} value={link.key}>
                            {link.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <TextArea
                    id="pb-response"
                    ref={responseFieldRef}
                    value={draft.responseText}
                    onChange={(e) => setDraft({ ...draft, responseText: e.target.value })}
                    rows={5}
                    fullWidth
                  />
                  <span className="lm-hint">Se envía tal cual, palabra por palabra.</span>
                  {hasRawUrl(draft.responseText) && (
                    <p className="ac-pb-warning">
                      <AlertTriangle size={12} aria-hidden="true" />
                      Este texto lleva un enlace escrito a mano; si es un catálogo, usa el marcador para que se
                      actualice solo.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pb-attachment">Adjunto (opcional)</Label>
                  <div className="flex gap-2">
                    <Input
                      id="pb-attachment"
                      value={draft.attachmentUrl}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          attachmentUrl: e.target.value,
                          attachmentType: e.target.value ? draft.attachmentType || "link" : "",
                        })
                      }
                      placeholder="https://..."
                      fullWidth
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onPress={() => fileInputRef.current?.click()}
                      isDisabled={isUploading}
                    >
                      <Upload size={14} />
                      {isUploading ? "Subiendo…" : "Subir"}
                    </Button>
                    <input ref={fileInputRef} type="file" hidden onChange={handleUpload} />
                  </div>

                  {draft.attachmentUrl && (
                    <div className="flex flex-col gap-1.5">
                      <select
                        value={draft.attachmentType}
                        onChange={(e) =>
                          setDraft({ ...draft, attachmentType: e.target.value as PlaybookAttachmentType })
                        }
                        className="lm-select"
                        aria-label="Cómo se envía el adjunto"
                      >
                        <option value="link">Link — la dirección va escrita en el mensaje</option>
                        <option value="document">Documento — se adjunta el archivo</option>
                        <option value="image">Imagen — se adjunta el archivo</option>
                        <option value="video">Video — se adjunta el archivo</option>
                      </select>
                      {draft.attachmentType !== "link" && (
                        <span className="lm-hint">
                          Para adjuntar el archivo, la dirección tiene que llevar directo a él y abrirse sin pedir
                          permiso. Un catálogo en una página web o en una carpeta compartida no sirve así: para esos usa
                          la opción <strong>Link</strong>.
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pb-after">Después de responder</Label>
                  <select
                    id="pb-after"
                    value={draft.afterSend}
                    onChange={(e) => setDraft({ ...draft, afterSend: e.target.value as PlaybookAfterSend })}
                    className="lm-select"
                  >
                    <option value="wait">Queda esperando la respuesta del cliente</option>
                    <option value="escalate">Pasa la conversación a un asesor</option>
                  </select>
                  <span className="lm-hint">
                    Elige pasar a un asesor cuando la respuesta pide un dato que alguien tiene que revisar, como la
                    cédula para buscar una guía de envío.
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  {/* T4, plan "El catálogo configurado sale siempre" (21/9/2026):
                      cuarta condición de "el repuesto manda" (H1, 18/9/2026,
                      `agent.ts`). Reusa el mismo `ac-switch` que ya usan la
                      lista de acá arriba y el resto de `agent-control/` — sin
                      librería nueva. No es obligatoria: el asterisco de
                      CLAUDE.md es CSS sobre `<Label>`, y este campo no lo
                      lleva. */}
                  <div className="flex items-center gap-2">
                    <button
                      className="ac-switch"
                      type="button"
                      data-on={draft.cedeAlInventario}
                      onClick={() => setDraft((current) => ({ ...current, cedeAlInventario: !current.cedeAlInventario }))}
                      aria-label="Cede al inventario cuando preguntan por un repuesto"
                    />
                    <Label>Cede al inventario cuando preguntan por un repuesto</Label>
                  </div>
                  <span className="lm-hint">
                    Si el cliente pregunta por un repuesto puntual y la consulta de productos está encendida, Seba
                    busca en el inventario en vez de mandar esta respuesta. Si pide el catálogo, esta respuesta sale
                    igual. Déjalo apagado en los escenarios que mandan un catálogo de una categoría (cascos,
                    maletas).
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label>Etiquetas que deja puestas</Label>
                  {tags.length === 0 ? (
                    <span className="lm-hint">
                      Todavía no hay etiquetas creadas. Se crean desde la ficha de cualquier cliente, en Etiquetas.
                    </span>
                  ) : (
                    <>
                      <div className="ac-pb-tagpick">
                        {tags.map((tag) => {
                          const elegida = draft.tagIds.includes(tag.id);
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              className="ac-pb-tagpick-item"
                              aria-pressed={elegida}
                              onClick={() => toggleTag(tag.id)}
                            >
                              <span className="crm-tag" data-color={tag.color}>
                                {tag.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <span className="lm-hint">
                        Se le ponen al cliente cada vez que este escenario responda, pase o no la conversación a un
                        asesor. Puedes elegir varias, o ninguna.
                      </span>
                    </>
                  )}
                </div>
              </Modal.Body>

              <Modal.Footer>
                <Button variant="ghost" onPress={() => setIsFormOpen(false)}>
                  Cancelar
                </Button>
                <Button variant="primary" onPress={handleSave} isDisabled={isSaving}>
                  {editingId ? "Guardar cambios" : "Crear escenario"}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <Modal isOpen={isImportOpen} onOpenChange={setIsImportOpen}>
        <Modal.Backdrop>
          <Modal.Container size="lg" placement="center">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Icon>
                  <MessageSquarePlus size={18} />
                </Modal.Icon>
                <Modal.Heading>Importar desde mensajes rápidos</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-2">
                <p className="ac-pb-hint">
                  Se copia el texto para que lo uses de punto de partida. A partir de ahí quedan separados: cambiar uno
                  no cambia el otro.
                </p>
                {quickReplies.map((reply) => (
                  <div className="ac-pb-import-row" key={reply.id}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{reply.label}</p>
                      <p className="truncate text-xs text-muted">{reply.content}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        setIsImportOpen(false);
                        startCreate({ name: reply.label, responseText: reply.content });
                      }}
                    >
                      Usar
                    </Button>
                  </div>
                ))}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setIsImportOpen(false)}>
                  Cerrar
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
