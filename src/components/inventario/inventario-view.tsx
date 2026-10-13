import Link from "next/link";
import { Package } from "lucide-react";
import type { Agent, MotoCatalogSummary, Product } from "@/lib/types";
import { BUSINESS_NAME } from "@/lib/brand";
import {
  INVENTORY_FILTER_LABELS,
  INVENTORY_PAGE_SIZE,
  INVENTORY_SORT_LABELS,
  LOW_STOCK_THRESHOLD,
  inventoryFilterHref,
  inventoryHref,
  inventoryTotalPages,
  ordenPorDefecto,
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
import { CarritoBoton } from "@/components/inventario/carrito-boton";
import { InventarioPaginador } from "@/components/inventario/inventario-paginador";
import { InventarioCarritoProvider } from "@/components/inventario/inventario-carrito-provider";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";
import "@/components/crm.css";
import "@/components/clientes/clientes.css";
import "@/components/inventario/inventario.css";

const FILTERS: InventoryFilter[] = ["todos", "agotados", "bajo-stock", "inactivos", "sin-peso"];
// «existencia» no es una píldora: es el orden por defecto de «Sin peso» (ver `ordenPorDefecto`).
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
    title: "Todo el catálogo sigue en Saint",
    hint: "Ningún repuesto salió de la fuente todavía. Si Saint da de baja uno, aparece acá.",
  },
  "sin-peso": {
    title: "Todo el catálogo activo tiene peso cargado",
    hint: "Cashea ya puede calcular el envío gratis con lo que hay.",
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
    ...(params.sort !== ordenPorDefecto(params.filter) ? { orden: params.sort } : {}),
  };

  // Rol `caja` (13/10/2026): solo consulta. La base ya no le deja guardar el
  // peso; la pantalla no le ofrece los campos, el rail le deja solo Inventario.
  const soloLectura = currentAgent.role === "caja";

  const empty = params.query
    ? {
        title: "Ningún repuesto coincide con esa búsqueda",
        hint: "Si el cliente lo pide con otro nombre, revisa los sinónimos del catálogo de motos.",
      }
    : EMPTY_BY_FILTER[params.filter];

  // El provider no agrega DOM y envuelve `.dash` por FUERA: `.dash-frame` es un
  // grid de dos columnas y un hijo de más le desarma la pantalla (trampa del
  // 9/9/2026). El panel del carrito sale por el portal del Drawer.
  return (
    <InventarioCarritoProvider agentId={currentAgent.id} bcvRate={rate}>
      <div className="dash">
        <div className="dash-frame">
          <AppRail active="inventario" soloInventario={soloLectura} />

          <main className="dash-main">
            <div className="dash-content">
              <header className="dash-topbar">
                <p className="dash-brand">
                  <span className="dash-brand-mark" aria-hidden="true">
                    <Package size={14} />
                  </span>
                  <span className="dash-brand-name">{BUSINESS_NAME}</span>
                </p>

                <AppTopNav active="inventario" soloInventario={soloLectura} />

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
                    {soloLectura
                      ? "Esto es exactamente lo que la IA consulta al cotizarle a un cliente. Nombre, precio y existencia llegan de Saint cada minuto: acá es solo consulta de precios, existencia y Cashea."
                      : "Esto es exactamente lo que la IA consulta al cotizarle a un cliente. Nombre, precio y existencia llegan de Saint cada minuto y no se editan acá; lo único que se carga a mano es el peso."}
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
                <div className="cli-stat">
                  <span className="lm-eyebrow">Sin peso</span>
                  <span className="lm-num cli-stat-value">{totals.withoutWeight}</span>
                  <span className="cli-stat-note">Cashea lo exige para el envío gratis, y sin peso no hay precio estándar.</span>
                </div>
                {/* La antigüedad del catálogo, por la misma razón que la fecha de
                    la tasa: `updated_at` es desde el 25/9/2026 la última vez que
                    `saint.sync_products()` confirmó esta fila contra Saint (la
                    toca aunque nada haya cambiado, al menos cada 6 h mientras la
                    réplica siga viva) — un atraso de días ya no es una demora
                    normal, es la señal de que el job o la réplica se cayeron. Un
                    stock de hace cuatro días le hace prometer a la IA algo ya
                    vendido. */}
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

              {/* `inv-panel-lista` deja aire debajo del paginador para el botón flotante del carrito. */}
              <section className="dash-panel inv-panel-lista">
                <div className="cli-toolbar">
                  <UrlSearchBox
                    basePath="/inventario"
                    query={params.query}
                    keep={keepInSearch}
                    placeholder="Buscar por nombre, marca o código"
                    label="Buscar en el inventario"
                  />

                  <div className="cli-filters" role="group" aria-label="Filtrar repuestos">
                    {FILTERS.map((filter) => (
                      <Link
                        key={filter}
                        className="crm-pill"
                        href={inventoryFilterHref(params, filter)}
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
                  {/* «Sin peso» abre por existencia sin que ninguna píldora de orden lo diga: la nota lo hace explícito. */}
                  {params.filter === "sin-peso" && params.sort === "existencia" && (
                    <span className="dash-panel-note inv-orden-nota">Ordenado por existencia, de mayor a menor</span>
                  )}
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
                      <ProductoFila key={product.id} product={product} bcvRate={rate} soloLectura={soloLectura} />
                    ))}
                  </ul>
                )}

                {pages > 1 && <InventarioPaginador params={params} pages={pages} />}
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

            {/* Flotante (`position: fixed`): sale del flujo, así que no es una columna más de `.dash-frame` ni un bloque más de `.dash-content`. */}
            <CarritoBoton />
          </main>
        </div>
      </div>
    </InventarioCarritoProvider>
  );
}
