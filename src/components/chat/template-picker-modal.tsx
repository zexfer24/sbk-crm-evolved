"use client";

import { useEffect, useState } from "react";
import { FileText, Send } from "lucide-react";
import { Button, Chip, Input, Label, Modal, Tooltip } from "@heroui/react";
import type { WhatsappTemplate } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchConversationQuotes } from "@/lib/data";
import { substituteTemplateVariables, templateVariableCount } from "@/lib/whatsapp/template-variables";

const CATEGORY_LABEL: Record<WhatsappTemplate["category"], string> = {
  utility: "Utilidad",
  marketing: "Marketing",
  authentication: "Autenticación",
};

interface TemplatePickerModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  templates: WhatsappTemplate[];
  /** Nombre del cliente: primera sugerencia para cualquier variable. */
  contactName: string;
  /**
   * Para ofrecer "último repuesto cotizado" como sugerencia (T3.3, 5/9/2026).
   * Se resuelve acá mismo, con la consulta que ya existe para el carrito de
   * venta (`fetchConversationQuotes`) — no es una consulta nueva a la base,
   * es la misma fuente que usa `sale-items-editor.tsx`.
   */
  conversationId: string;
  onSelect: (template: WhatsappTemplate, variables: string[]) => void;
}

export function TemplatePickerModal({
  isOpen,
  onOpenChange,
  templates,
  contactName,
  conversationId,
  onSelect,
}: TemplatePickerModalProps) {
  const approved = templates.filter((t) => t.status === "approved");
  const other = templates.filter((t) => t.status !== "approved");

  // La plantilla que se está por enviar, mientras el asesor llena sus
  // variables (null = todavía en la lista). Se limpia al cerrar el modal:
  // volver a abrirlo siempre arranca en la lista, nunca a mitad de un envío
  // de la vez anterior.
  const [selected, setSelected] = useState<WhatsappTemplate | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [lastQuotedProductName, setLastQuotedProductName] = useState<string | null>(null);

  // Ajuste de estado DURANTE el render (no en un efecto) al detectar que el
  // modal se cerró: mismo patrón que `lastConversationId` en `chat-panel.tsx`.
  // Un `useEffect` que llama `setState` de forma síncrona en el cuerpo
  // dispara un render en cascada que el linter de hooks señala.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (!isOpen) {
      setSelected(null);
      setValues([]);
    }
  }

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    fetchConversationQuotes(createClient(), conversationId)
      .then((quotes) => {
        // Más recientes primero (la consulta ya viene ordenada así): el
        // primero es el último repuesto que la IA le cotizó en este chat.
        if (!cancelled) setLastQuotedProductName(quotes[0]?.productName ?? null);
      })
      .catch(() => {
        // Es una sugerencia, no una dependencia dura del envío: sin ella el
        // asesor sigue teniendo el nombre del contacto para llenar el campo.
        if (!cancelled) setLastQuotedProductName(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, conversationId]);

  function handleUse(template: WhatsappTemplate) {
    const count = templateVariableCount(template.bodyPreview);
    if (count === 0) {
      onSelect(template, []);
      return;
    }
    setSelected(template);
    setValues(Array(count).fill(""));
  }

  function handleConfirmSend() {
    if (!selected) return;
    onSelect(selected, values);
    setSelected(null);
    setValues([]);
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <FileText size={18} />
              </Modal.Icon>
              <Modal.Heading>Plantillas preaprobadas</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            {selected ? (
              <TemplateVariablesForm
                template={selected}
                values={values}
                onChange={setValues}
                contactName={contactName}
                lastQuotedProductName={lastQuotedProductName}
                onBack={() => setSelected(null)}
                onConfirm={handleConfirmSend}
              />
            ) : (
              <>
                <Modal.Body className="flex flex-col gap-2">
                  {templates.length === 0 && (
                    <p className="text-sm text-muted">Este canal aún no tiene plantillas registradas.</p>
                  )}
                  {approved.map((template) => (
                    <TemplateRow key={template.id} template={template} onUse={handleUse} usable />
                  ))}
                  {other.length > 0 && (
                    <div className="mt-2 flex flex-col gap-2">
                      <p className="text-xs font-medium text-muted uppercase tracking-wide">
                        Pendientes / rechazadas por Meta
                      </p>
                      {other.map((template) => (
                        <TemplateRow key={template.id} template={template} onUse={handleUse} usable={false} />
                      ))}
                    </div>
                  )}
                </Modal.Body>
                <Modal.Footer>
                  <Button variant="secondary" onPress={() => onOpenChange(false)}>
                    Cerrar
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function TemplateRow({
  template,
  onUse,
  usable,
}: {
  template: WhatsappTemplate;
  onUse: (template: WhatsappTemplate) => void;
  usable: boolean;
}) {
  const button = (
    <Button size="sm" variant="primary" isDisabled={!usable} onPress={() => onUse(template)}>
      <Send size={14} />
      Usar
    </Button>
  );

  return (
    <div className="flex items-start justify-between gap-3 rounded-field border border-border bg-surface p-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{template.name}</span>
          <Chip size="sm" color="default">
            <Chip.Label>{CATEGORY_LABEL[template.category]}</Chip.Label>
          </Chip>
          <Chip size="sm" color={template.status === "approved" ? "success" : "warning"}>
            <Chip.Label>{template.status === "approved" ? "Aprobada" : "Pendiente"}</Chip.Label>
          </Chip>
        </div>
        <p className="text-xs text-muted">{template.bodyPreview}</p>
      </div>
      {/* Deshabilitada explica POR QUÉ en el tooltip: un botón apagado sin
          motivo se ve roto, no "todavía no se puede". */}
      {usable ? (
        button
      ) : (
        <Tooltip>
          <Tooltip.Trigger>{button}</Tooltip.Trigger>
          <Tooltip.Content>
            {template.status === "rejected"
              ? "Meta rechazó esta plantilla: no se puede enviar."
              : "Meta todavía no aprobó esta plantilla."}
          </Tooltip.Content>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Un campo por variable posicional, con sugerencias que lo llenan de un
 * clic (el nombre del contacto siempre; el último repuesto cotizado en este
 * chat, si lo hay) y una vista previa del cuerpo ya sustituido, para que el
 * asesor vea exactamente lo que va a recibir el cliente antes de mandarlo.
 */
function TemplateVariablesForm({
  template,
  values,
  onChange,
  contactName,
  lastQuotedProductName,
  onBack,
  onConfirm,
}: {
  template: WhatsappTemplate;
  values: string[];
  onChange: (values: string[]) => void;
  contactName: string;
  lastQuotedProductName: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const preview = substituteTemplateVariables(template.bodyPreview, values);
  const allFilled = values.every((v) => v.trim().length > 0);

  function setValueAt(index: number, value: string) {
    const next = [...values];
    next[index] = value;
    onChange(next);
  }

  return (
    <>
      <Modal.Body className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Plantilla <span className="font-medium text-foreground">{template.name}</span>: completa cada
          variable antes de enviar.
        </p>

        {values.map((value, index) => (
          <div className="flex flex-col gap-1" key={index}>
            <Label htmlFor={`plantilla-variable-${index + 1}`}>Variable {`{{${index + 1}}}`}</Label>
            <Input
              id={`plantilla-variable-${index + 1}`}
              value={value}
              onChange={(e) => setValueAt(index, e.target.value)}
              fullWidth
            />
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className="crm-pill"
                onClick={() => setValueAt(index, contactName)}
              >
                {contactName}
              </button>
              {lastQuotedProductName && (
                <button
                  type="button"
                  className="crm-pill"
                  onClick={() => setValueAt(index, lastQuotedProductName)}
                >
                  {lastQuotedProductName}
                </button>
              )}
            </div>
          </div>
        ))}

        <div className="rounded-field border border-border bg-default p-3">
          <p className="mb-1 text-xs font-medium text-muted uppercase tracking-wide">Vista previa</p>
          <p className="text-sm">{preview}</p>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onPress={onBack}>
          Volver
        </Button>
        <Button variant="primary" isDisabled={!allFilled} onPress={onConfirm}>
          <Send size={14} />
          Enviar
        </Button>
      </Modal.Footer>
    </>
  );
}
