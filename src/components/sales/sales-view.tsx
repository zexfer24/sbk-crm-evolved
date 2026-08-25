"use client";

import { useMemo, useState } from "react";
import { CheckCheck, Eye, Receipt, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import type { Agent, Conversation } from "@/lib/types";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { deleteSale, returnSale, verifySale } from "@/lib/mutations";
import { useLiveConversations } from "@/lib/use-live-conversations";
import { contactName, initials } from "@/lib/dashboard";
import { formatFullDateTime } from "@/lib/format";
import { SaleDetailModal } from "@/components/sales/sale-detail-modal";
import { AppRail, AppTopNav } from "@/components/app-rail";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";
import "@/components/crm.css";
import "@/components/sales/sales.css";

interface SalesViewProps {
  currentAgent: Agent;
  initialConversations: Conversation[];
}

export function SalesView({ currentAgent, initialConversations }: SalesViewProps) {
  const supabase = useMemo(() => createClient(), []);

  // Antes cada evento de conversations —cada mensaje del equipo— refetcheaba
  // acá el histórico completo, sin agrupar y aun con la pestaña oculta. Al
  // hook solo lo hacen refetchear los cambios de venta (el monto vive en
  // `orders`); el resto del tráfico se resuelve en memoria sin pedir nada.
  const { conversations, refreshConversations: refresh } = useLiveConversations(
    supabase,
    initialConversations,
    { channelName: "sales-conversations" }
  );

  const [detailId, setDetailId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const sales = useMemo(
    () =>
      conversations
        .filter((c) => c.dealStatus === "won" || c.dealStatus === "returned")
        .sort(
          (a, b) =>
            new Date(b.dealClosedAt ?? b.createdAt).getTime() - new Date(a.dealClosedAt ?? a.createdAt).getTime()
        ),
    [conversations]
  );

  const detailSale = sales.find((s) => s.id === detailId) ?? null;

  async function handleVerify(id: string) {
    setBusyId(id);
    try {
      await verifySale(supabase, id, currentAgent);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleReturn(id: string) {
    setBusyId(id);
    try {
      await returnSale(supabase, id, currentAgent);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    setBusyId(id);
    try {
      await deleteSale(supabase, id, currentAgent);
      setDetailId((current) => (current === id ? null : current));
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="ventas" />

        <main className="dash-main">
          <div className="dash-content">
            <header className="dash-topbar">
              <p className="dash-brand">
                <span className="dash-brand-mark" aria-hidden="true">
                  <Receipt size={14} />
                </span>
                <span className="dash-brand-name">SBK Motorcycles</span>
              </p>

              <AppTopNav active="ventas" />

              <div className="dash-topbar-actions">
                <span className="dash-icon-btn dash-icon-static" title={currentAgent.displayName}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{initials(currentAgent.displayName)}</span>
                </span>
              </div>
            </header>

            <div className="dash-header">
              <div>
                <h1 className="dash-title dash-display">Ventas</h1>
                <p className="dash-subtitle">El flujo de ventas que se van cerrando a lo largo de la jornada.</p>
              </div>
            </div>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Ventas cerradas</h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">{sales.length} en total</span>
              </div>

              {sales.length === 0 ? (
                <div className="dash-empty">
                  <p className="dash-empty-title">Todavía no hay ventas cerradas</p>
                  <p className="dash-empty-hint">Aparecerán aquí en cuanto se cierre la primera venta del día.</p>
                </div>
              ) : (
                <div className="sales-list">
                  {sales.map((sale) => {
                    const name = contactName(sale);
                    const isReturned = sale.dealStatus === "returned";
                    const isBusy = busyId === sale.id;
                    return (
                      <div className="sales-row" key={sale.id}>
                        <span className="sales-row-avatar" aria-hidden="true">
                          {initials(name)}
                        </span>

                        <div className="sales-row-body">
                          <span className="sales-row-name">{name}</span>
                          <span className="sales-row-meta">
                            {formatFullDateTime(sale.dealClosedAt ?? sale.createdAt)}
                            {/* Quién CERRÓ, no quién tiene asignado el hilo: es
                                lo que se le paga a alguien. Se nombra el rol en
                                el texto para que no se confunda con el asesor
                                asignado, que es lo que se mostraba antes. */}
                            {sale.dealClosedBy && ` · Cerró ${sale.dealClosedBy.displayName}`}
                            {sale.dealPaymentMethod &&
                              ` · ${PAYMENT_METHOD_LABELS[sale.dealPaymentMethod]}`}
                          </span>
                        </div>

                        <div className="sales-row-badges">
                          {sale.dealAmount !== null && (
                            <span className="lm-num sales-row-amount">
                              {sale.dealCurrency === "VES" ? "Bs. " : "$"}
                              {sale.dealAmount.toFixed(2)}
                            </span>
                          )}
                          <span className="ac-badge" data-tone={isReturned ? "hot" : "good"}>
                            {isReturned ? "Devuelta" : "Cerrada"}
                          </span>
                          {sale.dealVerified && (
                            <span className="ac-badge" data-tone="link">
                              <ShieldCheck size={11} />
                              Verificada
                            </span>
                          )}
                        </div>

                        <div className="sales-row-actions">
                          <button
                            type="button"
                            className="crm-pill"
                            onClick={() => setDetailId(sale.id)}
                            aria-label="Visualizar venta"
                          >
                            <Eye size={13} />
                            Visualizar
                          </button>
                          <button
                            type="button"
                            className="crm-pill"
                            onClick={() => handleReturn(sale.id)}
                            disabled={isBusy || isReturned}
                            aria-label="Registrar devolución"
                          >
                            <RotateCcw size={13} />
                            Devolución
                          </button>
                          <button
                            type="button"
                            className="crm-pill"
                            onClick={() => handleVerify(sale.id)}
                            disabled={isBusy || sale.dealVerified}
                            aria-label="Verificar comprobante"
                          >
                            <CheckCheck size={13} />
                            Verificar
                          </button>
                          <button
                            type="button"
                            className="crm-pill"
                            data-variant="danger"
                            onClick={() => handleDelete(sale.id)}
                            onBlur={() => setConfirmDeleteId((current) => (current === sale.id ? null : current))}
                            disabled={isBusy}
                            aria-label={confirmDeleteId === sale.id ? "Confirmar eliminación de la venta" : "Eliminar venta"}
                          >
                            <Trash2 size={13} />
                            {confirmDeleteId === sale.id ? "¿Seguro?" : "Eliminar"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </main>
      </div>

      <SaleDetailModal
        isOpen={detailId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null);
            setConfirmDeleteId(null);
          }
        }}
        sale={detailSale}
        busy={busyId === detailId}
        confirmingDelete={detailId !== null && confirmDeleteId === detailId}
        onVerify={handleVerify}
        onReturn={handleReturn}
        onDelete={handleDelete}
      />
    </div>
  );
}
