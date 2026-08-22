import Link from "next/link";
import { ArrowLeft, IdCard, MapPin, MessageCircle, Phone, ShieldCheck, Users } from "lucide-react";
import type { Agent, CustomerDetail, Tag } from "@/lib/types";
import { customerLocation, customerName, formatCedula, isProfileIncomplete } from "@/lib/customers";
import { initials } from "@/lib/dashboard";
import { formatConversationTimestamp, formatFullDateTime } from "@/lib/format";
import { AppRail, AppTopNav } from "@/components/app-rail";
import { ClienteDatosPanel } from "@/components/clientes/cliente-datos-panel";
import { ClienteEtiquetas } from "@/components/clientes/cliente-etiquetas";
import { ClienteNotas } from "@/components/clientes/cliente-notas";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";
import "@/components/crm.css";
import "@/components/clientes/clientes.css";

interface ClienteFichaProps {
  currentAgent: Agent;
  detail: CustomerDetail;
  allTags: Tag[];
}

export function ClienteFicha({ currentAgent, detail, allTags }: ClienteFichaProps) {
  const { contact, activity, purchases, conversations, notes } = detail;
  const nombre = customerName(contact);
  const cedula = formatCedula(contact);
  const ubicacion = customerLocation(contact);
  const incompleto = isProfileIncomplete(contact);

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
                <Link className="cli-back" href="/clientes">
                  <ArrowLeft size={14} />
                  Volver a clientes
                </Link>
                <h1 className="dash-title dash-display">{nombre}</h1>
                <p className="dash-subtitle">
                  <span className="lm-num">{contact.phoneNumber}</span>
                  {incompleto && " · Le faltan datos para despachar un pedido."}
                </p>
              </div>

              {activity.latestConversationId && (
                <Link className="crm-pill" href={`/inbox?conversation=${activity.latestConversationId}`}>
                  <MessageCircle size={13} />
                  Abrir chat
                </Link>
              )}
            </div>

            <div className="cli-stats">
              <div className="cli-stat">
                <span className="lm-eyebrow">Gastado</span>
                <span className="lm-num cli-stat-value">${activity.totalSpentUsd.toFixed(2)}</span>
                {activity.hasNonUsdPurchases && (
                  <span className="cli-stat-note">Hay compras en Bs que no entran en este total.</span>
                )}
              </div>
              <div className="cli-stat">
                <span className="lm-eyebrow">Compras</span>
                <span className="lm-num cli-stat-value">{activity.purchaseCount}</span>
                {activity.lastPurchaseAt && (
                  <span className="cli-stat-note">Última: {formatConversationTimestamp(activity.lastPurchaseAt)}</span>
                )}
              </div>
              <div className="cli-stat">
                <span className="lm-eyebrow">Conversaciones</span>
                <span className="lm-num cli-stat-value">{activity.conversationCount}</span>
                {activity.lastMessageAt && (
                  <span className="cli-stat-note">Último mensaje: {formatConversationTimestamp(activity.lastMessageAt)}</span>
                )}
              </div>
            </div>

            <div className="cli-columns">
              <div className="cli-col">
                <section className="dash-panel">
                  <div className="dash-panel-head">
                    <h2 className="dash-panel-title">Datos del cliente</h2>
                    <span className="dash-panel-spacer" />
                    <ClienteDatosPanel contact={contact} />
                  </div>

                  <div className="cli-facts-block">
                    <p className="crm-context-fact">
                      <Phone size={13} />
                      <span className="lm-num">{contact.phoneNumber}</span>
                    </p>
                    <p className="crm-context-fact">
                      <IdCard size={13} />
                      {cedula ? <span className="lm-num">{cedula}</span> : <span className="cli-missing">Sin cédula</span>}
                    </p>
                    <p className="crm-context-fact">
                      <MapPin size={13} />
                      {contact.address || ubicacion ? (
                        <span>{[contact.address, ubicacion].filter(Boolean).join(" — ")}</span>
                      ) : (
                        <span className="cli-missing">Sin dirección</span>
                      )}
                    </p>
                    {contact.profileName && (
                      <p className="cli-profile-name">
                        Nombre en WhatsApp: <span>{contact.profileName}</span>
                      </p>
                    )}
                  </div>
                </section>

                <section className="dash-panel">
                  <div className="dash-panel-head">
                    <h2 className="dash-panel-title">Etiquetas</h2>
                  </div>
                  <ClienteEtiquetas contact={contact} allTags={allTags} />
                </section>

                <section className="dash-panel">
                  <div className="dash-panel-head">
                    <h2 className="dash-panel-title">Notas internas</h2>
                    <span className="dash-panel-spacer" />
                    <span className="dash-panel-note">{notes.length}</span>
                  </div>
                  <ClienteNotas contactId={contact.id} initialNotes={notes} currentAgent={currentAgent} />
                </section>
              </div>

              <div className="cli-col">
                <section className="dash-panel">
                  <div className="dash-panel-head">
                    <h2 className="dash-panel-title">Compras</h2>
                    <span className="dash-panel-spacer" />
                    <span className="dash-panel-note">{purchases.length}</span>
                  </div>

                  {purchases.length === 0 ? (
                    <div className="dash-empty">
                      <p className="dash-empty-title">Todavía no ha comprado</p>
                      <p className="dash-empty-hint">
                        Las compras aparecen acá cuando se cierra una venta desde el chat. Las devueltas y las
                        eliminadas no cuentan.
                      </p>
                    </div>
                  ) : (
                    <ul className="cli-purchases">
                      {purchases.map((purchase) => (
                        <li className="cli-purchase" key={purchase.orderId}>
                          <div className="cli-purchase-head">
                            <span className="cli-purchase-date">
                              {purchase.purchasedAt ? formatFullDateTime(purchase.purchasedAt) : "Sin fecha"}
                            </span>
                            <span className="dash-panel-spacer" />
                            {purchase.verified && (
                              <span className="ac-badge" data-tone="link">
                                <ShieldCheck size={11} />
                                Verificada
                              </span>
                            )}
                            <span className="lm-num cli-amount">
                              {purchase.currency === "VES" ? "Bs. " : "$"}
                              {purchase.totalAmount.toFixed(2)}
                            </span>
                          </div>

                          <ul className="cli-purchase-items">
                            {purchase.items.map((item, index) => (
                              <li key={`${purchase.orderId}-${index}`}>
                                <span>{item.description}</span>
                                <span className="lm-num">
                                  {item.quantity} × ${item.unitPrice.toFixed(2)}
                                </span>
                              </li>
                            ))}
                            {purchase.items.length === 0 && (
                              <li className="cli-missing">La venta se cerró sin renglones detallados.</li>
                            )}
                          </ul>

                          <Link className="cli-purchase-link" href={`/inbox?conversation=${purchase.conversationId}`}>
                            Ver el chat donde se cerró
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="dash-panel">
                  <div className="dash-panel-head">
                    <h2 className="dash-panel-title">Conversaciones</h2>
                    <span className="dash-panel-spacer" />
                    <span className="dash-panel-note">{conversations.length}</span>
                  </div>

                  {conversations.length === 0 ? (
                    <div className="dash-empty">
                      <p className="dash-empty-title">Sin conversaciones</p>
                      <p className="dash-empty-hint">Este contacto todavía no tiene ningún hilo abierto.</p>
                    </div>
                  ) : (
                    <ul className="cli-threads">
                      {conversations.map((conversation) => (
                        <li key={conversation.id}>
                          <Link href={`/inbox?conversation=${conversation.id}`}>
                            <span className="cli-thread-date">
                              {conversation.lastMessageAt
                                ? formatConversationTimestamp(conversation.lastMessageAt)
                                : "Sin mensajes"}
                            </span>
                            <span className="dash-panel-spacer" />
                            {conversation.dealStatus === "won" && (
                              <span className="ac-badge" data-tone="good">
                                Venta cerrada
                              </span>
                            )}
                            {conversation.dealStatus === "returned" && (
                              <span className="ac-badge" data-tone="hot">
                                Devuelta
                              </span>
                            )}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
