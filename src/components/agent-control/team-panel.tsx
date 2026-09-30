"use client";

import { useState } from "react";
import { Button, Input, Label, Modal, toast } from "@heroui/react";
import { Eye, EyeOff, KeyRound, Pencil } from "lucide-react";
import type { Agent } from "@/lib/types";
import { initials } from "@/lib/dashboard";
import {
  validateAgentAccountDraft,
  type AgentAccountField,
  type AgentAccountPatchResponse,
} from "@/lib/agent-account";

// ---------------------------------------------------------------------------
// Pestaña «Equipo» de Control IA (T6, "Ronda del cliente", 30/9/2026).
//
// Hasta esta fecha el nombre visible y la contraseña de un asesor solo se
// cambiaban desde Supabase Studio, y los administradores del negocio no
// tienen acceso ahí. La vista monta este panel SOLO para `role = "admin"`;
// la guarda de verdad vive en `PATCH /api/agents/[id]`, que es la única que
// puede tocar la contraseña (GoTrue, con service_role).
//
// El modal manda solo lo que cambió (una contraseña vacía no viaja) y valida
// campo por campo con `validateAgentAccountDraft`, con los mismos mensajes
// que la ruta. Las contraseñas se borran del estado al cerrarlo: no quedan
// vivas en memoria mientras el panel sigue abierto.
// ---------------------------------------------------------------------------

/** Copia mínima del mapa de `agent-roster-panel.tsx`, que no lo exporta. */
const ROLE_LABEL: Record<Agent["role"], string> = {
  agent: "Asesor",
  supervisor: "Supervisor",
  admin: "Administrador",
};

const ROLE_ORDER: Record<Agent["role"], number> = { agent: 0, supervisor: 1, admin: 2 };

interface TeamPanelProps {
  agents: Agent[];
  currentAgentId: string;
  /** El nombre nuevo ya quedó en la base: la vista lo refleja sin recargar. */
  onAgentRenamed: (agentId: string, displayName: string) => void;
}

export function TeamPanel({ agents, currentAgentId, onAgentRenamed }: TeamPanelProps) {
  const [editing, setEditing] = useState<Agent | null>(null);

  const ordered = [...agents].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.displayName.localeCompare(b.displayName)
  );

  return (
    <section className="dash-panel">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Cuentas del CRM</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">Solo un administrador ve esta pestaña</span>
      </div>

      {agents.length === 0 ? (
        <div className="dash-empty">
          <p className="dash-empty-title">Todavía no hay cuentas registradas</p>
        </div>
      ) : (
        <div className="ac-roster">
          {ordered.map((agent) => (
            <div className="ac-agent-card" key={agent.id}>
              <div className="ac-agent-card-head">
                <span className="ac-live-avatar" aria-hidden="true">
                  {initials(agent.displayName)}
                </span>
                <div className="ac-agent-card-who">
                  <span className="ac-agent-card-name">
                    {agent.displayName}
                    {agent.id === currentAgentId && " (tú)"}
                  </span>
                  <span className="ac-agent-card-role">{ROLE_LABEL[agent.role]}</span>
                </div>
                <div className="ac-agent-card-toggle">
                  <span className="ac-badge" data-tone={agent.isActive ? "good" : "muted"}>
                    {agent.isActive ? "En el reparto" : "Fuera del reparto"}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => setEditing(agent)}
                    aria-label={`Editar a ${agent.displayName}`}
                  >
                    <Pencil size={13} />
                    Editar
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EditAccountModal
          // La key reinicia el formulario al abrirlo para otra cuenta.
          key={editing.id}
          agent={editing}
          onClose={() => setEditing(null)}
          onAgentRenamed={onAgentRenamed}
        />
      )}
    </section>
  );
}

function EditAccountModal({
  agent,
  onClose,
  onAgentRenamed,
}: {
  agent: Agent;
  onClose: () => void;
  onAgentRenamed: (agentId: string, displayName: string) => void;
}) {
  // El nombre de referencia se mueve si un 207 dejó guardado el nombre: así
  // un segundo intento solo reenvía lo que falló.
  const [originalDisplayName, setOriginalDisplayName] = useState(agent.displayName);
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<AgentAccountField, string>>>({});
  const [saving, setSaving] = useState(false);

  const draft = { originalDisplayName, displayName, password, confirmPassword };
  const { hasChanges } = validateAgentAccountDraft(draft);

  function clearFieldError(field: AgentAccountField) {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function close() {
    // Las contraseñas no sobreviven al modal (el componente se desmonta, pero
    // se vacían igual por si un cierre llega mientras la petición vuela).
    setPassword("");
    setConfirmPassword("");
    onClose();
  }

  async function save() {
    const result = validateAgentAccountDraft(draft);
    setErrors(result.errors);
    if (!result.isValid) return;

    setSaving(true);
    let status: number;
    let body: AgentAccountPatchResponse | { error?: string } = {};
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result.patch),
      });
      status = res.status;
      body = (await res.json().catch(() => ({}))) as typeof body;
    } catch {
      toast.danger("No se pudo conectar con el servidor. Revisa la conexión y vuelve a intentar.");
      setSaving(false);
      return;
    }
    setSaving(false);

    const response = body as AgentAccountPatchResponse;
    if (response.nameUpdated && result.patch.displayName !== undefined) {
      onAgentRenamed(agent.id, result.patch.displayName);
      setOriginalDisplayName(result.patch.displayName);
    }

    if (status === 200 && response.ok) {
      const partes = [response.nameUpdated && "nombre visible", response.passwordUpdated && "contraseña"].filter(Boolean);
      toast.success(`Se guardó: ${partes.join(" y ")}.`);
      close();
      return;
    }

    if (status === 207) {
      const quedo = [
        response.nameUpdated && "El nombre visible se guardó.",
        response.passwordUpdated && "La contraseña se cambió.",
      ]
        .filter(Boolean)
        .join(" ");
      toast.warning(`${quedo} ${response.error ?? ""}`.trim());
      if (response.passwordUpdated) {
        setPassword("");
        setConfirmPassword("");
      }
      return;
    }

    toast.danger(body.error ?? "No se pudo guardar el cambio.");
  }

  const passwordType = showPasswords ? "text" : "password";

  return (
    <Modal isOpen onOpenChange={(open) => !open && close()}>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <KeyRound size={18} />
              </Modal.Icon>
              <Modal.Heading>Editar a {agent.displayName}</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="team-display-name">Nombre visible</Label>
                <Input
                  id="team-display-name"
                  value={displayName}
                  maxLength={60}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    clearFieldError("displayName");
                  }}
                  fullWidth
                />
                {errors.displayName && (
                  <p role="alert" className="lm-field-error">
                    {errors.displayName}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="team-password">Contraseña nueva</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    aria-pressed={showPasswords}
                    aria-label={showPasswords ? "Ocultar contraseñas" : "Mostrar contraseñas"}
                    onPress={() => setShowPasswords((v) => !v)}
                  >
                    {showPasswords ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                </div>
                <Input
                  id="team-password"
                  type={passwordType}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    clearFieldError("password");
                    clearFieldError("confirmPassword");
                  }}
                  fullWidth
                />
                <p className="text-xs text-muted">Déjala vacía para no cambiarla. Mínimo 8 caracteres.</p>
                {errors.password && (
                  <p role="alert" className="lm-field-error">
                    {errors.password}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="team-password-confirm">Confirmar contraseña</Label>
                <Input
                  id="team-password-confirm"
                  type={passwordType}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    clearFieldError("confirmPassword");
                  }}
                  fullWidth
                />
                {errors.confirmPassword && (
                  <p role="alert" className="lm-field-error">
                    {errors.confirmPassword}
                  </p>
                )}
              </div>
            </Modal.Body>
            <Modal.Footer className="justify-end gap-2">
              <Button size="sm" variant="secondary" onPress={close}>
                Cancelar
              </Button>
              <Button size="sm" isDisabled={!hasChanges || saving} onPress={() => void save()}>
                {saving ? "Guardando…" : "Guardar"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
