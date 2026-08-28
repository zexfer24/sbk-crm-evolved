import Link from "next/link";
import { Package } from "lucide-react";
import type { Agent, MotoCatalogSummary, Product } from "@/lib/types";
import {
  INVENTORY_FILTER_LABELS,
  INVENTORY_PAGE_SIZE,
  INVENTORY_SORT_LABELS,
  LOW_STOCK_THRESHOLD,
  inventoryHref,
  inventoryTotalPages,
  type InventoryFilter,
  type InventoryParams,
  type InventorySort,
} from "@/lib/inventory";
import type { InventoryTotals } from "@/lib/inventory-data";
import { freshnessNote, freshnessValue, inventoryFreshness } from "@/lib/inventory-freshness";
import { initials } from "@/lib/dashboard";
import { AppRail, AppTopNav } from "@/components/app-rail";
import { UrlSearchBox } from "@/components/url-search-box";
import { ProductoFila } from "@/components/inventario/producto-fila";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";
import "@/components/crm.css";
import "@/components/clientes/clientes.css";
import "@/components/inventario/inventario.css";

const FILTERS: InventoryFilter[] = ["todos", "agotados", "bajo-stock", "inactivos"];
const SORTS: InventorySort[] = ["nombre", "stock", "precio"];

/**
 * Qué dice la tarjeta de la tasa debajo del número.
 *
 * Siempre lleva la fecha, y avisa cuando el BCV no contestó. Antes decía solo
 * "Con la que se calculan los bolívares" sobre un número sin fecha: el CRM pasó
 * tres días cotizando con una tasa vieja y esta pantalla lo mostraba como si
 * nada.
 */
function rateNote(bcvRate: BcvRateSummary | null): string {
  if (!bcvRate) return "Sin tasa disponible ahora mismo: los precios van solo en dólares.";

  // Mediodía UTC para que el día no se corra al formatear en otra zona.
  const day = new Date(`${bcvRate.rateDate}T12:00:00Z`).toLocaleDateString("es-VE", {
    day: "numeric",
    month: "short",
  });

  return bcvRate.isStale
    ? `Del ${day}. No se pudo consultar al BCV: los bolívares pueden estar desactualizados.`
    : `Del ${day}. Con la que se calculan los bolívares.`;
}

/** Bajo un filtro, "no hay repuestos" sería falso: lo que no hay es repuestos en ese estado. */
const EMPTY_BY_FILTER: Record<InventoryFilter, { title: string; hint: string }> = {
  todos: {
    title: "El catálogo está vacío",
    hint: "Los repuestos se cargan desde el ERP. Mientras esté vacío, la IA no tiene nada que cotizarle a un cliente.",
  },
  agotados: {
    title: "No hay nada agotado",
    hint: "Todos los repuestos que la IA ofrece tienen unidades disponibles.",
  },
  "bajo-stock": {
    title: "Ningún repuesto está por acabarse",
    hint: `Nada bajó de ${LOW_STOCK_THRESHOLD} unidades.`,
  },
  inactivos: {
    title: "No hay repuestos desactivados",
    hint: "Todo el catálogo está visible para la IA.",
  },
};

interface InventarioViewProps {
  currentAgent: Agent;
  products: Product[];
  total: number;
  totals: InventoryTotals;
  catalog: MotoCatalogSummary;
  params: InventoryParams;
  /** Null cuando no hay ninguna tasa: el inventario abre igual, solo en dólares. */
  bcvRate: BcvRateSummary | null;
}

export function InventarioView({
  currentAgent,
  products,
  total,
  totals,
  catalog,
  params,
  bcvRate,
}: InventarioViewProps) {
  // Cero significa "sin tasa" para el cálculo de precios: `priceInBs` ya lo
  // trata así y deja la fila en dólares.
  const rate = bcvRate?.rate ?? 0;
  const freshness = inventoryFreshness(totals.updatedAt);
  const pages = inventoryTotalPages(total);
  const desde = total === 0 ? 0 : (params.page - 1) * INVENTORY_PAGE_SIZE + 1;
  const hasta = Math.min(params.page * INVENTORY_PAGE_SIZE, total);

  // Se conservan filtro y orden al buscar; la página se reinicia.
  const keepInSearch: Record<string, string> = {
    ...(params.filter !== "todos" ? { filtro: params.filter } : {}),
    ...(params.sort !== "nombre" ? { orden: params.sort } : {}),
  };

  const empty = params.query
    ? {
        title: "Ningún repuesto coincide con esa búsqueda",
        hint: "Si el cliente lo pide con otro nombre, revisa los sinónimos del catálogo de motos.",
      }
    : EMPTY_BY_FILTER[params.filter];

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="inventario" />

        <main className="dash-main">
          <div className="dash-content">
            <header className="dash-topbar">
              <p className="dash-brand">
                <span className="dash-brand-mark" aria-hidden="true">
                  <Package size={14} />
                </span>
                <span className="dash-brand-name">SBK Motorcycles</span>
              </p>

              <AppTopNav active="inventario" />

              <div className="dash-topbar-actions">
                <span className="dash-icon-btn dash-icon-static" title={currentAgent.displayName}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{initials(currentAgent.displayName)}</span>
                </span>
              </div>
            </header>

            <div className="dash-header">
              <div>
                <h1 className="dash-title dash-display">Inventario</h1>
                <p className="dash-subtitle">
                  Esto es exactamente lo que la IA consulta al cotizarle a un cliente. Lo que cambies acá vale desde
                  el próximo mensaje: no hay copia ni sincronización en el medio.
                </p>
              </div>
            </div>

            <div className="cli-stats">
              <div className="cli-stat">
                <span className="lm-eyebrow">Repuestos</span>
                <span className="lm-num cli-stat-value">{totals.productos}</span>
                <span className="cli-stat-note">{totals.activos} visibles para la IA</span>
              </div>
              <div className="cli-stat">
                <span className="lm-eyebrow">Agotados</span>
                <span className="lm-num cli-stat-value">{totals.agotados}</span>
                <span className="cli-stat-note">Activos con stock en cero: la IA los cotiza igual.</span>
              </div>
              <div className="cli-stat">
                <span className="lm-eyebrow">Bajo stock</span>
                <span className="lm-num cli-stat-value">{totals.bajos}</span>
                <span className="cli-stat-note">Quedan pocas unidades.</span>
              </div>
              {/* La antigüedad del catálogo, por la misma razón que la fecha de
                  la tasa: la sincronización vive en una aplicación aparte y
                  puede llevar días sin correr sin que nada lo delate. Un stock
                  de hace cuatro días le hace prometer a la IA algo ya vendido. */}
              <div className="cli-stat" data-stale={freshness.isStale ? "true" : undefined}>
                <span className="lm-eyebrow">Actualizado</span>
                <span className="lm-num cli-stat-value">{freshnessValue(freshness)}</span>
                <span className="cli-stat-note">{freshnessNote(freshness)}</span>
              </div>
              {/* La fecha va pegada al número a propósito: con esta tasa se
                  calculan precios, y una tasa de hace tres días se ve idéntica
                  a la de hoy si solo se muestra el número. */}
              <div className="cli-stat" data-stale={bcvRate?.isStale ? "true" : undefined}>
                <span className="lm-eyebrow">Tasa BCV</span>
                <span className="lm-num cli-stat-value">{bcvRate ? bcvRate.rate.toFixed(2) : "—"}</span>
                <span className="cli-stat-note">{rateNote(bcvRate)}</span>
              </div>
            </div>

            <section className="dash-panel">
              <div className="cli-toolbar">
                <UrlSearchBox
                  basePath="/inventario"
                  query={params.query}
                  keep={keepInSearch}
                  placeholder="Buscar repuesto por nombre, marca o descripción"
                  label="Buscar en el inventario"
                />

                <div className="cli-filters" role="group" aria-label="Filtrar repuestos">
                  {FILTERS.map((filter) => (
                    <Link
                      key={filter}
                      className="crm-pill"
                      href={inventoryHref({ ...params, filter, page: 1 })}
                      {...(params.filter === filter ? { "data-active": "true", "aria-current": "true" as const } : {})}
                    >
                      {INVENTORY_FILTER_LABELS[filter]}
                    </Link>
                  ))}
                </div>

                <div className="cli-filters" role="group" aria-label="Ordenar repuestos">
                  {SORTS.map((sort) => (
                    <Link
                      key={sort}
                      className="crm-pill"
                      href={inventoryHref({ ...params, sort, page: 1 })}
                      {...(params.sort === sort ? { "data-active": "true", "aria-current": "true" as const } : {})}
                    >
                      {INVENTORY_SORT_LABELS[sort]}
                    </Link>
                  ))}
                </div>
              </div>

              <div className="dash-panel-head">
                <h2 className="dash-panel-title">
                  {params.query ? `Resultados para «${params.query}»` : INVENTORY_FILTER_LABELS[params.filter]}
                </h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">
                  {total === 0 ? "Sin resultados" : `${desde}–${hasta} de ${total}`}
                </span>
              </div>

              {products.length === 0 ? (
                <div className="dash-empty">
                  <p className="dash-empty-title">{empty.title}</p>
                  <p className="dash-empty-hint">{empty.hint}</p>
                </div>
              ) : (
                <ul className="inv-list">
                  {products.map((product) => (
                    <ProductoFila key={product.id} product={product} bcvRate={rate} />
                  ))}
                </ul>
              )}

              {pages > 1 && (
                <nav className="cli-pager" aria-label="Paginación del inventario">
                  <Link
                    className="crm-pill"
                    href={inventoryHref({ ...params, page: Math.max(1, params.page - 1) })}
                    aria-disabled={params.page === 1}
                    {...(params.page === 1 ? { "data-disabled": "true" } : {})}
                  >
                    Anterior
                  </Link>
                  <span className="cli-pager-note">
                    Página <span className="lm-num">{params.page}</span> de <span className="lm-num">{pages}</span>
                  </span>
                  <Link
                    className="crm-pill"
                    href={inventoryHref({ ...params, page: Math.min(pages, params.page + 1) })}
                    aria-disabled={params.page === pages}
                    {...(params.page === pages ? { "data-disabled": "true" } : {})}
                  >
                    Siguiente
                  </Link>
                </nav>
              )}
            </section>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Catálogo de motos</h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">Solo lectura</span>
              </div>

              <div className="inv-catalog">
                <p className="inv-catalog-intro">
                  Estas tablas se importan del ERP y no se editan desde el CRM. Son las que permiten responder «¿qué
                  otros modelos llevan el mismo motor que el mío?» y entender la jerga con la que el cliente pide un
                  repuesto.
                </p>

                <div className="inv-catalog-grid">
                  <div className="inv-catalog-cell">
                    <span className="lm-num">{catalog.engineFamilies}</span>
                    <span>Familias de motor</span>
                  </div>
                  <div className="inv-catalog-cell">
                    <span className="lm-num">{catalog.commercialModels}</span>
                    <span>Modelos comerciales</span>
                  </div>
                  <div className="inv-catalog-cell">
                    <span className="lm-num">{catalog.modelEngineLinks}</span>
                    <span>Vínculos modelo–motor</span>
                  </div>
                  <div className="inv-catalog-cell">
                    <span className="lm-num">{catalog.compatibilityRules}</span>
                    <span>Reglas de compatibilidad</span>
                  </div>
                  <div className="inv-catalog-cell">
                    <span className="lm-num">{catalog.searchSynonyms}</span>
                    <span>Sinónimos de búsqueda</span>
                  </div>
                </div>

                {catalog.commercialModels === 0 && (
                  <p className="inv-catalog-warning">
                    El catálogo de motos está vacío en este entorno. La búsqueda de repuestos funciona igual, pero sin
                    compatibilidad cruzada entre modelos.
                  </p>
                )}
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
