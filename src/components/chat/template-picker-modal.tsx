"use client";

import { FileText, Send } from "lucide-react";
import { Button, Chip, Modal } from "@heroui/react";
import type { WhatsappTemplate } from "@/lib/types";

const CATEGORY_LABEL: Record<WhatsappTemplate["category"], string> = {
  utility: "Utilidad",
  marketing: "Marketing",
  authentication: "Autenticación",
};

interface TemplatePickerModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  templates: WhatsappTemplate[];
  onSelect: (template: WhatsappTemplate) => void;
}

export function TemplatePickerModal({ isOpen, onOpenChange, templates, onSelect }: TemplatePickerModalProps) {
  const approved = templates.filter((t) => t.status === "approved");
  const other = templates.filter((t) => t.status !== "approved");

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
            <Modal.Body className="flex flex-col gap-2">
              {templates.length === 0 && (
                <p className="text-sm text-muted">Este canal aún no tiene plantillas registradas.</p>
              )}
              {approved.map((template) => (
                <TemplateRow key={template.id} template={template} onSelect={onSelect} usable />
              ))}
              {other.length > 0 && (
                <div className="mt-2 flex flex-col gap-2">
                  <p className="text-xs font-medium text-muted uppercase tracking-wide">
                    Pendientes / rechazadas por Meta
                  </p>
                  {other.map((template) => (
                    <TemplateRow key={template.id} template={template} onSelect={onSelect} usable={false} />
                  ))}
                </div>
              )}
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

function TemplateRow({
  template,
  onSelect,
  usable,
}: {
  template: WhatsappTemplate;
  onSelect: (template: WhatsappTemplate) => void;
  usable: boolean;
}) {
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
      <Button size="sm" variant="primary" isDisabled={!usable} onPress={() => onSelect(template)}>
        <Send size={14} />
        Usar
      </Button>
    </div>
  );
}
