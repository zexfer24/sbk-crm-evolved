"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { Button, TextArea, toast } from "@heroui/react";
import type { Agent, Note } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { addNote, deleteNote, updateNote } from "@/lib/mutations";
import { formatFullDateTime } from "@/lib/format";

/**
 * Las notas internas del contacto, con la misma regla que el panel del chat
 * y que la RLS: cualquiera escribe, pero solo el autor o un supervisor puede
 * editar o borrar.
 */
export function ClienteNotas({
  contactId,
  initialNotes,
  currentAgent,
}: {
  contactId: string;
  initialNotes: Note[];
  currentAgent: Agent;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    try {
      await action();
      router.refresh();
    } catch {
      toast.danger(fallback);
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    const content = draft.trim();
    if (!content) return;
    await run(async () => {
      await addNote(createClient(), contactId, currentAgent, content);
      setDraft("");
    }, "No se pudo guardar la nota.");
  }

  async function handleSaveEdit() {
    const content = editingDraft.trim();
    if (!content || !editingId) return;
    await run(async () => {
      await updateNote(createClient(), editingId, content);
      setEditingId(null);
    }, "No se pudo editar la nota.");
  }

  return (
    <div className="cli-notes">
      <div className="cli-note-composer">
        <TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Algo que el equipo deba saber de este cliente…"
          rows={2}
          fullWidth
        />
        <Button variant="primary" onPress={handleAdd} isDisabled={busy || !draft.trim()}>
          Guardar nota
        </Button>
      </div>

      {initialNotes.length === 0 ? (
        <p className="cli-missing">Todavía no hay notas sobre este cliente.</p>
      ) : (
        <ul className="cli-note-list">
          {initialNotes.map((note) => {
            const canManage = note.agent?.id === currentAgent.id || currentAgent.role !== "agent";
            const isEditing = editingId === note.id;

            return (
              <li className="cli-note" key={note.id}>
                <div className="cli-note-head">
                  <span className="cli-note-author">{note.agent?.displayName ?? "Agente"}</span>
                  <span className="dash-panel-spacer" />
                  <span className="cli-note-date">{formatFullDateTime(note.createdAt)}</span>
                  {canManage && !isEditing && (
                    <>
                      <button
                        type="button"
                        className="cli-note-btn"
                        aria-label="Editar nota"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(note.id);
                          setEditingDraft(note.content);
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="cli-note-btn"
                        aria-label="Borrar nota"
                        disabled={busy}
                        onClick={() => run(() => deleteNote(createClient(), note.id), "No se pudo borrar la nota.")}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>

                {isEditing ? (
                  <div className="cli-note-edit">
                    <TextArea
                      value={editingDraft}
                      onChange={(e) => setEditingDraft(e.target.value)}
                      rows={2}
                      fullWidth
                    />
                    <div className="cli-note-edit-actions">
                      <button
                        type="button"
                        className="cli-note-btn"
                        aria-label="Guardar cambios"
                        disabled={busy}
                        onClick={handleSaveEdit}
                      >
                        <Check size={13} />
                      </button>
                      <button
                        type="button"
                        className="cli-note-btn"
                        aria-label="Cancelar edición"
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="cli-note-body">{note.content}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
