"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { CheckCheck, ChevronLeft, ChevronRight, Eye, Receipt, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import type { Agent, Invoice, Sale } from "@/lib/types";
import { PAYMENT_METHOD_LABELS } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { createInvoiceForSale, deleteSale, issueInvoice, returnSale, verifySale, voidInvoice } from "@/lib/mutations";
import { fetchInvoicesForSale } from "@/lib/invoices-data";
import { useLiveSales } from "@/lib/use-live-sales";
import { contactName, initials } from "@/lib/dashboard";
import { formatFullDateTime } from "@/lib/format";
import { formatDayKey, salesDayHistory, salesOnDay, shiftDayKey, summarizeSalesDay, todayKey } from "@/lib/sales-day";
import { SaleDetailModal } from "@/components/sales/sale-detail-modal";
import { AppRail, AppTopNav } from "@/components/app-rail";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";
import "@/components/clientes/clientes.css";
import "@/components/crm.css";
import "@/components/sales/sales.css";

interface SalesViewProps {
  currentAgent: Agent;
  initialSales: Sale[];
  /** Null si no se pudo leer la tasa BCV ese día: "Generar factura" sigue funcionando, con `bcv_rate: null`. */
  bcvRate: number | null;
}

// "es-VE" para que "$ 1.240,00" se lea a la venezolana (coma decimal), igual
// que los precios de inventario y facturas.
const AMOUNT_FORMATTER = new Intl.NumberFormat("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatUsd(amount: number): string {
  return `$ ${AMOUNT_FORMATTER.format(amount)}`;
}

function formatVes(amount: number): string {
  return `Bs. ${AMOUNT_FORMATTER.format(amount)}`;
}

function ventasLabel(count: number): string {
  return `${count} ${count === 1 ? "venta" : "ventas"}`;
}

function devueltasLabel(count: number): string {
  return `${count} ${count === 1 ? "devuelta" : "devueltas"}`;
}

/** "10 sep" para una fila del histórico: mediodía UTC, mismo truco que `formatDayKey`. */
function formatShortDay(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return format(new Date(Date.UTC(year, month - 1, day, 12)), "d MMM", { locale: es });
}

export function SalesView({ currentAgent, initialSales, bcvRate }: SalesViewProps) {
  const supabase = useMemo(() => createClient(), []);

  // La sección pide solo las ventas (filtradas en la base), no el histórico
  // completo de conversaciones para filtrarlo acá. El hook refetchea cuando
  // un evento toca una venta y descarta el tráfico de bandeja.
  const { sales: liveSales, refreshSales: refresh } = useLiveSales(supabase, initialSales);

  // Día elegido para las tarjetas y la lista (T6, "Los números del día",
  // 10/9/2026): arranca en hoy (zona del equipo) y se navega con las
  // flechas, el input de fecha o un clic en el histórico. El corte es en
  // memoria sobre `liveSales` — nunca se vuelve a pedir a Supabase.
  const [dayKey, setDayKey] = useState<string>(() => todayKey());
  const today = todayKey();
  const isToday = dayKey === today;

  const [detailId, setDetailId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Factura de la venta abierta en el detalle: `undefined` mientras carga,
  // `null` si la venta todavía no tiene ninguna. Se pide solo al abrir el
  // detalle —la lista no la necesita— y queda en caché por id de venta para
  // no repetir la consulta si se vuelve a abrir el mismo detalle.
  const [invoicesBySale, setInvoicesBySale] = useState<Record<string, Invoice | null>>({});
  const [invoiceBusyId, setInvoiceBusyId] = useState<string | null>(null);
  const loadedInvoiceIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!detailId || loadedInvoiceIds.current.has(detailId)) return;
    loadedInvoiceIds.current.add(detailId);
    let cancelled = false;

    fetchInvoicesForSale(supabase, detailId)
      .then((invoices) => {
        if (!cancelled) setInvoicesBySale((current) => ({ ...current, [detailId]: invoices[0] ?? null }));
      })
      .catch(() => {
        // Una factura que no se pudo leer no puede tumbar el detalle de la
        // venta: se trata como "sin factura todavía" y "Generar factura"
        // sigue disponible para reintentar.
        loadedInvoiceIds.current.delete(detailId);
        if (!cancelled) setInvoicesBySale((current) => ({ ...current, [detailId]: null }));
      });

    return () => {
      cancelled = true;
    };
  }, [detailId, supabase]);

  // El orden lo decide el cierre; `fetchSales` ya lo trae así, pero se
  // reafirma para que un refetch parcial no lo desarme.
  const sales = useMemo(
    () =>
      [...liveSales].sort(
        (a, b) =>
          new Date(b.dealClosedAt ?? b.createdAt).getTime() - new Date(a.dealClosedAt ?? a.createdAt).getTime()
      ),
    [liveSales]
  );

  const daySales = useMemo(() => salesOnDay(sales, dayKey), [sales, dayKey]);
  const daySummary = useMemo(() => summarizeSalesDay(sales, dayKey), [sales, dayKey]);
  const dayHistory = useMemo(() => salesDayHistory(sales, 30), [sales]);

  const detailSale = sales.find((s) => s.id === detailId) ?? null;

  async function handleGenerateInvoice(saleId: string) {
    const sale = sales.find((s) => s.id === saleId);
    if (!sale) return;
    setInvoiceBusyId(saleId);
    try {
      const invoice = await createInvoiceForSale(supabase, sale, currentAgent, bcvRate);
      setInvoicesBySale((current) => ({ ...current, [saleId]: invoice }));
    } finally {
      setInvoiceBusyId(null);
    }
  }

  async function handleIssueInvoice(saleId: string, invoiceId: string) {
    setInvoiceBusyId(saleId);
    try {
      const invoice = await issueInvoice(supabase, invoiceId, currentAgent);
      setInvoicesBySale((current) => ({ ...current, [saleId]: invoice }));
    } finally {
      setInvoiceBusyId(null);
    }
  }

  async function handleVoidInvoice(saleId: string, invoiceId: string) {
    setInvoiceBusyId(saleId);
    try {
      const invoice = await voidInvoice(supabase, invoiceId);
      setInvoicesBySale((current) => ({ ...current, [saleId]: invoice }));
    } finally {
      setInvoiceBusyId(null);
    }
  }

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

            <div className="sales-toolbar">
              <div className="dash-header">
                <div>
                  <h1 className="dash-title dash-display">Ventas</h1>
                  <p className="dash-subtitle">El flujo de ventas que se van cerrando a lo largo de la jornada.</p>
                </div>
              </div>

              <div className="cli-stats">
                <div className="cli-stat">
                  <span className="lm-eyebrow">Ventas del día</span>
                  <span className="lm-num cli-stat-value">{daySummary.count}</span>
                  <span className="cli-stat-note">de todo el equipo</span>
                </div>
                <div className="cli-stat">
                  <span className="lm-eyebrow">Vendido el día</span>
                  <span className="lm-num cli-stat-value">{formatUsd(daySummary.amountUsd)}</span>
                  {daySummary.amountVes > 0 && (
                    <span className="cli-stat-note">más {formatVes(daySummary.amountVes)} en bolívares</span>
                  )}
                </div>
                <div className="cli-stat">
                  <span className="lm-eyebrow">Devueltas</span>
                  <span className="lm-num cli-stat-value">{daySummary.returned}</span>
                </div>
              </div>

              <div className="sales-day-picker">
                <label className="sales-day-label" htmlFor="ventas-dia">
                  Día
                </label>
                <button
                  type="button"
                  className="crm-pill"
                  onClick={() => setDayKey((current) => shiftDayKey(current, -1))}
                  aria-label="Día anterior"
                >
                  <ChevronLeft size={14} />
                </button>
                <input
                  type="date"
                  id="ventas-dia"
                  aria-label="Elegir día"
                  className="sales-day-input"
                  value={dayKey}
                  max={today}
                  onChange={(event) => {
                    if (event.target.value) setDayKey(event.target.value);
                  }}
                />
                <button
                  type="button"
                  className="crm-pill"
                  onClick={() => setDayKey((current) => shiftDayKey(current, 1))}
                  disabled={dayKey >= today}
                  aria-label="Día siguiente"
                >
                  <ChevronRight size={14} />
                </button>
                <button
                  type="button"
                  className="crm-pill"
                  onClick={() => setDayKey(today)}
                  disabled={isToday}
                >
                  Hoy
                </button>
              </div>
            </div>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">{isToday ? "Ventas de hoy" : `Ventas del ${formatDayKey(dayKey)}`}</h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">{daySales.length} en el día</span>
              </div>

              {daySales.length === 0 ? (
                <div className="dash-empty">
                  <p className="dash-empty-title">
                    {isToday ? "Todavía no hay ventas cerradas" : "Ningún cierre ese día"}
                  </p>
                  <p className="dash-empty-hint">
                    {isToday
                      ? "Aparecerán aquí en cuanto se cierre la primera venta del día."
                      : "Elegí otro día con las flechas o desde el histórico."}
                  </p>
                </div>
              ) : (
                <div className="sales-list">
                  {daySales.map((sale) => {
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

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Histórico · últimos 30 días con ventas</h2>
              </div>

              {dayHistory.length === 0 ? (
                <div className="dash-empty">
                  <p className="dash-empty-title">Todavía no hay días con ventas</p>
                </div>
              ) : (
                <div className="sales-history">
                  {dayHistory.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      className="sales-history-row"
                      aria-current={entry.key === dayKey ? "true" : undefined}
                      onClick={() => setDayKey(entry.key)}
                    >
                      <span className="lm-num sales-history-date">{formatShortDay(entry.key)}</span>
                      <span className="sales-history-count">{ventasLabel(entry.count)}</span>
                      <span className="lm-num sales-history-amount">{formatUsd(entry.amountUsd)}</span>
                      {entry.returned > 0 && (
                        <span className="sales-history-returned">· {devueltasLabel(entry.returned)}</span>
                      )}
                    </button>
                  ))}
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
        currentAgent={currentAgent}
        busy={busyId === detailId}
        confirmingDelete={detailId !== null && confirmDeleteId === detailId}
        onVerify={handleVerify}
        onReturn={handleReturn}
        onDelete={handleDelete}
        invoice={detailId ? invoicesBySale[detailId] : undefined}
        invoiceBusy={invoiceBusyId !== null && invoiceBusyId === detailId}
        onGenerateInvoice={handleGenerateInvoice}
        onIssueInvoice={handleIssueInvoice}
        onVoidInvoice={handleVoidInvoice}
      />
    </div>
  );
}
