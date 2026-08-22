"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { Link2, MessageSquarePlus, Paperclip, Pencil, Plus, Trash2, Upload, Zap } from "lucide-react";
import { Button, Input, Label, Modal, TextArea, toast } from "@heroui/react";
import type { AgentTurn, Playbook, PlaybookAfterSend, PlaybookAttachmentType, QuickReply } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createPlaybook, deletePlaybook, setPlaybookActive, updatePlaybook } from "@/lib/mutations";
import { MEDIA_BUCKET, mediaUrlFor } from "@/lib/storage";

interface PlaybooksPanelProps {
  playbooks: Playbook[];
  unmatchedTurns: AgentTurn[];
  quickReplies: QuickReply[];
  canEdit: boolean;
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

interface DraftState {
  name: string;
  triggerDescription: string;
  responseText: string;
  attachmentUrl: string;
  attachmentType: PlaybookAttachmentType | "";
  afterSend: PlaybookAfterSend;
}

const EMPTY_DRAFT: DraftState = {
  name: "",
  triggerDescription: "",
  responseText: "",
  attachmentUrl: "",
  attachmentType: "",
  afterSend: "wait",
};

export function PlaybooksPanel({ playbooks, unmatchedTurns, quickReplies, canEdit }: PlaybooksPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeCount = playbooks.filter((p) => p.isActive).length;

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
    });
    setIsFormOpen(true);
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
      };

      if (editingId) {
        await updatePlaybook(supabase, editingId, payload);
      } else {
        await createPlaybook(supabase, payload);
      }
      setIsFormOpen(false);
    } catch (err) {
      const isDuplicate = err instanceof Error && err.message.includes("duplicate key");
      toast.danger(isDuplicate ? "Ya existe un escenario con ese nombre." : "No se pudo guardar el escenario.");
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
                  <span className="ac-badge" data-tone={playbook.afterSend === "escalate" ? "plum" : "muted"}>
                    {AFTER_SEND_LABEL[playbook.afterSend]}
                  </span>
                  {playbook.attachmentType && (
                    <span className="ac-badge" data-tone="link">
                      {playbook.attachmentType === "link" ? <Link2 size={11} /> : <Paperclip size={11} />}
                      {ATTACHMENT_LABEL[playbook.attachmentType]}
                    </span>
                  )}
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
                  <Label htmlFor="pb-response">Respuesta</Label>
                  <TextArea
                    id="pb-response"
                    value={draft.responseText}
                    onChange={(e) => setDraft({ ...draft, responseText: e.target.value })}
                    rows={5}
                    fullWidth
                  />
                  <span className="lm-hint">Se envía tal cual, palabra por palabra.</span>
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
