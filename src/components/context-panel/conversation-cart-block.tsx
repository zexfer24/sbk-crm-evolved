"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, MessageSquarePlus, Save, Sparkles } from "lucide-react";
import { Button, toast } from "@heroui/react";
import type { CedulaType, ConversationCartItem } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { cartSummaryText, cartTotals, priceCartLines } from "@/lib/conversation-cart";
import { guardarPresupuesto } from "@/lib/presupuestos-data";
import { renglonesParaGuardar, separarNombreContacto } from "@/lib/presupuestos";
import { CartLines } from "@/components/context-panel/cart-lines";
import { PresupuestosCliente } from "@/components/context-panel/presupuestos-cliente";
import type { CartActions } from "@/components/context-panel/use-cart-actions";
import { GuardarPresupuestoModal, type DatosPresupuestoForm } from "@/components/presupuestos/guardar-presupuesto-modal";
import { OpcionesCopiaCasillas } from "@/components/presupuestos/opciones-copia";
import { useOpcionesCopia } from "@/components/presupuestos/use-opciones-copia";
import { EnviarASaint } from "@/components/saint/enviar-a-saint";
import { useBorradoresSaint } from "@/components/saint/use-borradores-saint";

/**
 * «Lo que lleva el cliente» en el panel derecho del chat (T8, plan "Seba
 * encuentra, no insiste, y el mostrador no deja a nadie esperando",
 * 28/9/2026). El carrito ya no nace al pulsar «Cerrar venta»: vive en la
 * conversación, el asesor lo va llenando desde la búsqueda de inventario de
 * arriba (botón «Agregar» en cada resultado) o con lo que Seba cotizó, otro
 * asesor lo ve en vivo, y «Cerrar venta» lo toma tal cual.
 *
 * Los precios son los VIGENTES al momento de mirar y de facturar (D6): una
 * cotización de hace tres días se factura al precio de hoy, y el renglón
 * avisa «cotizado $X · hoy $Y» cuando difieren.
 *
 * 21/10/2026 (plan "Presupuestos y mensajes rápidos", T6): tres cosas más. (1)
 * «Qué copiar» (plegado) deja elegir qué lleva el texto de «Copiar» y «Enviar
 * al chat»: las mismas casillas que el carrito de /inventario, recordadas por
 * asesor. (2) «Guardar presupuesto» guarda el carrito de la conversación como
 * presupuesto del contacto (siempre uno nuevo desde el chat). (3) Debajo, los
 * presupuestos que ese contacto ya tiene, para pasarlos al carrito
 * (`PresupuestosCliente`).
 *
 * 25/10/2026 (plan "Enviar a SAINT", T3): «Enviar a SAINT» manda el carrito
 * como factura en espera (origen `carrito`, id = la conversación). El
 * contacto precarga cédula, nombre, apellido y teléfono del modal. Con el
 * carrito vacío NO hay botón, pero si ese chat tuvo un envío antes su línea de
 * estado sigue visible (`soloEstado`): el asesor vacía el carrito y quiere
 * saber si SAINT llegó a crearlo.
 */

interface ConversationCartBlockProps {
  cart: ConversationCartItem[];
  bcvRate: number;
  actions: CartActions;
  /**
   * Deja el resumen del carrito en el cuadro de mensaje del composer, SIN
   * enviarlo (T4, plan "Ronda del cliente", 30/9/2026). Opcional: sin él,
   * «Enviar al chat» queda deshabilitado en vez de no hacer nada.
   */
  onSendToComposer?: (text: string) => void;
  /** El asesor de la sesión: las casillas de «qué copiar» se recuerdan por asesor. */
  agentId: string;
  conversationId: string;
  /** Contacto del chat: dueño de los presupuestos que se guardan y se listan. */
  contactId: string;
  /** Precarga el nombre y el apellido del modal de «Guardar presupuesto». */
  contactDisplayName: string | null;
  /** Teléfono del contacto: precarga el modal de «Enviar a SAINT». */
  contactPhone: string;
  /** Cédula del contacto, si la tiene: precarga el modal de «Enviar a SAINT». */
  contactCedulaType: CedulaType | null;
  contactCedulaNumber: string | null;
  /** Pide a `crm-shell.tsx` releer el carrito: `PresupuestosCliente` lo usa tras pasar un presupuesto. */
  onCartChanged: () => void;
}

const SIN_PRECIO = "Hay productos sin precio (falta la tasa BCV)";

export function ConversationCartBlock({
  cart,
  bcvRate,
  actions,
  onSendToComposer,
  agentId,
  conversationId,
  contactId,
  contactDisplayName,
  contactPhone,
  contactCedulaType,
  contactCedulaNumber,
  onCartChanged,
}: ConversationCartBlockProps) {
  const [opcionesCopia, setOpcionesCopia] = useOpcionesCopia(agentId);
  const [casillasAbiertas, setCasillasAbiertas] = useState(false);
  const [guardarAbierto, setGuardarAbierto] = useState(false);
  // Sube al guardar un presupuesto para que `PresupuestosCliente` relea su lista.
  const [recargarClave, setRecargarClave] = useState(0);
  const { porOrigen: envios, ahora, recargar: recargarEnvios } = useBorradoresSaint("carrito", [conversationId]);
  const ultimoEnvio = envios.get(conversationId) ?? null;

  // El mismo cálculo que pinta `CartLines`; `null` si el carrito está vacío o
  // algún renglón no tiene precio en dólares.
  const lines = priceCartLines(cart, bcvRate);
  const summary = cartSummaryText(lines, cartTotals(lines), opcionesCopia);

  // Deshabilitado por falta de precio: el `title` dice por qué.
  const motivo = summary === null ? SIN_PRECIO : undefined;

  async function handleCopy() {
    if (summary === null) return;
    try {
      await navigator.clipboard.writeText(summary);
      toast.success("Carrito copiado");
    } catch {
      toast.danger("No se pudo copiar");
    }
  }

  // Desde el chat siempre se crea uno nuevo (`id: null`): reemplazar uno
  // existente es cosa de /inventario, donde se reabre.
  async function handleGuardarPresupuesto(datos: DatosPresupuestoForm) {
    await guardarPresupuesto(createClient(), {
      id: null,
      clienteNombre: datos.nombre,
      clienteApellido: datos.apellido,
      contactId,
      conversationId,
      origen: "chat",
      nota: datos.nota === "" ? null : datos.nota,
      items: renglonesParaGuardar(lines),
    });
    toast.success(`Presupuesto de ${datos.nombre} ${datos.apellido} guardado`);
    setRecargarClave((k) => k + 1);
  }

  return (
    <section className="crm-context-section">
      <p className="lm-eyebrow">Lo que lleva el cliente</p>

      {cart.length === 0 ? (
        <p className="crm-lookup-hint">
          Todavía no hay nada. Agrega repuestos desde el inventario de arriba o trae lo que Seba cotizó.
        </p>
      ) : (
        <>
          <CartLines cart={cart} bcvRate={bcvRate} actions={actions} />
          <div className="crm-pcart-share">
            {/* El `title` va en el envoltorio: el Button de HeroUI no lo pasa al
                DOM, y un botón deshabilitado tampoco recibe el hover. */}
            <span className="crm-pcart-share-btn" title={motivo}>
              <Button
                size="sm"
                variant="secondary"
                fullWidth
                isDisabled={summary === null}
                onPress={() => void handleCopy()}
              >
                <Copy size={13} />
                Copiar
              </Button>
            </span>
            <span className="crm-pcart-share-btn" title={motivo}>
              <Button
                size="sm"
                variant="secondary"
                fullWidth
                isDisabled={summary === null || !onSendToComposer}
                onPress={() => {
                  if (summary !== null) onSendToComposer?.(summary);
                }}
              >
                <MessageSquarePlus size={13} />
                Enviar al chat
              </Button>
            </span>
          </div>

          <button
            type="button"
            className="crm-pcart-copy-toggle"
            aria-expanded={casillasAbiertas}
            onClick={() => setCasillasAbiertas((v) => !v)}
          >
            {casillasAbiertas ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            Qué copiar
          </button>
          {casillasAbiertas && (
            <OpcionesCopiaCasillas
              opciones={opcionesCopia}
              onChange={setOpcionesCopia}
              mostrarCashea={false}
              idPrefix="carrito-chat-copia"
            />
          )}

          <Button size="sm" variant="secondary" fullWidth onPress={() => setGuardarAbierto(true)}>
            <Save size={13} />
            Guardar presupuesto
          </Button>

          <EnviarASaint
            origen="carrito"
            origenId={conversationId}
            productos={cart.map((i) => i.product)}
            inicial={{
              cedulaTipo: contactCedulaType ?? "",
              cedulaNumero: contactCedulaNumber ?? "",
              ...separarNombreContacto(contactDisplayName),
              telefono: contactPhone,
            }}
            ultimo={ultimoEnvio}
            ahora={ahora}
            onEnviado={recargarEnvios}
          />
        </>
      )}

      {cart.length === 0 && ultimoEnvio && (
        <EnviarASaint
          origen="carrito"
          origenId={conversationId}
          productos={[]}
          inicial={{ cedulaTipo: "", cedulaNumero: "", nombre: "", apellido: "", telefono: "" }}
          ultimo={ultimoEnvio}
          ahora={ahora}
          onEnviado={recargarEnvios}
          soloEstado
        />
      )}

      <Button
        size="sm"
        variant="secondary"
        fullWidth
        isDisabled={actions.busy}
        onPress={() => void actions.addAllQuotes()}
      >
        <Sparkles size={13} />
        Agregar cotizaciones de Seba
      </Button>

      {cart.length > 0 && (
        <GuardarPresupuestoModal
          isOpen={guardarAbierto}
          onOpenChange={setGuardarAbierto}
          inicial={{ ...separarNombreContacto(contactDisplayName), nota: "" }}
          puedeGuardarCambios={false}
          onGuardar={handleGuardarPresupuesto}
        />
      )}

      <PresupuestosCliente
        contactId={contactId}
        conversationId={conversationId}
        bcvRate={bcvRate}
        contactDisplayName={contactDisplayName}
        contactPhone={contactPhone}
        contactCedulaType={contactCedulaType}
        contactCedulaNumber={contactCedulaNumber}
        onCartChanged={onCartChanged}
        recargarClave={recargarClave}
      />
    </section>
  );
}
