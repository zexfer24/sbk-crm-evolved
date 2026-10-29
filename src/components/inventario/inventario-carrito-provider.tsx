"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "@heroui/react";
import type { AgentRole, Product } from "@/lib/types";
import { ELECCION_CASHEA_INICIAL } from "@/lib/cashea";
import {
  leerCarritoGuardado,
  precioDelCarrito,
  reducirCarrito,
  serializarCarrito,
  totalesCarrito,
  type LineaCarritoInventario,
  type OpcionesCashea,
} from "@/lib/inventario-carrito";
import { fetchProductsByIds } from "@/lib/inventory-data";
import { lineasDePresupuesto, type Presupuesto } from "@/lib/presupuestos";
import { createClient } from "@/lib/supabase/client";
import { CarritoPanel } from "@/components/inventario/carrito-panel";
import {
  CarritoContext,
  useInventarioCarrito,
  type InventarioCarritoValue,
  type PresupuestoActivo,
} from "@/components/inventario/inventario-carrito-context";

/**
 * Estado del carrito de cotización del Inventario (12/10/2026, plan "Carrito
 * de cotización en el Inventario, con Cashea", T4).
 *
 * `/inventario` es un server component que pagina por URL: cada página nueva
 * re-renderiza la lista, pero este provider (client) queda montado por encima
 * y el carrito sobrevive a la navegación. NO agrega nodos al DOM de la vista:
 * `.dash-frame` es un grid de dos columnas (ver la trampa del fragmento del
 * 9/9/2026) y el panel sale por el portal del Drawer.
 *
 * Persistencia (D6): en localStorage solo van `[{productId, quantity}]`, por
 * asesor. El precio se vuelve a leer de `products` al restaurar, así que una
 * cotización armada ayer se ve al precio de hoy. Cashea (encendido, nivel,
 * cuotas, bajada) vive aquí pero NO se guarda: es la elección de esta sesión.
 *
 * 21/10/2026 ("Presupuestos y mensajes rápidos", T4): el carrito ya no cobra
 * siempre la promoción. El asesor puede pasar TODO el carrito al precio
 * estándar (promoción + envío MRW por peso) con un interruptor, y el carrito
 * puede guardarse como presupuesto de un cliente. Dos claves nuevas, por
 * asesor y también en localStorage: la preferencia de estándar (lo que se
 * agrega entra a ese precio) y el presupuesto que el asesor tiene abierto. La
 * caja (`soloLectura`) no ve el precio estándar —la base le da la tarifa MRW
 * `null`—, así que su carrito queda SIEMPRE en promoción aunque
 * localStorage diga otra cosa (decisión D4).
 *
 * 28/10/2026 ("El carrito de cotización se ordena", T1): la preferencia de
 * estándar YA NO se guarda. Decisión del operador: "cada artículo entra a
 * precio promoción; el estándar se activa a mano y no se recuerda para el
 * próximo carrito". Antes, un asesor que cobraba estándar una vez abría el
 * siguiente carrito (otro cliente) ya encendido y cotizaba a estándar sin
 * darse cuenta. Ahora el interruptor arranca apagado, vuelve a apagarse al
 * vaciar o cambiar de asesor, y al restaurar un carrito guardado refleja los
 * renglones (encendido solo si TODOS son estándar). La clave vieja
 * `ESTANDAR_STORAGE_PREFIX` solo se conserva para borrarla al montar.
 */

export const CARRITO_STORAGE_PREFIX = "sbk:inventario-carrito:v1:";
export const ESTANDAR_STORAGE_PREFIX = "sbk:inventario-carrito:estandar:v1:";
export const PRESUPUESTO_STORAGE_PREFIX = "sbk:inventario-carrito:presupuesto:v1:";

// El contexto, su tipo y el hook viven en `inventario-carrito-context.ts` (corta
// el import circular con `carrito-panel.tsx`); se re-exportan para no romper imports.
export { useInventarioCarrito, type InventarioCarritoValue };

const CASHEA_INICIAL: OpcionesCashea = { activo: false, ...ELECCION_CASHEA_INICIAL };

/**
 * El presupuesto abierto que dejó localStorage, sin fiarse de nada (lo pudo
 * escribir una versión vieja o el navegador). Nunca lanza; lo que no calza con
 * la forma esperada se descarta entero.
 */
function leerPresupuestoGuardado(raw: string | null): PresupuestoActivo | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { id, clienteNombre, clienteApellido, nota, createdBy } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || id === "") return null;
    if (typeof clienteNombre !== "string" || typeof clienteApellido !== "string") return null;
    return {
      id,
      clienteNombre,
      clienteApellido,
      nota: typeof nota === "string" ? nota : null,
      createdBy: typeof createdBy === "string" ? createdBy : null,
    };
  } catch {
    return null;
  }
}

/** Escribe (o, con `null`, borra) una clave. Cuota llena o almacenamiento bloqueado: se sigue en memoria. */
function escribirClave(clave: string, valor: string | null): void {
  try {
    if (valor === null) window.localStorage.removeItem(clave);
    else window.localStorage.setItem(clave, valor);
  } catch {
    // La preferencia o el presupuesto abierto no se recuerdan; no es un error del asesor.
  }
}

export function InventarioCarritoProvider({
  agentId,
  bcvRate,
  soloLectura,
  role,
  children,
}: {
  agentId: string;
  bcvRate: number;
  /** Rol `caja`: sin precio estándar (decisión D4). */
  soloLectura: boolean;
  role: AgentRole;
  children: ReactNode;
}) {
  const [lineas, despachar] = useReducer(reducirCarrito, [] as LineaCarritoInventario[]);
  const [abierto, setAbierto] = useState(false);
  const [cashea, setCashea] = useState<OpcionesCashea>(CASHEA_INICIAL);
  const [presupuestoActivo, setPresupuestoActivo] = useState<PresupuestoActivo | null>(null);

  // El interruptor de estándar arranca apagado y vuelve a apagarse si cambia el
  // asesor (28/10/2026: ya no se recuerda), con el patrón "Adjusting state when
  // a prop changes" (durante el render) y no con un `setState` dentro de un
  // efecto (`react-hooks/set-state-in-effect`).
  const [estandarElegido, setEstandarElegido] = useState(false);
  const [agenteDeLaPreferencia, setAgenteDeLaPreferencia] = useState(agentId);
  if (agentId !== agenteDeLaPreferencia) {
    setAgenteDeLaPreferencia(agentId);
    setEstandarElegido(false);
  }
  const puedeCobrarEstandar = !soloLectura;
  // La caja nunca cobra estándar, diga lo que diga el estado.
  const cobrarEstandar = puedeCobrarEstandar && estandarElegido;

  // Misma regla que la calculadora Cashea (T7): si había 6 cuotas elegidas y el
  // total baja a $100 o menos, la elección pasa a 3, y subir el total de nuevo
  // NO revive el 6 (el asesor no lo volvió a pedir). Se hace durante el render,
  // sobre el propio estado del provider, y no en un efecto:
  // `react-hooks/set-state-in-effect` lo prohíbe.
  if (cashea.activo && totalesCarrito(lineas, bcvRate, cashea).cashea?.ajustado) {
    setCashea({ ...cashea, cuotas: ELECCION_CASHEA_INICIAL.cuotas });
  }

  // Refs y no estado: son banderas de control que no pintan nada, y un
  // `setState` aquí dispararía `react-hooks/set-state-in-effect`.
  // `hidratado`: ya se leyó lo guardado; antes de eso escribir pisaría el
  // carrito del asesor con el estado vacío del primer render.
  // `escrituraActiva`: se apaga si la lectura falló, para no borrar lo guardado
  // con un carrito que quedó vacío por un corte de red, no por decisión del asesor.
  const hidratado = useRef(false);
  const escrituraActiva = useRef(true);
  const clave = `${CARRITO_STORAGE_PREFIX}${agentId}`;
  const claveEstandar = `${ESTANDAR_STORAGE_PREFIX}${agentId}`;
  const clavePresupuesto = `${PRESUPUESTO_STORAGE_PREFIX}${agentId}`;

  // Lectura al montar (o al cambiar de asesor).
  useEffect(() => {
    hidratado.current = false;
    escrituraActiva.current = true;
    // Resto de la versión anterior, que guardaba la preferencia (28/10/2026).
    escribirClave(claveEstandar, null);

    let crudo: string | null = null;
    let crudoPresupuesto: string | null = null;
    try {
      crudo = window.localStorage.getItem(clave);
      crudoPresupuesto = window.localStorage.getItem(clavePresupuesto);
    } catch {
      // Almacenamiento bloqueado (navegación privada, política del navegador):
      // el carrito sigue funcionando en memoria, solo que no se recuerda.
      hidratado.current = true;
      return;
    }

    const guardado = leerCarritoGuardado(crudo);
    if (guardado.length === 0) {
      hidratado.current = true;
      // Un presupuesto abierto sin renglones no significa nada: se descarta.
      escribirClave(clavePresupuesto, null);
      return;
    }

    let cancelado = false;
    const ids = guardado.map((g) => g.productId);
    fetchProductsByIds(createClient(), ids)
      .then((productos) => {
        if (cancelado) return;
        const porId = new Map(productos.map((p) => [p.id, p]));
        // En el orden guardado (la base no garantiza orden) y sin los ids que
        // ya no existen: un producto borrado no se puede cotizar.
        const restauradas: LineaCarritoInventario[] = [];
        for (const { productId, quantity, priceKind } of guardado) {
          const product = porId.get(productId);
          // La caja no ve el estándar: lo que haya guardado en ese precio vuelve a promoción.
          if (product) {
            restauradas.push({
              product,
              quantity,
              quotedPriceUsd: null,
              priceKind: soloLectura ? "promocion" : priceKind,
            });
          }
        }
        hidratado.current = true;
        despachar({ tipo: "restaurar", lineas: restauradas });
        // El interruptor refleja lo restaurado: encendido solo si TODOS los
        // renglones son estándar, para que un carrito en curso recargado no
        // quede "mixto" por accidente. La caja nunca lo enciende.
        setEstandarElegido(
          !soloLectura && restauradas.length > 0 && restauradas.every((l) => l.priceKind === "estandar"),
        );
        // El presupuesto abierto solo tiene sentido con renglones: si ya no
        // quedó ninguno (productos borrados), se descarta.
        if (restauradas.length === 0) escribirClave(clavePresupuesto, null);
        else setPresupuestoActivo(leerPresupuestoGuardado(crudoPresupuesto));
      })
      .catch((error: unknown) => {
        if (cancelado) return;
        console.error("[inventario-carrito] no se pudo recuperar el carrito guardado", error);
        toast.warning("No se pudo recuperar el carrito guardado.");
        // `hidratado` queda en false a propósito: no se escribe nada esta sesión.
        escrituraActiva.current = false;
      });

    return () => {
      cancelado = true;
    };
  }, [clave, claveEstandar, clavePresupuesto, soloLectura]);

  // Escritura en cada cambio, solo tras hidratar.
  useEffect(() => {
    if (!hidratado.current || !escrituraActiva.current) return;
    try {
      window.localStorage.setItem(clave, serializarCarrito(lineas));
    } catch {
      // Cuota llena o almacenamiento bloqueado: la cotización sigue en memoria.
    }
  }, [lineas, clave]);

  const agregar = useCallback(
    (product: Product) => {
      // La fila ya deshabilita "Agregar" en los inactivos; esto es la defensa.
      if (!product.isActive) return;
      // Siempre se manda el precio: sin él, sumar otra unidad de un producto que
      // ya estaba lo devolvería a promoción aunque el carrito vaya en estándar.
      despachar({ tipo: "agregar", product, priceKind: cobrarEstandar ? "estandar" : "promocion" });
    },
    [cobrarEstandar],
  );
  const cambiarCantidad = useCallback(
    (productId: string, quantity: number) => despachar({ tipo: "cantidad", productId, quantity }),
    [],
  );
  const quitar = useCallback((productId: string) => despachar({ tipo: "quitar", productId }), []);
  const vaciar = useCallback(() => {
    despachar({ tipo: "vaciar" });
    // Un carrito vacío vuelve a promoción: el estándar no se arrastra al próximo (28/10/2026).
    setEstandarElegido(false);
    setPresupuestoActivo(null);
    escribirClave(clavePresupuesto, null);
  }, [clavePresupuesto]);
  const abrir = useCallback(() => setAbierto(true), []);
  const cerrar = useCallback(() => setAbierto(false), []);

  const setCobrarEstandar = useCallback(
    (valor: boolean) => {
      if (soloLectura) return;
      setEstandarElegido(valor);
      despachar({ tipo: "precio", priceKind: valor ? "estandar" : "promocion" });
    },
    [soloLectura],
  );

  const marcarPresupuestoGuardado = useCallback(
    (activo: PresupuestoActivo) => {
      setPresupuestoActivo(activo);
      escribirClave(clavePresupuesto, JSON.stringify(activo));
    },
    [clavePresupuesto],
  );

  const olvidarPresupuestoActivo = useCallback(() => {
    setPresupuestoActivo(null);
    escribirClave(clavePresupuesto, null);
  }, [clavePresupuesto]);

  const cargarPresupuesto = useCallback(
    (presupuesto: Presupuesto) => {
      // Se REEMPLAZA el carrito (quien llama ya confirmó) y se cobra el precio de
      // HOY (D1): `lineasDePresupuesto` deja el cotizado solo como referencia.
      const nuevas = lineasDePresupuesto(presupuesto).map((l) =>
        soloLectura ? { ...l, priceKind: "promocion" as const } : l,
      );
      despachar({ tipo: "vaciar" });
      despachar({ tipo: "restaurar", lineas: nuevas });
      marcarPresupuestoGuardado({
        id: presupuesto.id,
        clienteNombre: presupuesto.clienteNombre,
        clienteApellido: presupuesto.clienteApellido,
        nota: presupuesto.nota,
        createdBy: presupuesto.createdBy,
      });
      // El interruptor refleja lo que trae el presupuesto: estándar si todos lo son.
      const todosEstandar = nuevas.length > 0 && nuevas.every((l) => l.priceKind === "estandar");
      setEstandarElegido(todosEstandar);
      setAbierto(true);
    },
    [soloLectura, marcarPresupuestoGuardado],
  );

  const valor = useMemo<InventarioCarritoValue>(
    () => ({
      lineas,
      unidades: lineas.reduce((suma, l) => suma + l.quantity, 0),
      cantidadDe: (productId) => lineas.find((l) => l.product.id === productId)?.quantity ?? 0,
      agregar,
      cambiarCantidad,
      quitar,
      vaciar,
      abierto,
      abrir,
      cerrar,
      cashea,
      setCashea,
      priceKind: precioDelCarrito(lineas),
      cobrarEstandar,
      setCobrarEstandar,
      puedeCobrarEstandar,
      presupuestoActivo,
      cargarPresupuesto,
      marcarPresupuestoGuardado,
      olvidarPresupuestoActivo,
    }),
    [
      lineas,
      abierto,
      cashea,
      agregar,
      cambiarCantidad,
      quitar,
      vaciar,
      abrir,
      cerrar,
      cobrarEstandar,
      setCobrarEstandar,
      puedeCobrarEstandar,
      presupuestoActivo,
      cargarPresupuesto,
      marcarPresupuestoGuardado,
      olvidarPresupuestoActivo,
    ],
  );

  return (
    <CarritoContext.Provider value={valor}>
      {children}
      <CarritoPanel bcvRate={bcvRate} agentId={agentId} role={role} />
    </CarritoContext.Provider>
  );
}
