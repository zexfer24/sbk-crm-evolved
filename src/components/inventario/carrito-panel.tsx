"use client";

import { useState } from "react";
import { ChevronDown, Copy, Save, Trash2 } from "lucide-react";
import { Drawer, toast } from "@heroui/react";
import type { AgentRole } from "@/lib/types";
import type { PricedCartLine } from "@/lib/conversation-cart";
import { formatBs, formatUsd, toCents } from "@/lib/cashea";
import {
  avisosRenglon,
  textoCarritoParaCliente,
  totalesCarrito,
  type LineaCarritoInventario,
} from "@/lib/inventario-carrito";
import { guardarPresupuesto } from "@/lib/presupuestos-data";
import { nombreCompletoPresupuesto, puedeEditarPresupuesto, renglonesParaGuardar } from "@/lib/presupuestos";
import type { DatosClienteSaint } from "@/lib/saint-borradores";
import { createClient } from "@/lib/supabase/client";
import { CasheaControles } from "@/components/cashea/cashea-controles";
import { CasheaResumen } from "@/components/cashea/cashea-resumen";
import { useInventarioCarrito } from "@/components/inventario/inventario-carrito-context";
import { GuardarPresupuestoModal, type DatosPresupuestoForm } from "@/components/presupuestos/guardar-presupuesto-modal";
import { OpcionesCopiaCasillas } from "@/components/presupuestos/opciones-copia";
import { useOpcionesCopia } from "@/components/presupuestos/use-opciones-copia";
import { EnviarASaint } from "@/components/saint/enviar-a-saint";
import { useBorradoresSaint } from "@/components/saint/use-borradores-saint";
import "@/components/agent-control/agent-control.css";
import "@/components/inventario/inventario.css";

/**
 * Panel lateral del carrito de cotización del Inventario (12/10/2026, plan
 * "Carrito de cotización en el Inventario, con Cashea", T4).
 *
 * Presentacional sobre el contexto: todo número sale de `totalesCarrito` y de
 * los formateadores es-VE de `cashea.ts`; aquí no se calcula ni se redondea
 * nada. El bloque de totales va en el pie del Drawer para que se vea siempre,
 * sin importar cuánto crezca la lista; el cuerpo es lo único que desplaza.
 *
 * Es un `Drawer` de HeroUI (placement derecha): corre en jsdom, así que el
 * test lo ejerce de verdad y no hizo falta caer al `Modal`.
 *
 * 21/10/2026 ("Presupuestos y mensajes rápidos", T4): el panel gana tres
 * cosas. (1) El interruptor «Cobrar precio estándar (envío por peso)», que
 * pasa TODO el carrito al estándar: antes cobraba siempre la promoción y el
 * envío por peso había que sumarlo a mano. No existe para la caja. (2) Las
 * casillas de «qué incluir al copiar» con una vista previa del texto exacto
 * que se copia; si un renglón no tiene precio, la vista previa se cambia por
 * el motivo y Copiar queda deshabilitado (D5: nunca se mezcla un precio sin
 * envío). (3) «Guardar presupuesto», que guarda el carrito con el nombre y el
 * apellido del cliente, como nuevo o como cambios al presupuesto abierto.
 *
 * 28/10/2026 (plan "El carrito de cotización se ordena", T3): el panel se
 * reordena. El cuerpo lleva SOLO los artículos (con scroll visible: cuando el
 * interruptor de estándar, Cashea y las casillas de copia vivían ahí arriba, la
 * lista quedaba aplastada y el último renglón costaba alcanzarlo). El pie, que
 * no se desplaza, lleva en orden el desplegable «Opciones de cotización»
 * (estándar, Cashea y qué incluir al copiar; arranca cerrado y, cerrado, marca
 * con una etiqueta lo que está encendido), los totales y los botones: Enviar a
 * SAINT, Guardar presupuesto, Copiar y Vaciar. La caja ve en el desplegable solo
 * Cashea y no tiene Copiar (no ve casillas ni vista previa). «Enviar a SAINT» no
 * puede mandar el carrito tal cual —no existe en la base y la RPC solo acepta
 * presupuestos—, así que antes de enviar lo GUARDA como presupuesto (cambios al
 * abierto si el asesor puede editarlo, uno nuevo si no) con el nombre y apellido
 * del formulario de SAINT, y envía ese presupuesto (`prepararOrigen`). SAINT
 * pone su propio precio: con estándar en el carrito una nota avisa que el envío
 * por peso no viaja.
 */

const SIN_MONTO = "—";

function usdOSinPrecio(usd: number | null): string {
  return usd === null ? SIN_MONTO : formatUsd(toCents(usd));
}

function bsOSinPrecio(bs: number | null): string {
  return bs === null ? SIN_MONTO : formatBs(bs);
}

/**
 * Cantidad editable. Guarda el borrador localmente y cambia el carrito al
 * SALIR del campo (o con Enter), no en cada tecla: así escribir "12" no pasa
 * por un 1 intermedio que recalcule todo. Inválido (vacío, 0, decimal) revierte.
 * El padre lo remonta con `key` cuando la cantidad cambia desde otro lado.
 */
function CampoCantidad({
  nombre,
  cantidad,
  onCambiar,
}: {
  nombre: string;
  cantidad: number;
  onCambiar: (cantidad: number) => void;
}) {
  const [borrador, setBorrador] = useState(String(cantidad));

  function confirmar() {
    const n = Number(borrador.replace(/\D/g, ""));
    if (!Number.isInteger(n) || n < 1) {
      setBorrador(String(cantidad));
      return;
    }
    setBorrador(String(n));
    if (n !== cantidad) onCambiar(n);
  }

  return (
    <input
      className="inv-carrito-cantidad lm-num"
      value={borrador}
      onChange={(event) => setBorrador(event.target.value)}
      onBlur={confirmar}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      inputMode="numeric"
      aria-label={`Cantidad de ${nombre}`}
    />
  );
}

function Renglon({
  linea,
  onCantidad,
  onQuitar,
}: {
  linea: PricedCartLine<LineaCarritoInventario>;
  onCantidad: (cantidad: number) => void;
  onQuitar: () => void;
}) {
  const { product, quantity } = linea.item;
  const avisos = avisosRenglon(linea);

  return (
    <li className="inv-carrito-renglon">
      <div className="inv-carrito-renglon-cabeza">
        <div className="inv-carrito-renglon-id">
          <span className="inv-carrito-nombre">{product.name}</span>
          <span className="inv-carrito-codigo lm-num">
            {product.saintCode ?? "Sin código"}
            {linea.item.priceKind === "estandar" && <span className="inv-carrito-marca">Estándar</span>}
          </span>
        </div>
        <button
          type="button"
          className="inv-carrito-quitar"
          onClick={onQuitar}
          aria-label={`Quitar ${product.name}`}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="inv-carrito-renglon-cuerpo">
        <CampoCantidad
          key={`${product.id}-${quantity}`}
          nombre={product.name}
          cantidad={quantity}
          onCambiar={onCantidad}
        />
        <span className="inv-carrito-unitario lm-num">
          c/u {bsOSinPrecio(linea.unitPriceBs)} · {usdOSinPrecio(linea.unitPriceUsd)}
        </span>
        <span className="inv-carrito-subtotal lm-num">
          <span>{bsOSinPrecio(linea.subtotalBs)}</span>
          <span>{usdOSinPrecio(linea.subtotalUsd)}</span>
        </span>
      </div>

      {avisos.length > 0 && (
        <div className="inv-carrito-avisos">
          {avisos.map((aviso) => (
            <span key={aviso} className="ac-badge" data-tone="wait">
              {aviso}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

export function CarritoPanel({
  bcvRate,
  agentId,
  role,
}: {
  bcvRate: number;
  agentId: string;
  role: AgentRole;
}) {
  const carrito = useInventarioCarrito();
  const [confirmandoVaciar, setConfirmandoVaciar] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [opcionesCopia, setOpcionesCopia] = useOpcionesCopia(agentId);
  const [opcionesAbiertas, setOpcionesAbiertas] = useState(false);
  // Antes del `return null` de abajo (reglas de los hooks): fuera del provider no hay presupuesto que mirar.
  const presupuestoParaSaint = carrito?.presupuestoActivo ?? null;
  const { porOrigen: envios, ahora, recargar: recargarEnvios } = useBorradoresSaint(
    "presupuesto",
    presupuestoParaSaint ? [presupuestoParaSaint.id] : [],
  );

  // Fuera del provider no hay carrito que mostrar.
  if (!carrito) return null;

  const { lineas, abierto, cerrar, cashea, setCashea, presupuestoActivo, priceKind } = carrito;
  const totales = totalesCarrito(lineas, bcvRate, cashea);
  const texto = textoCarritoParaCliente(totales, opcionesCopia);
  const vacio = lineas.length === 0;
  const estandarEncendido = priceKind === "estandar";
  const hayEstandar = priceKind === "estandar" || priceKind === "mixto";
  const esCaja = role === "caja";
  const puedeGuardarCambios =
    presupuestoActivo !== null && puedeEditarPresupuesto(presupuestoActivo, { id: agentId, role });

  async function copiar() {
    if (texto === null) return;
    try {
      await navigator.clipboard.writeText(texto);
      toast.success("Carrito copiado");
    } catch {
      toast.danger("No se pudo copiar");
    }
  }

  /**
   * Guarda el carrito como presupuesto (cambios al abierto si `reemplaza`, uno
   * nuevo si no), lo deja como el activo del carrito y devuelve su id. Lo usan
   * el modal «Guardar presupuesto» y «Enviar a SAINT», que antes de enviar
   * necesita que el carrito exista en la base.
   */
  async function guardarCarrito(
    datos: { nombre: string; apellido: string; nota: string | null },
    reemplaza: boolean,
  ): Promise<string> {
    if (!carrito) throw new Error("No hay carrito que guardar.");
    const base = reemplaza ? presupuestoActivo : null;
    const id = await guardarPresupuesto(createClient(), {
      id: base ? base.id : null,
      clienteNombre: datos.nombre,
      clienteApellido: datos.apellido,
      contactId: null,
      conversationId: null,
      origen: "inventario",
      nota: datos.nota || null,
      items: renglonesParaGuardar(totales.lineas),
    });
    carrito.marcarPresupuestoGuardado({
      id,
      clienteNombre: datos.nombre,
      clienteApellido: datos.apellido,
      nota: datos.nota || null,
      // Un supervisor que cambia un presupuesto ajeno no se lo apropia.
      createdBy: base ? base.createdBy : agentId,
    });
    return id;
  }

  async function guardar(datos: DatosPresupuestoForm, modo: "cambios" | "nuevo") {
    await guardarCarrito(datos, modo === "cambios" && presupuestoActivo !== null);
    toast.success(
      `Presupuesto de ${nombreCompletoPresupuesto({ clienteNombre: datos.nombre, clienteApellido: datos.apellido })} guardado`,
    );
  }

  /** «Enviar a SAINT»: el modal de SAINT ya avisa el éxito o el error, así que no hay toast propio. */
  function prepararParaSaint(datos: DatosClienteSaint): Promise<string> {
    return guardarCarrito(
      {
        nombre: datos.nombre.trim(),
        apellido: datos.apellido.trim(),
        nota: puedeGuardarCambios && presupuestoActivo ? presupuestoActivo.nota : null,
      },
      puedeGuardarCambios,
    );
  }

  return (
    <Drawer.Root
      isOpen={abierto}
      onOpenChange={(open) => {
        if (!open) {
          setConfirmandoVaciar(false);
          cerrar();
        } else {
          carrito.abrir();
        }
      }}
    >
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="inv-carrito-dialogo">
            <Drawer.Header className="inv-carrito-cabecera">
              <div className="inv-carrito-titulo">
                <Drawer.Heading>Carrito de cotización</Drawer.Heading>
                {presupuestoActivo && (
                  <div className="inv-carrito-activo">
                    <span className="inv-carrito-chip">{nombreCompletoPresupuesto(presupuestoActivo)}</span>
                    <span className="inv-carrito-activo-nota">
                      Presupuesto guardado · los cambios no se guardan solos
                    </span>
                  </div>
                )}
              </div>
              <Drawer.CloseTrigger aria-label="Cerrar" />
            </Drawer.Header>

            <Drawer.Body className="inv-carrito-cuerpo">
              {vacio ? (
                <p className="inv-carrito-vacio">Agregá repuestos desde la lista con «Agregar».</p>
              ) : (
                <ul className="inv-carrito-lista" aria-label="Productos del carrito">
                  {totales.lineas.map((linea) => (
                    <Renglon
                      key={linea.item.product.id}
                      linea={linea}
                      onCantidad={(cantidad) => carrito.cambiarCantidad(linea.item.product.id, cantidad)}
                      onQuitar={() => carrito.quitar(linea.item.product.id)}
                    />
                  ))}
                </ul>
              )}
            </Drawer.Body>

            {!vacio && (
              <Drawer.Footer className="inv-carrito-pie">
                <div className="inv-carrito-pie-ajustes">
                  <div className="inv-carrito-opciones">
                    <button
                      type="button"
                      className="inv-carrito-opciones-boton"
                      aria-expanded={opcionesAbiertas}
                      aria-controls="carrito-inv-opciones"
                      data-abierto={opcionesAbiertas}
                      onClick={() => setOpcionesAbiertas(!opcionesAbiertas)}
                    >
                      <span>Opciones de cotización</span>
                      {!opcionesAbiertas && hayEstandar && !esCaja && <span className="inv-carrito-marca">Estándar</span>}
                      {!opcionesAbiertas && cashea.activo && <span className="inv-carrito-marca">Cashea</span>}
                      <ChevronDown size={14} className="inv-carrito-opciones-chevron" aria-hidden="true" />
                    </button>

                    {opcionesAbiertas && (
                      <div id="carrito-inv-opciones" className="inv-carrito-opciones-cuerpo">
                        {carrito.puedeCobrarEstandar && (
                          <div className="inv-carrito-estandar">
                            <div className="inv-carrito-cashea-cabeza">
                              <span>Cobrar precio estándar (envío por peso)</span>
                              <button
                                type="button"
                                role="switch"
                                className="ac-switch"
                                aria-checked={estandarEncendido}
                                aria-label="Cobrar precio estándar (envío por peso)"
                                data-on={estandarEncendido}
                                onClick={() => carrito.setCobrarEstandar(!estandarEncendido)}
                              />
                            </div>
                            {priceKind === "mixto" && (
                              <p className="inv-carrito-nota">Algunos renglones van con estándar</p>
                            )}
                          </div>
                        )}

                        <div className="inv-carrito-cashea">
                          <div className="inv-carrito-cashea-cabeza">
                            <span>Financiar con Cashea</span>
                            <button
                              type="button"
                              role="switch"
                              className="ac-switch"
                              aria-checked={cashea.activo}
                              aria-label="Financiar con Cashea"
                              data-on={cashea.activo}
                              onClick={() => setCashea({ ...cashea, activo: !cashea.activo })}
                            />
                          </div>
                          {cashea.activo &&
                            (totales.unpricedCount > 0 ? (
                              <p className="inv-carrito-nota" role="status">
                                Falta la tasa BCV para un producto: no se puede financiar un total incompleto.
                              </p>
                            ) : (
                              <CasheaControles
                                montoCents={toCents(totales.usd)}
                                eleccion={cashea}
                                onChange={(eleccion) => setCashea({ ...cashea, ...eleccion })}
                              />
                            ))}
                        </div>

                        {!esCaja && (
                          <div className="inv-carrito-copia">
                            <OpcionesCopiaCasillas
                              opciones={opcionesCopia}
                              onChange={setOpcionesCopia}
                              mostrarCashea={true}
                              idPrefix="carrito-inv-copia"
                            />
                            {texto === null ? (
                              <p className="inv-carrito-nota" role="status">
                                Completa el precio de los renglones marcados para copiar.
                              </p>
                            ) : (
                              <pre className="inv-carrito-previa" aria-label="Vista previa del texto">
                                {texto}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="inv-carrito-totales" aria-label="Totales" role="group">
                    <div className="inv-carrito-total-fila">
                      <span>Total en bolívares</span>
                      <span className="lm-num">{totales.bs === null ? "Sin tasa" : formatBs(totales.bs)}</span>
                    </div>
                    <div className="inv-carrito-total-fila">
                      <span>Total en dólares</span>
                      <span className="lm-num">
                        {totales.unpricedCount > 0 ? "Sin tasa" : formatUsd(toCents(totales.usd))}
                      </span>
                    </div>
                    {totales.cashea && <CasheaResumen plan={totales.cashea} bcvRate={bcvRate} notaCadencia />}
                  </div>
                </div>

                <div className="inv-carrito-acciones">
                  <EnviarASaint
                    origen="presupuesto"
                    origenId={presupuestoActivo?.id ?? ""}
                    productos={lineas.map((l) => l.product)}
                    inicial={{
                      cedulaTipo: "",
                      cedulaNumero: "",
                      nombre: presupuestoActivo?.clienteNombre ?? "",
                      apellido: presupuestoActivo?.clienteApellido ?? "",
                      telefono: "",
                    }}
                    ultimo={envios.get(presupuestoActivo?.id ?? "") ?? null}
                    ahora={ahora}
                    onEnviado={recargarEnvios}
                    prepararOrigen={prepararParaSaint}
                  />
                  {hayEstandar && (
                    <p className="inv-carrito-nota">SAINT pone su propio precio: el envío por peso no viaja.</p>
                  )}
                  <div className="inv-carrito-acciones-fila">
                    <button type="button" className="crm-pill" onClick={() => setGuardando(true)} disabled={vacio}>
                      <Save size={13} aria-hidden="true" />
                      Guardar presupuesto
                    </button>
                    {!esCaja && (
                      <button
                        type="button"
                        className="crm-pill"
                        onClick={() => void copiar()}
                        disabled={texto === null}
                      >
                        <Copy size={13} aria-hidden="true" />
                        Copiar
                      </button>
                    )}
                    {confirmandoVaciar ? (
                      <span className="inv-carrito-confirmar">
                        <span>¿Vaciar el carrito?</span>
                        <button
                          type="button"
                          className="crm-pill"
                          onClick={() => {
                            carrito.vaciar();
                            setConfirmandoVaciar(false);
                          }}
                        >
                          Sí, vaciar
                        </button>
                        <button type="button" className="crm-pill" onClick={() => setConfirmandoVaciar(false)}>
                          No
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="crm-pill" onClick={() => setConfirmandoVaciar(true)}>
                        Vaciar
                      </button>
                    )}
                  </div>
                </div>
              </Drawer.Footer>
            )}

            {/* Dentro del diálogo y no al lado: así el modal es un overlay hijo del panel y no le cierra el panel al hacer clic. */}
            <GuardarPresupuestoModal
              isOpen={guardando}
              onOpenChange={setGuardando}
              inicial={
                presupuestoActivo
                  ? {
                      nombre: presupuestoActivo.clienteNombre,
                      apellido: presupuestoActivo.clienteApellido,
                      nota: presupuestoActivo.nota ?? "",
                    }
                  : { nombre: "", apellido: "", nota: "" }
              }
              puedeGuardarCambios={puedeGuardarCambios}
              onGuardar={guardar}
            />
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>
  );
}
