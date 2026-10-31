"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Package } from "lucide-react";
import type { Agent, MotoCatalogSummary, Product } from "@/lib/types";
import { BUSINESS_NAME } from "@/lib/brand";
import {
  INVENTORY_FILTER_LABELS,
  INVENTORY_PAGE_SIZE,
  LOW_STOCK_THRESHOLD,
  inventoryTotalPages,
  ordenPorDefecto,
  type InventoryFilter,
  type InventoryParams,
  type InventoryView,
} from "@/lib/inventory";
import type { InventoryTotals } from "@/lib/inventory-data";
import { freshnessNote, freshnessValue, inventoryFreshness } from "@/lib/inventory-freshness";
import { initials } from "@/lib/dashboard";
import { AppRail, AppTopNav } from "@/components/app-rail";
import { UrlSearchBox } from "@/components/url-search-box";
import { ProductoFila } from "@/components/inventario/producto-fila";
import { ProductoTarjeta } from "@/components/inventario/producto-tarjeta";
import { ProductoFicha } from "@/components/inventario/producto-ficha";
import { OrdenMenu } from "@/components/inventario/orden-menu";
import { VistaToggle } from "@/components/inventario/vista-toggle";
import { CarritoBoton } from "@/components/inventario/carrito-boton";
import { InventarioPaginador } from "@/components/inventario/inventario-paginador";
import { InventarioCarritoProvider } from "@/components/inventario/inventario-carrito-provider";
import { PresupuestosPanel } from "@/components/inventario/presupuestos-panel";
import { CalculadoraMostradorConCarrito } from "@/components/inventario/calculadora-mostrador";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";
import "@/components/crm.css";
import "@/components/clientes/clientes.css";
import "@/components/inventario/inventario.css";
import "@/components/inventario/mostrador.css";

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
  "sin-foto": {
    title: "Todos los repuestos tienen foto",
    hint: "Carga fotos desde la ficha de cada repuesto.",
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
  /**
   * Lista o cuadrícula (30/10/2026, plan «Cada repuesto con su foto», T5a). La lee
   * `page.tsx` de una cookie en el servidor, así que llega ya resuelta y no hay
   * parpadeo; sin ella la vista inicial es Lista (D4).
   */
  vista?: InventoryView;
}

/**
 * Es un componente de CLIENTE desde el 30/10/2026: guarda qué repuesto tiene la
 * ficha abierta y pide `router.refresh()` cuando algo se guarda en ella. Antes era
 * puro render de servidor. Los datos siguen llegando ya resueltos por props desde
 * `page.tsx`.
 */
export function InventarioView({
  currentAgent,
  products,
  total,
  totals,
  catalog,
  params,
  bcvRate,
  vista = "lista",
}: InventarioViewProps) {
  const router = useRouter();
  // Qué repuesto tiene abierta la ficha. Se guarda el ID y no el producto: tras
  // `router.refresh()` (subir una foto, guardar un peso) llega una lista nueva y la
  // ficha debe mostrar la versión fresca del MISMO repuesto, no la que estaba en
  // memoria al abrirla.
  const [fichaId, setFichaId] = useState<string | null>(null);
  // Abierta o cerrada va APARTE del ID: al cerrar se conserva el repuesto para que el
  // Drawer termine su animación de salida con el contenido puesto, en vez de vaciarse de golpe.
  const [fichaAbierta, setFichaAbierta] = useState(false);
  const productoFicha = fichaId === null ? null : (products.find((p) => p.id === fichaId) ?? null);

  // "Ajustar el estado cuando cambia un prop" (docs de React): si el repuesto
  // abierto ya no está en la página (otro filtro, otra búsqueda, otra página), la
  // ficha se cierra en vez de quedar apuntando a un ID que reaparecería abierta al
  // volver. Se hace durante el render y no en un efecto (`react-hooks/set-state-in-effect`).
  if (fichaId !== null && productoFicha === null) setFichaId(null);

  function abrirFicha(productId: string) {
    setFichaId(productId);
    setFichaAbierta(true);
  }

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

  // Subir, reemplazar, borrar y marcar la foto principal: solo supervisor y admin
  // (D1, 30/10/2026). La barrera real es la RLS de `product_photos`; esto solo evita
  // ofrecer botones que la base rechazaría.
  const puedeEditarFotos = currentAgent.role === "supervisor" || currentAgent.role === "admin";

  // Avance de la carga de fotos para la barra de «Con foto», con una décima de precisión.
  const avanceFotos =
    totals.productos > 0 ? Math.min(100, Math.round((totals.conFoto / totals.productos) * 1000) / 10) : 0;

  const empty = params.query
    ? {
        title: "Ningún repuesto coincide con esa búsqueda",
        hint: "Si el cliente lo pide con otro nombre, revisa los sinónimos del catálogo de motos.",
      }
    : EMPTY_BY_FILTER[params.filter];

  // El provider no agrega DOM y envuelve `.dash` por FUERA: `.dash-frame` es un
  // grid de dos columnas y un hijo de más le desarma la pantalla (trampa del
  // 9/9/2026). El panel del carrito y la ficha salen por el portal del Drawer.
  return (
    <InventarioCarritoProvider
      agentId={currentAgent.id}
      bcvRate={rate}
      soloLectura={soloLectura}
      role={currentAgent.role}
    >
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
                  {/*
                   * Solo la caja conserva su subtítulo (30/10/2026, decisión del operador): a
                   * ella le explica que esta pantalla es de consulta. Supervisor, admin y
                   * asesor ya saben qué es el inventario, y el párrafo les empujaba las
                   * tarjetas bajo el pliegue.
                   */}
                  {soloLectura && (
                    <p className="dash-subtitle">
                      Esto es exactamente lo que la IA consulta al cotizarle a un cliente. Nombre, precio y existencia
                      llegan de Saint cada minuto: acá es solo consulta de precios, existencia y Cashea.
                    </p>
                  )}
                </div>
              </div>

              <div className="cli-stats inv-stats">
                <div className="cli-stat">
                  <span className="lm-eyebrow">Repuestos</span>
                  <span className="lm-num cli-stat-value">{totals.productos}</span>
                  <span className="cli-stat-note">{totals.activos} visibles para la IA</span>
                </div>
                {/* «Con foto» mide el avance de una carga manual (más de 6.000 repuestos sin foto al
                    arrancar, 30/10/2026): número, total y barra, con un tinte azul que la distingue
                    de las tarjetas de inventario. */}
                <div className="cli-stat" data-nuevo="true">
                  <span className="lm-eyebrow">Con foto</span>
                  <span className="lm-num cli-stat-value">
                    {totals.conFoto}
                    <span className="cli-stat-total">/ {totals.productos}</span>
                  </span>
                  <span className="cli-stat-bar" aria-hidden="true">
                    <span style={{ width: `${avanceFotos}%` }} />
                  </span>
                  <span className="cli-stat-note">Se cargan desde la ficha de cada repuesto.</span>
                </div>
                <div className="cli-stat">
                  <span className="lm-eyebrow">Agotados</span>
                  <span className="lm-num cli-stat-value">{totals.agotados}</span>
                  <span className="cli-stat-note">Activos con stock en cero: la IA los cotiza igual.</span>
                </div>
                <div className="cli-stat">
                  <span className="lm-eyebrow">Bajo stock</span>
                  <span className="lm-num cli-stat-value">{totals.bajos}</span>
                  <span className="cli-stat-note">De 1 a 5 unidades.</span>
                </div>
                <div className="cli-stat">
                  <span className="lm-eyebrow">Sin peso</span>
                  <span className="lm-num cli-stat-value">{totals.withoutWeight}</span>
                  <span className="cli-stat-note">
                    {soloLectura
                      ? "Cashea lo exige para el envío gratis."
                      : "Cashea lo exige para el envío gratis, y sin peso no hay precio estándar."}
                  </span>
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

              {/* Presupuestos guardados y calculadora fija (21/10/2026, "Presupuestos y mensajes
                  rápidos", T5): las dos piezas viven DENTRO de `.dash-content`, nunca como
                  hijo directo de `.dash-frame` (grid de dos columnas, trampa del 9/9/2026).
                  La calculadora comparte grilla con la lista (`.inv-mostrador`) para quedar
                  fija a su lado al bajar. */}
              <PresupuestosPanel agentId={currentAgent.id} role={currentAgent.role} bcvRate={rate} />

              <div className="inv-mostrador">
                {/* `inv-panel-lista` deja aire debajo del paginador para el botón flotante del carrito y
                    declara el container `invpanel` del que dependen las columnas de la lista. */}
                <section className="dash-panel inv-panel-lista">
                  <div className="cli-toolbar">
                    <UrlSearchBox
                      basePath="/inventario"
                      query={params.query}
                      keep={keepInSearch}
                      placeholder="Buscar por nombre, marca o código"
                      label="Buscar en el inventario"
                    />

                    {/* 30/10/2026: una sola caja «Ordenar por» (Mostrar + Ordenar) reemplaza a las
                        dos tiras de píldoras, y el interruptor Lista/Cuadrícula va a su derecha. */}
                    <OrdenMenu params={params} />
                    <VistaToggle vista={vista} />
                  </div>

                  <div className="dash-panel-head">
                    <h2 className="dash-panel-title">
                      {params.query ? `Resultados para «${params.query}»` : INVENTORY_FILTER_LABELS[params.filter]}
                    </h2>
                    <span className="dash-panel-spacer" />
                    {/* «Sin peso» abre por existencia sin que ninguna opción de orden lo diga: la nota lo hace explícito. */}
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
                  ) : vista === "cuadricula" ? (
                    <ul className="inv-grid">
                      {products.map((product) => (
                        <ProductoTarjeta
                          key={product.id}
                          product={product}
                          bcvRate={rate}
                          soloLectura={soloLectura}
                          puedeEditarFotos={puedeEditarFotos}
                          onAbrirFicha={abrirFicha}
                        />
                      ))}
                    </ul>
                  ) : (
                    <>
                      {/* Encabezado único de la lista: HERMANO de la `ul` y no un `li`, para que la lista
                          solo contenga repuestos; decorativo (`aria-hidden`), cada caja ya tiene su aria-label.
                          Mismas columnas que la fila; en la de caja no hay «Estándar». */}
                      <div
                        className="inv-head"
                        aria-hidden="true"
                        data-solo-lectura={soloLectura ? "true" : undefined}
                      >
                        <span>Repuesto</span>
                        <span>Stock</span>
                        <span>Promoción</span>
                        <span>Divisa</span>
                        {!soloLectura && <span>Estándar</span>}
                        <span>Peso (kg)</span>
                        <span />
                      </div>
                      <ul className="inv-list">
                        {products.map((product) => (
                          <ProductoFila
                            key={product.id}
                            product={product}
                            bcvRate={rate}
                            soloLectura={soloLectura}
                            puedeEditarFotos={puedeEditarFotos}
                            onAbrirFicha={abrirFicha}
                          />
                        ))}
                      </ul>
                    </>
                  )}

                  {pages > 1 && <InventarioPaginador params={params} pages={pages} />}
                </section>

                <CalculadoraMostradorConCarrito bcvRate={rate} agentId={currentAgent.id} />
              </div>

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

            {/* UNA sola ficha para toda la lista y la cuadrícula (30/10/2026). Es un Drawer: sale por
                portal, así que tampoco suma un hijo al grid de `.dash-frame`. `onCambio` vuelve a pedir
                la página al servidor para que la lista muestre la foto recién subida. */}
            <ProductoFicha
              product={productoFicha}
              bcvRate={rate}
              soloLectura={soloLectura}
              puedeEditarFotos={puedeEditarFotos}
              isOpen={fichaAbierta && productoFicha !== null}
              onOpenChange={setFichaAbierta}
              onCambio={() => router.refresh()}
            />
          </main>
        </div>
      </div>
    </InventarioCarritoProvider>
  );
}
