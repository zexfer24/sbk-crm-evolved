"use client";

import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import type { Invoice } from "@/lib/types";
import { formatFullDateTime } from "@/lib/format";
import { formatInvoiceNumber, INVOICE_ISSUER, INVOICE_STATUS_LABELS } from "@/lib/invoices";
import "@/components/sales/sales.css";

interface InvoiceSheetProps {
  invoice: Invoice;
}

/** "Por definir" en cursiva para un dato fiscal del emisor que el operador todavía no cargó. */
function IssuerDetail({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="invoice-issuer-detail">
      {label}: {value ?? <span className="invoice-issuer-pending">Por definir</span>}
    </p>
  );
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function bs(amount: number, bcvRate: number): string {
  return `Bs. ${(amount * bcvRate).toFixed(2)}`;
}

/**
 * Hoja imprimible de una factura. Sin generación de PDF en servidor: se
 * imprime tal cual desde el navegador (`window.print()`) — decisión del
 * plan "Seis frentes del buzón" (T5, 8/9/2026), ver el encabezado de
 * `supabase/migrations/20260909040000_invoices.sql`.
 *
 * `INVOICE_ISSUER` trae RIF/dirección/teléfono/ciudad en null hasta que el
 * operador los defina: esta hoja los pinta como "Por definir" en vez de
 * inventar un dato fiscal para "verse completa".
 */
export function InvoiceSheet({ invoice }: InvoiceSheetProps) {
  const { customer } = invoice;
  const cedula = customer.cedulaType && customer.cedulaNumber ? `${customer.cedulaType}-${customer.cedulaNumber}` : null;
  const location = [customer.city, customer.state].filter(Boolean).join(", ");

  return (
    <div className="invoice-page">
      <div style={{ width: "100%" }}>
        <div className="invoice-toolbar invoice-no-print">
          <Link href="/ventas" className="sales-goto-chat" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft size={14} />
            Volver a Ventas
          </Link>
          <button type="button" className="crm-pill" onClick={() => window.print()}>
            <Printer size={13} />
            Imprimir
          </button>
        </div>

        <div className="invoice-sheet">
          <div className="invoice-header">
            <div>
              <p className="invoice-issuer-name">{INVOICE_ISSUER.name}</p>
              <IssuerDetail label="RIF" value={INVOICE_ISSUER.rif} />
              <IssuerDetail label="Dirección" value={INVOICE_ISSUER.address} />
              <IssuerDetail label="Teléfono" value={INVOICE_ISSUER.phone} />
              <IssuerDetail label="Ciudad" value={INVOICE_ISSUER.city} />
            </div>
            <div className="invoice-meta">
              <p className="invoice-number">{formatInvoiceNumber(invoice.number)}</p>
              <p className="invoice-meta-line">
                {formatFullDateTime(invoice.issuedAt ?? invoice.createdAt)}
              </p>
              <p className="invoice-meta-line">{INVOICE_STATUS_LABELS[invoice.status]}</p>
            </div>
          </div>

          <div className="invoice-customer">
            <p className="lm-eyebrow">Cliente</p>
            <p style={{ fontWeight: 600 }}>{customer.displayName}</p>
            <p className="lm-num">{customer.phoneNumber}</p>
            {cedula && <p className="lm-num">{cedula}</p>}
            {(location || customer.address) && <p>{[customer.address, location].filter(Boolean).join(" — ")}</p>}
          </div>

          <table className="invoice-items-table">
            <thead>
              <tr>
                <th>Descripción</th>
                <th className="invoice-col-num">Cant.</th>
                <th className="invoice-col-num">Precio unit.</th>
                <th className="invoice-col-num">Importe</th>
              </tr>
            </thead>
            <tbody>
              {invoice.items.map((item, index) => (
                <tr key={`${item.description}-${index}`}>
                  <td>{item.description}</td>
                  <td className="invoice-col-num lm-num">{item.quantity}</td>
                  <td className="invoice-col-num lm-num">{money(item.unitPrice)}</td>
                  <td className="invoice-col-num lm-num">{money(item.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="invoice-totals">
            <div className="invoice-totals-row">
              <span>Subtotal</span>
              <span className="lm-num">{money(invoice.subtotal)}</span>
            </div>
            <div className="invoice-totals-row">
              <span>IVA ({(invoice.taxRate * 100).toFixed(0)}%)</span>
              <span className="lm-num">{money(invoice.taxAmount)}</span>
            </div>
            <div className="invoice-totals-row invoice-total-final">
              <span>Total</span>
              <span className="lm-num">{money(invoice.total)}</span>
            </div>
            <div className="invoice-totals-row">
              <span>Total en bolívares</span>
              <span className="lm-num">
                {invoice.bcvRate !== null ? bs(invoice.total, invoice.bcvRate) : "Por definir"}
              </span>
            </div>
          </div>

          <div className="invoice-footer">
            <p className="invoice-meta-line">Generada el {formatFullDateTime(invoice.createdAt)}</p>
            {invoice.status === "void" && <p className="invoice-meta-line">Esta factura fue anulada.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
