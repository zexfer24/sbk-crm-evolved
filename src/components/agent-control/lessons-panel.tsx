"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, toast } from "@heroui/react";
import type { Agent, AiLesson } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { deleteLesson, setLessonActive } from "@/lib/mutations";

// ---------------------------------------------------------------------------
// "Lecciones de Seba" (T6, plan "Seba atiende el mostrador", 18/9/2026,
// requisito 7 del cliente): el panel de Control IA que lista lo que los
// asesores le enseñaron a Seba desde el chat ("Enseñar a Seba…") y deja
// activar/desactivar o borrar. El backend (T5) ya existe —
// `fetchLessons`/`setLessonActive`/`deleteLesson` en data.ts/mutations.ts—;
// esta pieza es solo la lista, siguiendo el mismo patrón visual que
// `knowledge-panel.tsx` (mismas clases de agent-control.css: `.ac-pb-*`).
// ---------------------------------------------------------------------------

interface LessonsPanelProps {
  currentAgent: Agent;
  lessons: AiLesson[];
}

const SCOPE_LABEL: Record<AiLesson["scope"], string> = {
  global: "Todos los chats",
  conversacion: "Solo este chat",
};

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("es-VE", { day: "numeric", month: "short" });
}

/**
 * La RLS de `ai_lessons` deja tocar (actualizar o borrar) una lección a
 * supervisor/admin o a quien la escribió (`created_by = auth.uid()`) — la
 * misma condición para las dos acciones (migración 20260917020000). Mostrar
 * un interruptor que la base va a rechazar es peor que no mostrarlo.
 */
function puedeAdministrar(agent: Agent, lesson: AiLesson): boolean {
  return agent.role !== "agent" || lesson.createdBy === agent.id;
}

export function LessonsPanel({ currentAgent, lessons }: LessonsPanelProps) {
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const activeCount = lessons.filter((l) => l.isActive).length;

  async function handleToggle(lesson: AiLesson) {
    setTogglingId(lesson.id);
    try {
      await setLessonActive(createClient(), lesson.id, !lesson.isActive);
    } catch {
      toast.danger("No se pudo cambiar el estado de la lección.");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(lesson: AiLesson) {
    if (confirmingDeleteId !== lesson.id) {
      setConfirmingDeleteId(lesson.id);
      return;
    }
    try {
      await deleteLesson(createClient(), lesson.id);
    } catch {
      toast.danger("No se pudo borrar la lección.");
    } finally {
      setConfirmingDeleteId(null);
    }
  }

  return (
    <section className="dash-panel">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Lecciones de Seba</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">
          {lessons.length} {lessons.length === 1 ? "lección" : "lecciones"} · {activeCount} activas
        </span>
      </div>

      <p className="ac-pb-intro">
        Correcciones y sinónimos que un asesor le escribió a Seba desde el chat, con clic derecho sobre un mensaje —
        &quot;Enseñar a Seba…&quot;. Tienen prioridad sobre su criterio al responder, salvo sobre lo que nunca puede
        decir.
      </p>

      {lessons.length === 0 ? (
        <div className="dash-empty">
          <p className="dash-empty-title">Todavía no hay lecciones</p>
          <p className="dash-empty-hint">
            Un asesor las escribe con clic derecho sobre un mensaje del cliente o de Seba, desde el chat.
          </p>
        </div>
      ) : (
        <div className="ac-pb-list">
          {lessons.map((lesson) => {
            const manageable = puedeAdministrar(currentAgent, lesson);
            return (
              <div className="ac-pb-card" key={lesson.id} data-active={lesson.isActive}>
                <div className="ac-pb-card-head">
                  <div className="ac-pb-card-who">
                    <span className="ac-pb-card-name">
                      {lesson.kind === "sinonimo" ? "Sinónimo de búsqueda" : "Nota"}
                    </span>
                    <span className="ac-pb-card-trigger">
                      {SCOPE_LABEL[lesson.scope]} · {lesson.authorName} · {dateLabel(lesson.createdAt)}
                    </span>
                  </div>

                  <div className="ac-agent-card-toggle">
                    <span className="ac-agent-card-toggle-label">{lesson.isActive ? "Activa" : "Apagada"}</span>
                    <button
                      className="ac-switch"
                      type="button"
                      data-on={lesson.isActive}
                      onClick={() => handleToggle(lesson)}
                      disabled={!manageable || togglingId === lesson.id}
                      aria-label={
                        lesson.isActive ? `Apagar la lección de ${lesson.authorName}` : `Activar la lección de ${lesson.authorName}`
                      }
                    />
                  </div>
                </div>

                {lesson.kind === "sinonimo" ? (
                  <p className="ac-pb-card-response ac-lesson-synonym">
                    «{lesson.synonymFrom}» → «{lesson.synonymTo}»
                  </p>
                ) : (
                  <p className="ac-pb-card-response">{lesson.content}</p>
                )}

                {lesson.messageExcerpt && <p className="ac-pb-card-trigger">Sobre: «{lesson.messageExcerpt}»</p>}

                <div className="ac-pb-card-foot">
                  {!lesson.isActive && (
                    <span className="ac-badge" data-tone="wait">
                      Seba no la ve
                    </span>
                  )}
                  <span className="dash-panel-spacer" />
                  {manageable && (
                    <Button size="sm" variant="ghost" onPress={() => handleDelete(lesson)}>
                      <Trash2 size={13} />
                      {confirmingDeleteId === lesson.id ? "¿Confirmar?" : "Borrar"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
