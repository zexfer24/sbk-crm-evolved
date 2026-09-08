"use client";

import { CheckCheck, CreditCard, IdCard, MapPin, Phone, Receipt, RotateCcw, ShieldCheck, Trash2, UserCheck, XCircle } from "lucide-react";
import Link from "next/link";
import { Button, Modal } from "@heroui/react";
import type { Agent, Invoice, Sale } from "@/lib/types";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { formatFullDateTime } from "@/lib/format";
import { contactName } from "@/lib/dashboard";
import { formatInvoiceNumber, INVOICE_STATUS_LABELS } from "@/lib/invoices";
import { MediaThumb } from "@/components/chat/media-lightbox";

interface SaleDetailModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  sale: Sale | null;
  currentAgent: Agent;
  busy: boolean;
  confirmingDelete: boolean;
  onVerify: (id: string) => void;
  onReturn: (id: string) => void;
  onDelete: (id: string) => void;
  /** `undefined` mientras se pide, `null` si la venta todavía no tiene ninguna. */
  invoice: Invoice | null | undefined;
  invoiceBusy: boolean;
  onGenerateInvoice: (saleId: string) => void;
  onIssueInvoice: (saleId: string, invoiceId: string) => void;
  onVoidInvoice: (saleId: string, invoiceId: string) => void;
}

export function SaleDetailModal({
  isOpen,
  onOpenChange,
  sale,
  currentAgent,
  busy,
  confirmingDelete,
  onVerify,
  onReturn,
  onDelete,
  invoice,
  invoiceBusy,
  onGenerateInvoice,
  onIssueInvoice,
  onVoidInvoice,
}: SaleDetailModalProps) {
  if (!sale) return null;

  const contact = sale.contact;
  const cedula = contact.cedulaType && contact.cedulaNumber ? `${contact.cedulaType}-${contact.cedulaNumber}` : null;
  const location = [contact.city, contact.state].filter(Boolean).join(", ");
  const isReturned = sale.dealStatus === "returned";
  // Emitir y anular son sensibles (RLS los exige de supervisor/admin, ver
  // 20260909040000_invoices.sql): el botón se esconde acá para que un
  // asesor común ni lo vea, aunque la base es la que de verdad lo bloquea.
  const canManageInvoice = currentAgent.role === "supervisor" || currentAgent.role === "admin";

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Detalle de la venta</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-base font-semibold">{contactName(sale)}</p>
                  {sale.dealAmount !== null && (
                    <p className="lm-num text-lg font-semibold">
                      {sale.dealCurrency === "VES" ? "Bs. " : "$"}
                      {sale.dealAmount.toFixed(2)}
                    </p>
                  )}
                </div>
                <p className="text-xs text-muted">
                  {isReturned ? "Venta devuelta" : "Venta cerrada"} · {formatFullDateTime(sale.dealClosedAt ?? sale.createdAt)}
                </p>
              </div>

              <div className="flex flex-col gap-1.5 text-sm">
                <p className="flex items-center gap-2">
                  <Phone size={13} className="text-muted" />
                  <span className="lm-num">{contact.phoneNumber}</span>
                </p>
                {cedula && (
                  <p className="flex items-center gap-2">
                    <IdCard size={13} className="text-muted" />
                    <span className="lm-num">{cedula}</span>
                  </p>
                )}
                {(location || contact.address) && (
                  <p className="flex items-center gap-2">
                    <MapPin size={13} className="text-muted" />
                    <span>{[contact.address, location].filter(Boolean).join(" — ")}</span>
                  </p>
                )}
                <p className="flex items-center gap-2">
                  <CreditCard size={13} className="text-muted" />
                  <span>
                    {sale.dealPaymentMethod
                      ? PAYMENT_METHOD_LABELS[sale.dealPaymentMethod]
                      : "Método de pago sin registrar"}
                  </span>
                </p>
                <p className="flex items-center gap-2">
                  <UserCheck size={13} className="text-muted" />
                  {/* Las ventas cerradas antes de que existiera el campo no
                      dejaron autor recuperable: se dice, en vez de atribuirlas
                      al asesor asignado, que no es lo mismo. */}
                  <span>
                    {sale.dealClosedBy
                      ? `Cerrada por ${sale.dealClosedBy.displayName}`
                      : "Cerrada por un asesor sin registrar"}
                  </span>
                </p>
              </div>

              {sale.dealVerified && (
                <p className="sales-verified-note">
                  <ShieldCheck size={13} />
                  Verificado por {sale.dealVerifiedBy?.displayName ?? "un asesor"}
                  {sale.dealVerifiedAt ? ` · ${formatFullDateTime(sale.dealVerifiedAt)}` : ""}
                </p>
              )}

              <div>
                <p className="lm-eyebrow mb-2">Comprobante de pago</p>
                {sale.dealPaymentProofUrl ? (
                  <MediaThumb
                    items={[{ url: sale.dealPaymentProofUrl, type: "image", caption: "Comprobante de pago" }]}
                    index={0}
                    className="crm-thumb-sm"
                  />
                ) : (
                  <p className="text-xs text-muted">No se adjuntó comprobante.</p>
                )}
              </div>

              <div>
                <p className="lm-eyebrow mb-2">Factura</p>
                {invoice === undefined ? (
                  <p className="text-xs text-muted">Buscando factura…</p>
                ) : invoice === null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={invoiceBusy}
                    onPress={() => onGenerateInvoice(sale.id)}
                  >
                    <Receipt size={14} />
                    Generar factura
                  </Button>
                ) : (
                  <div className="sales-invoice-row">
                    <span className="lm-num sales-invoice-number">{formatInvoiceNumber(invoice.number)}</span>
                    <span
                      className="ac-badge"
                      data-tone={
                        invoice.status === "issued" ? "good" : invoice.status === "void" ? "hot" : "wait"
                      }
                    >
                      {INVOICE_STATUS_LABELS[invoice.status]}
                    </span>
                    <Link href={`/ventas/factura/${invoice.id}`} target="_blank" className="sales-goto-chat">
                      Ver e imprimir →
                    </Link>
                    {canManageInvoice && invoice.status === "draft" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={invoiceBusy}
                        onPress={() => onIssueInvoice(sale.id, invoice.id)}
                      >
                        <CheckCheck size={13} />
                        Emitir
                      </Button>
                    )}
                    {canManageInvoice && invoice.status !== "void" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={invoiceBusy}
                        onPress={() => onVoidInvoice(sale.id, invoice.id)}
                      >
                        <XCircle size={13} />
                        Anular
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <Link href={`/inbox?conversation=${sale.id}`} className="sales-goto-chat">
                Ir a la conversación →
              </Link>
            </Modal.Body>
            <Modal.Footer className="flex-wrap justify-between gap-2">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy || sale.dealVerified}
                  onPress={() => onVerify(sale.id)}
                >
                  <CheckCheck size={14} />
                  Verificar
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy || isReturned}
                  onPress={() => onReturn(sale.id)}
                >
                  <RotateCcw size={14} />
                  Devolución
                </Button>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="sales-danger-btn"
                isDisabled={busy}
                onPress={() => onDelete(sale.id)}
              >
                <Trash2 size={14} />
                {confirmingDelete ? "¿Seguro? Confirmar" : "Eliminar"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
