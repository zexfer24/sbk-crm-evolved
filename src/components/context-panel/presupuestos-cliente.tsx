"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ShoppingCart } from "lucide-react";
import { toast } from "@heroui/react";
import { createClient } from "@/lib/supabase/client";
import { addToCart } from "@/lib/mutations";
import { fetchPresupuestos } from "@/lib/presupuestos-data";
import {
  comparacionTotal,
  etiquetaComparacion,
  lineasDePresupuesto,
  nombreCompletoPresupuesto,
  separarNombreContacto,
  type Presupuesto,
} from "@/lib/presupuestos";
import type { CedulaType } from "@/lib/types";
import { ELECCION_CASHEA_INICIAL } from "@/lib/cashea";
import { totalesCarrito } from "@/lib/inventario-carrito";
import { EnviarASaint } from "@/components/saint/enviar-a-saint";
import { useBorradoresSaint } from "@/components/saint/use-borradores-saint";

/**
 * Los presupuestos guardados del contacto del chat, debajo de «Lo que lleva el
 * cliente» (21/10/2026, plan "Presupuestos y mensajes rápidos", T6). Un
 * cliente que vuelve a los tres días pidiendo «lo que me cotizaste» ya no
 * obliga al asesor a rearmar el carrito: despliega la lista y pasa el
 * presupuesto al carrito de la conversación.
 *
 * D1: al pasarlo se cobra el precio de HOY (`addToCart` guarda producto,
 * cantidad y a qué precio se cobra, nunca el monto); el cotizado se muestra
 * solo como referencia («cotizado $X»). Pasar al carrito no envía nada al
 * cliente, así que la ventana de 24 h no aplica. `addToCart` SUMA la cantidad
 * si el producto ya estaba: pasar dos veces el mismo presupuesto la duplica.
 *
 * Sin Realtime a propósito: la lista se relee al montar, al cambiar de
 * contacto y cuando el bloque guarda uno nuevo (`recargarClave`). Sin
 * presupuestos no pinta nada, ni el título.
 *
 * 25/10/2026 (plan "Enviar a SAINT", T3): cada presupuesto lleva su «Enviar a
 * SAINT» con el estado del último envío. Ese estado SÍ es en vivo (Realtime
 * por `useBorradoresSaint`, origen `presupuesto`): lo cambia un agente externo
 * y nadie más avisa. Cédula y teléfono vienen del contacto del chat; nombre y
 * apellido, del presupuesto.
 */

interface PresupuestosClienteProps {
  contactId: string;
  conversationId: string;
  bcvRate: number;
  /** Nombre del contacto del chat: el botón dice «N guardados de María». */
  contactDisplayName: string | null;
  /** Datos del contacto del chat: precargan el modal de «Enviar a SAINT». */
  contactPhone: string;
  contactCedulaType: CedulaType | null;
  contactCedulaNumber: string | null;
  /** Pide a `crm-shell.tsx` releer el carrito (tras escribir en él). */
  onCartChanged: () => void;
  /** El bloque la incrementa al guardar un presupuesto para que esta lista se relea. */
  recargarClave: number;
}

type Carga =
  | { contactId: string; status: "ok"; lista: Presupuesto[] }
  | { contactId: string; status: "error" };

const CASHEA_APAGADO = { ...ELECCION_CASHEA_INICIAL, activo: false };

/** «20 oct»: la fecha corta en la zona del negocio, no en la del navegador (`dayKey`, CLAUDE.md 10/9/2026). */
function fechaCorta(iso: string): string {
  return new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", timeZone: "America/Caracas" })
    .format(new Date(iso))
    .replace(".", "");
}

export function PresupuestosCliente({
  contactId,
  conversationId,
  bcvRate,
  contactDisplayName,
  contactPhone,
  contactCedulaType,
  contactCedulaNumber,
  onCartChanged,
  recargarClave,
}: PresupuestosClienteProps) {
  const [carga, setCarga] = useState<Carga | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [pasandoId, setPasandoId] = useState<string | null>(null);

  // Efecto inline con `.then()/.catch()` y bandera `cancelado` (trampa de
  // `react-hooks/set-state-in-effect`, CLAUDE.md 22/9/2026): no se escribe el
  // estado si el contacto cambió o el panel se desmontó antes de que resuelva.
  useEffect(() => {
    let cancelado = false;
    fetchPresupuestos(createClient(), { contactId })
      .then((lista) => {
        if (!cancelado) setCarga({ contactId, status: "ok", lista });
      })
      .catch((error) => {
        console.error("presupuestos_cliente_no_cargados", error);
        if (!cancelado) setCarga({ contactId, status: "error" });
      });
    return () => {
      cancelado = true;
    };
  }, [contactId, recargarClave]);

  // Una carga de OTRO contacto (el asesor cambió de chat) no se pinta.
  const actual = carga && carga.contactId === contactId ? carga : null;

  // Antes de los `return` tempranos: un hook no puede ir después de ellos.
  const listaCargada = actual?.status === "ok" ? actual.lista : null;
  const { porOrigen: envios, ahora, recargar: recargarEnvios } = useBorradoresSaint(
    "presupuesto",
    (listaCargada ?? []).map((p) => p.id),
  );

  if (actual === null) return null;

  if (actual.status === "error") {
    return (
      <p className="crm-lookup-hint" role="status">
        No se pudieron cargar los presupuestos de este cliente.
      </p>
    );
  }

  const { lista } = actual;
  if (lista.length === 0) return null;

  const nombre = separarNombreContacto(contactDisplayName).nombre || "este cliente";

  async function pasarAlCarrito(presupuesto: Presupuesto) {
    if (pasandoId !== null) return;
    setPasandoId(presupuesto.id);
    const total = presupuesto.items.length;
    let pasados = 0;
    try {
      const supabase = createClient();
      // En serie: `addToCart` suma con concurrencia optimista sobre la misma
      // conversación y dos renglones a la vez se pisarían entre sí.
      for (const item of presupuesto.items) {
        await addToCart(supabase, {
          conversationId,
          productId: item.productId,
          quantity: item.quantity,
          priceKind: item.priceKind,
          origin: "inventory",
        });
        pasados += 1;
      }
      toast.success(pasados === 1 ? "Se pasó 1 artículo al carrito" : `Se pasaron ${pasados} artículos al carrito`);
    } catch (error) {
      console.error("presupuesto_no_pasado_al_carrito", error);
      toast.danger(
        `Solo se pasaron ${pasados} de ${total} artículos al carrito. Revisa el carrito antes de seguir.`
      );
    } finally {
      setPasandoId(null);
      // Aunque falle a mitad: la pantalla tiene que mostrar lo que de verdad quedó.
      onCartChanged();
    }
  }

  return (
    <div className="crm-presup">
      <button
        type="button"
        className="crm-presup-toggle"
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
      >
        {abierto ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        {lista.length === 1 ? `1 guardado de ${nombre}` : `${lista.length} guardados de ${nombre}`}
      </button>

      {abierto && (
        <ul className="crm-presup-list">
          {lista.map((presupuesto) => {
            const totales = totalesCarrito(lineasDePresupuesto(presupuesto), bcvRate, CASHEA_APAGADO);
            const comparacion = comparacionTotal(presupuesto, bcvRate);
            return (
              <li className="crm-presup-item" key={presupuesto.id}>
                <div className="crm-presup-head">
                  <span className="crm-presup-name">{nombreCompletoPresupuesto(presupuesto)}</span>
                  <span className="crm-presup-date">{fechaCorta(presupuesto.updatedAt)}</span>
                </div>
                <p className="crm-presup-meta lm-num">
                  {totales.unpricedCount > 0
                    ? `${totales.renglones} art. · sin total hoy`
                    : `${totales.renglones} art. · $${totales.usd.toFixed(2)} de hoy`}
                </p>
                {comparacion && <p className="crm-presup-compare lm-num">{etiquetaComparacion(comparacion)}</p>}
                <button
                  type="button"
                  className="crm-lookup-add"
                  onClick={() => void pasarAlCarrito(presupuesto)}
                  disabled={pasandoId !== null}
                >
                  <ShoppingCart size={12} aria-hidden="true" />
                  Pasar al carrito
                </button>
                <EnviarASaint
                  origen="presupuesto"
                  origenId={presupuesto.id}
                  productos={presupuesto.items.map((i) => i.product)}
                  inicial={{
                    cedulaTipo: contactCedulaType ?? "",
                    cedulaNumero: contactCedulaNumber ?? "",
                    nombre: presupuesto.clienteNombre,
                    apellido: presupuesto.clienteApellido,
                    telefono: contactPhone,
                  }}
                  ultimo={envios.get(presupuesto.id) ?? null}
                  ahora={ahora}
                  onEnviado={recargarEnvios}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
