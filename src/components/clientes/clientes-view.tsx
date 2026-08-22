import Link from "next/link";
import { IdCard, MapPin, MessageCircle, Users } from "lucide-react";
import type { Agent, CustomerSummary } from "@/lib/types";
import {
  CUSTOMER_FILTER_LABELS,
  CUSTOMER_SORT_LABELS,
  CUSTOMERS_PAGE_SIZE,
  customerLocation,
  customerName,
  customersHref,
  formatCedula,
  isProfileIncomplete,
  totalPages,
  type CustomerFilter,
  type CustomerParams,
  type CustomerSort,
} from "@/lib/customers";
import { initials } from "@/lib/dashboard";
import { formatConversationTimestamp } from "@/lib/format";
import { AppRail, AppTopNav } from "@/components/app-rail";
import { UrlSearchBox } from "@/components/url-search-box";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";
import "@/components/crm.css";
import "@/components/clientes/clientes.css";

const FILTERS: CustomerFilter[] = ["todos", "compradores", "sin-compras", "datos-incompletos"];
const SORTS: CustomerSort[] = ["recientes", "nombre"];

/**
 * Qué decir cuando no hay nada que mostrar. Depende del corte: bajo el
 * filtro «Compradores», "todavía no hay clientes" sería falso y confuso —
 * hay clientes, lo que no hay es ventas cerradas.
 */
const EMPTY_BY_FILTER: Record<CustomerFilter, { title: string; hint: string }> = {
  todos: {
    title: "Todavía no hay clientes acá",
    hint: "Cada número nuevo que escriba por WhatsApp aparece en esta lista.",
  },
  compradores: {
    title: "Ningún cliente ha comprado todavía",
    hint: "Un cliente entra acá al cerrarle una venta desde el chat. Las devueltas y las eliminadas no cuentan.",
  },
  "sin-compras": {
    title: "Todos los clientes ya compraron",
    hint: "No queda nadie sin al menos una venta cerrada.",
  },
  "datos-incompletos": {
    title: "Ningún cliente tiene datos pendientes",
    hint: "Todos tienen cédula y dirección cargadas.",
  },
};

interface ClientesViewProps {
  currentAgent: Agent;
  customers: CustomerSummary[];
  total: number;
  params: CustomerParams;
}

/**
 * Vista de la lista. Es un componente de servidor a propósito: no tiene
 * estado propio, todo lo que la configura viene de la URL. Solo el buscador
 * es una isla de cliente.
 */
export function ClientesView({ currentAgent, customers, total, params }: ClientesViewProps) {
  const pages = totalPages(total);
  const desde = total === 0 ? 0 : (params.page - 1) * CUSTOMERS_PAGE_SIZE + 1;
  const hasta = Math.min(params.page * CUSTOMERS_PAGE_SIZE, total);

  // Al buscar se conservan el filtro y el orden, pero no la página. Se
  // pasan ya depurados porque el cuadro de búsqueda es genérico y no sabe
  // cuáles son los valores por defecto de esta lista.
  const keepInSearch: Record<string, string> = {
    ...(params.filter !== "todos" ? { filtro: params.filter } : {}),
    ...(params.sort !== "recientes" ? { orden: params.sort } : {}),
  };

  // Una búsqueda sin resultados habla de la búsqueda, no del filtro.
  const empty = params.query
    ? {
        title: "Ningún cliente coincide con esa búsqueda",
        hint: "Prueba con parte del nombre, del teléfono o de la cédula.",
      }
    : EMPTY_BY_FILTER[params.filter];

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="clientes" />

        <main className="dash-main">
          <div className="dash-content">
            <header className="dash-topbar">
              <p className="dash-brand">
                <span className="dash-brand-mark" aria-hidden="true">
                  <Users size={14} />
                </span>
                <span className="dash-brand-name">Liminal</span>
              </p>

              <AppTopNav active="clientes" />

              <div className="dash-topbar-actions">
                <span className="dash-icon-btn dash-icon-static" title={currentAgent.displayName}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{initials(currentAgent.displayName)}</span>
                </span>
              </div>
            </header>

            <div className="dash-header">
              <div>
                <h1 className="dash-title dash-display">Clientes</h1>
                <p className="dash-subtitle">
                  Todo lo que se sabe de cada persona que ha escrito: sus datos, sus etiquetas y lo que ha comprado.
                </p>
              </div>
            </div>

            <section className="dash-panel">
              <div className="cli-toolbar">
                <UrlSearchBox
                  basePath="/clientes"
                  query={params.query}
                  keep={keepInSearch}
                  placeholder="Buscar por nombre, teléfono o cédula"
                  label="Buscar clientes"
                />

                <div className="cli-filters" role="group" aria-label="Filtrar clientes">
                  {FILTERS.map((filter) => (
                    <Link
                      key={filter}
                      className="crm-pill"
                      href={customersHref({ ...params, filter, page: 1 })}
                      {...(params.filter === filter ? { "data-active": "true", "aria-current": "true" as const } : {})}
                    >
                      {CUSTOMER_FILTER_LABELS[filter]}
                    </Link>
                  ))}
                </div>

                <div className="cli-filters" role="group" aria-label="Ordenar clientes">
                  {SORTS.map((sort) => (
                    <Link
                      key={sort}
                      className="crm-pill"
                      href={customersHref({ ...params, sort, page: 1 })}
                      {...(params.sort === sort ? { "data-active": "true", "aria-current": "true" as const } : {})}
                    >
                      {CUSTOMER_SORT_LABELS[sort]}
                    </Link>
                  ))}
                </div>
              </div>

              <div className="dash-panel-head">
                <h2 className="dash-panel-title">
                  {params.query ? `Resultados para «${params.query}»` : CUSTOMER_FILTER_LABELS[params.filter]}
                </h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">
                  {total === 0 ? "Sin resultados" : `${desde}–${hasta} de ${total}`}
                </span>
              </div>

              {customers.length === 0 ? (
                <div className="dash-empty">
                  <p className="dash-empty-title">{empty.title}</p>
                  <p className="dash-empty-hint">{empty.hint}</p>
                </div>
              ) : (
                <ul className="cli-list">
                  {customers.map(({ contact, activity }) => {
                    const nombre = customerName(contact);
                    const cedula = formatCedula(contact);
                    const ubicacion = customerLocation(contact);
                    const incompleto = isProfileIncomplete(contact);

                    return (
                      <li className="cli-row" key={contact.id}>
                        <Link className="cli-row-main" href={`/clientes/${contact.id}`}>
                          <span className="cli-avatar" aria-hidden="true">
                            {initials(nombre)}
                          </span>

                          <span className="cli-identity">
                            <span className="cli-name">{nombre}</span>
                            <span className="cli-facts">
                              <span className="lm-num">{contact.phoneNumber}</span>
                              {cedula && (
                                <span className="cli-fact">
                                  <IdCard size={12} />
                                  <span className="lm-num">{cedula}</span>
                                </span>
                              )}
                              {ubicacion && (
                                <span className="cli-fact">
                                  <MapPin size={12} />
                                  {ubicacion}
                                </span>
                              )}
                            </span>
                          </span>
                        </Link>

                        <div className="cli-tags">
                          {contact.tags.slice(0, 3).map((tag) => (
                            <span className="crm-tag" key={tag.id} data-color={tag.color}>
                              {tag.label}
                            </span>
                          ))}
                          {contact.tags.length > 3 && (
                            <span className="cli-tags-more">+{contact.tags.length - 3}</span>
                          )}
                          {incompleto && (
                            <span className="ac-badge" data-tone="wait" title="Le falta cédula o dirección">
                              Datos incompletos
                            </span>
                          )}
                        </div>

                        <div className="cli-money">
                          {activity.purchaseCount > 0 ? (
                            <>
                              <span className="lm-num cli-amount">${activity.totalSpentUsd.toFixed(2)}</span>
                              <span className="cli-money-note">
                                {activity.purchaseCount === 1 ? "1 compra" : `${activity.purchaseCount} compras`}
                                {activity.hasNonUsdPurchases && " · hay compras en Bs"}
                              </span>
                            </>
                          ) : (
                            <span className="cli-money-note">Sin compras</span>
                          )}
                        </div>

                        <div className="cli-row-actions">
                          <span className="cli-last">
                            {activity.lastMessageAt
                              ? formatConversationTimestamp(activity.lastMessageAt)
                              : "Sin mensajes"}
                          </span>
                          {activity.latestConversationId && (
                            <Link
                              className="crm-pill"
                              href={`/inbox?conversation=${activity.latestConversationId}`}
                              aria-label={`Abrir el chat de ${nombre}`}
                            >
                              <MessageCircle size={13} />
                              Chat
                            </Link>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {pages > 1 && (
                <nav className="cli-pager" aria-label="Paginación de clientes">
                  <Link
                    className="crm-pill"
                    href={customersHref({ ...params, page: Math.max(1, params.page - 1) })}
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
                    href={customersHref({ ...params, page: Math.min(pages, params.page + 1) })}
                    aria-disabled={params.page === pages}
                    {...(params.page === pages ? { "data-disabled": "true" } : {})}
                  >
                    Siguiente
                  </Link>
                </nav>
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
