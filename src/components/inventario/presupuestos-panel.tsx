"use client";

import { useEffect, useState } from "react";
import { toast } from "@heroui/react";
import { ELECCION_CASHEA_INICIAL } from "@/lib/cashea";
import { configErrorMessage } from "@/lib/config-write";
import { precioDelCarrito, textoCarritoParaCliente, totalesCarrito } from "@/lib/inventario-carrito";
import {
  comparacionTotal,
  etiquetaComparacion,
  filtrarPresupuestos,
  lineasDePresupuesto,
  nombreCompletoPresupuesto,
  puedeEditarPresupuesto,
  type Presupuesto,
} from "@/lib/presupuestos";
import { borrarMisPresupuestos, borrarPresupuesto, fetchPresupuestos } from "@/lib/presupuestos-data";
import { createClient } from "@/lib/supabase/client";
import { CRM_TIME_ZONE } from "@/lib/time-zone";
import type { AgentRole } from "@/lib/types";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useInventarioCarrito } from "@/components/inventario/inventario-carrito-context";
import { useOpcionesCopia } from "@/components/presupuestos/use-opciones-copia";
import "./mostrador.css";

/**
 * «Presupuestos guardados» de /inventario (21/10/2026, plan "Presupuestos y
 * mensajes rápidos", T5): la lista de los presupuestos que el equipo guardó
 * desde el carrito, con buscador por cliente, «Míos» / «De todo el equipo»
 * (D2: se ve todo, la lista abre en los propios), abrir uno en el carrito,
 * copiarlo, borrarlo y «Borrar mis presupuestos» (D3: solo los de quien pulsa).
 *
 * D1: al reabrir se cobra el precio de HOY. El total de cada tarjeta se
 * recalcula con la tasa y los precios actuales; si difiere de lo cotizado se
 * muestra «cotizado $X» al lado, nunca se cobra ese número.
 *
 * Corre en el navegador: los errores van a un toast (`configErrorMessage`) y a
 * `console.error`, nunca a `lib/log.ts`. La barrera real de los permisos es la
 * RLS de `presupuestos`; aquí solo se esconde el botón «Borrar» que no
 * corresponde.
 */

/** Tope de tarjetas pintadas: el buscador filtra sobre todas, pero 50 bastan para scrollear. */
const MAX_VISIBLES = 50;

type Vista = "mios" | "equipo";

const ETIQUETA_PRECIO = { promocion: "promoción", estandar: "estándar", mixto: "mixto" } as const;

/** Sin Cashea: los presupuestos se copian y se totalizan solo en dólares y bolívares. */
const CASHEA_APAGADO = { activo: false, ...ELECCION_CASHEA_INICIAL };

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString("es-VE", { day: "numeric", month: "short", timeZone: CRM_TIME_ZONE });
}

interface PresupuestosPanelProps {
  agentId: string;
  role: AgentRole;
  bcvRate: number;
}

export function PresupuestosPanel({ agentId, role, bcvRate }: PresupuestosPanelProps) {
  const carrito = useInventarioCarrito();
  const [opcionesCopia] = useOpcionesCopia(agentId);

  const [lista, setLista] = useState<Presupuesto[] | null>(null);
  const [fallo, setFallo] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [vista, setVista] = useState<Vista>("mios");
  const [texto, setTexto] = useState("");

  const [aReemplazar, setAReemplazar] = useState<Presupuesto | null>(null);
  const [aBorrar, setABorrar] = useState<Presupuesto | null>(null);
  const [borrandoMios, setBorrandoMios] = useState(false);

  // Guardar un presupuesto desde el carrito cambia el activo: se recarga para que aparezca en la lista.
  const activoId = carrito?.presupuestoActivo?.id ?? null;

  // Efecto inline con `.then()`/`.catch()` y bandera `cancelado`: llamar a un
  // `useCallback` que hace `setState` desde el efecto dispara
  // `react-hooks/set-state-in-effect` aunque el `setState` viva tras un `await`.
  useEffect(() => {
    let cancelado = false;
    fetchPresupuestos(createClient())
      .then((filas) => {
        if (cancelado) return;
        setLista(filas);
        setFallo(false);
      })
      .catch((error) => {
        console.error("No se pudieron cargar los presupuestos guardados", error);
        if (!cancelado) setFallo(true);
      });
    return () => {
      cancelado = true;
    };
  }, [recarga, activoId]);

  function reintentar() {
    setFallo(false);
    setLista(null);
    setRecarga((n) => n + 1);
  }

  const todos = lista ?? [];
  const propios = todos.filter((p) => p.createdBy === agentId);
  const visibles = filtrarPresupuestos(todos, { texto, soloDe: vista === "mios" ? agentId : null });

  async function confirmarBorrarUno(p: Presupuesto) {
    try {
      await borrarPresupuesto(createClient(), p.id);
    } catch (error) {
      console.error("No se pudo borrar el presupuesto", error);
      toast.danger(configErrorMessage(error, "No se pudo borrar el presupuesto."));
      throw error;
    }
    // El presupuesto ya no existe en la base: el chip del carrito apuntaría a nada. Los renglones se quedan.
    if (carrito?.presupuestoActivo?.id === p.id) carrito.olvidarPresupuestoActivo();
    toast.success("Presupuesto borrado");
    setRecarga((n) => n + 1);
  }

  async function confirmarBorrarMios() {
    let borrados: number;
    try {
      borrados = await borrarMisPresupuestos(createClient(), agentId);
    } catch (error) {
      console.error("No se pudieron borrar los presupuestos del asesor", error);
      toast.danger(configErrorMessage(error, "No se pudieron borrar tus presupuestos."));
      throw error;
    }
    if (carrito?.presupuestoActivo && carrito.presupuestoActivo.createdBy === agentId) {
      carrito.olvidarPresupuestoActivo();
    }
    toast.success(borrados === 1 ? "Se borró 1 presupuesto" : `Se borraron ${borrados} presupuestos`);
    setRecarga((n) => n + 1);
  }

  function abrirEnElCarrito(p: Presupuesto) {
    if (!carrito) return;
    // `cargarPresupuesto` REEMPLAZA el carrito sin preguntar: la confirmación es de aquí.
    if (carrito.lineas.length > 0) setAReemplazar(p);
    else carrito.cargarPresupuesto(p);
  }

  async function copiar(p: Presupuesto) {
    const copia = textoDeCopia(p);
    if (copia === null) return;
    try {
      await navigator.clipboard.writeText(copia);
      toast.success("Presupuesto copiado");
    } catch {
      toast.danger("No se pudo copiar");
    }
  }

  function textoDeCopia(p: Presupuesto): string | null {
    return textoCarritoParaCliente(totalesCarrito(lineasDePresupuesto(p), bcvRate, CASHEA_APAGADO), opcionesCopia);
  }

  const nPropios = propios.length;
  const esCaja = role === "caja";

  return (
    <section className="dash-panel inv-presupuestos" aria-label="Presupuestos guardados">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Presupuestos guardados</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">
          {lista === null ? "" : lista.length === 1 ? "1 en total" : `${lista.length} en total`}
        </span>
      </div>

      <div className="inv-presupuestos-barra">
        <div className="cli-filters" role="group" aria-label="De quién">
          <button
            type="button"
            className="crm-pill"
            aria-pressed={vista === "mios"}
            data-active={vista === "mios" ? "true" : undefined}
            onClick={() => setVista("mios")}
          >
            Míos
          </button>
          <button
            type="button"
            className="crm-pill"
            aria-pressed={vista === "equipo"}
            data-active={vista === "equipo" ? "true" : undefined}
            onClick={() => setVista("equipo")}
          >
            De todo el equipo
          </button>
        </div>

        <input
          id="presupuestos-buscar"
          className="inv-calc-input inv-presupuestos-buscar"
          type="search"
          aria-label="Buscar por cliente"
          placeholder="Buscar por cliente"
          autoComplete="off"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />

        <button
          type="button"
          className="crm-pill"
          data-variant="danger"
          disabled={nPropios === 0}
          onClick={() => setBorrandoMios(true)}
        >
          {`Borrar mis presupuestos (${nPropios})`}
        </button>
      </div>

      {fallo ? (
        <div className="inv-presupuestos-estado" role="alert">
          <p style={{ margin: "0 0 8px" }}>No se pudieron cargar los presupuestos.</p>
          <button type="button" className="crm-pill" onClick={reintentar}>
            Reintentar
          </button>
        </div>
      ) : lista === null ? (
        <p className="inv-presupuestos-estado" role="status">
          Cargando presupuestos…
        </p>
      ) : visibles.length === 0 ? (
        <p className="inv-presupuestos-estado">
          {texto.trim() !== ""
            ? `Ningún presupuesto coincide con «${texto.trim()}».`
            : lista.length === 0
              ? "Todavía no hay presupuestos guardados. Arma un carrito y pulsa «Guardar presupuesto»."
              : vista === "mios"
                ? "No tienes presupuestos guardados. Los de todo el equipo están en «De todo el equipo»."
                : "No hay presupuestos para mostrar."}
        </p>
      ) : (
        <ul className="inv-presupuestos-lista">
          {visibles.slice(0, MAX_VISIBLES).map((p) => {
            const lineas = lineasDePresupuesto(p);
            const totales = totalesCarrito(lineas, bcvRate, CASHEA_APAGADO);
            const cambio = comparacionTotal(p, bcvRate);
            const tipo = precioDelCarrito(lineas);
            const articulos = totales.unidades === 1 ? "1 artículo" : `${totales.unidades} artículos`;
            // La caja nunca ve el precio estándar (CLAUDE.md, 14/10/2026): tampoco el nombre del tipo.
            const partes = [articulos];
            if (tipo && !esCaja) partes.push(ETIQUETA_PRECIO[tipo]);
            const meta =
              `${partes.join(" · ")} · guardado ${fechaCorta(p.createdAt)} por ${p.creadoPorNombre ?? "—"}` +
              (p.origen === "chat" ? " · desde el chat" : "");

            return (
              <li key={p.id} className="inv-presupuesto">
                <div className="inv-presupuesto-datos">
                  <p className="inv-presupuesto-nombre" style={{ margin: 0 }}>
                    <span>{nombreCompletoPresupuesto(p)}</span>
                    <span className="inv-presupuesto-total lm-num">
                      {totales.unpricedCount > 0 ? "Sin precio" : `$${totales.usd.toFixed(2)}`}
                    </span>
                  </p>
                  <p className="inv-presupuesto-meta">{meta}</p>
                  {p.nota && <p className="inv-presupuesto-nota">{p.nota}</p>}
                  {cambio && <p className="inv-presupuesto-cambio">{etiquetaComparacion(cambio)}</p>}
                </div>

                <div className="inv-presupuesto-acciones">
                  <button type="button" className="crm-pill" disabled={!carrito} onClick={() => abrirEnElCarrito(p)}>
                    Abrir en el carrito
                  </button>
                  <button
                    type="button"
                    className="crm-pill"
                    disabled={textoDeCopia(p) === null}
                    onClick={() => void copiar(p)}
                  >
                    Copiar
                  </button>
                  {puedeEditarPresupuesto(p, { id: agentId, role }) && (
                    <button type="button" className="crm-pill" data-variant="danger" onClick={() => setABorrar(p)}>
                      Borrar
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        isOpen={aReemplazar !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setAReemplazar(null);
        }}
        titulo="¿Reemplazar el carrito actual?"
        descripcion="El carrito tiene artículos. Si abres este presupuesto, se reemplazan por los suyos."
        confirmarEtiqueta="Sí, reemplazar"
        onConfirmar={() => {
          if (aReemplazar && carrito) carrito.cargarPresupuesto(aReemplazar);
        }}
      />

      <ConfirmDialog
        isOpen={aBorrar !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setABorrar(null);
        }}
        titulo={aBorrar ? `¿Borrar el presupuesto de ${nombreCompletoPresupuesto(aBorrar)}?` : ""}
        descripcion="No se puede deshacer."
        confirmarEtiqueta="Sí, borrar"
        peligro
        onConfirmar={() => (aBorrar ? confirmarBorrarUno(aBorrar) : undefined)}
      />

      <ConfirmDialog
        isOpen={borrandoMios}
        onOpenChange={setBorrandoMios}
        titulo={nPropios === 1 ? "¿Borrar tu presupuesto?" : `¿Borrar tus ${nPropios} presupuestos?`}
        descripcion={
          nPropios === 1
            ? "Se borra el que guardaste tú. Los de otros asesores no se tocan. No se puede deshacer."
            : `Se borran los ${nPropios} que guardaste tú. Los de otros asesores no se tocan. No se puede deshacer.`
        }
        confirmarEtiqueta={`Sí, borrar ${nPropios}`}
        peligro
        onConfirmar={confirmarBorrarMios}
      />
    </section>
  );
}
