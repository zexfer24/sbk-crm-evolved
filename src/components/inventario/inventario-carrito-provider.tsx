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
import type { Product } from "@/lib/types";
import { ELECCION_CASHEA_INICIAL } from "@/lib/cashea";
import {
  leerCarritoGuardado,
  reducirCarrito,
  serializarCarrito,
  type LineaCarritoInventario,
  type OpcionesCashea,
} from "@/lib/inventario-carrito";
import { fetchProductsByIds } from "@/lib/inventory-data";
import { createClient } from "@/lib/supabase/client";
import { CarritoPanel } from "@/components/inventario/carrito-panel";
import {
  CarritoContext,
  useInventarioCarrito,
  type InventarioCarritoValue,
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
 */

export const CARRITO_STORAGE_PREFIX = "sbk:inventario-carrito:v1:";

// El contexto, su tipo y el hook viven en `inventario-carrito-context.ts` (corta
// el import circular con `carrito-panel.tsx`); se re-exportan para no romper imports.
export { useInventarioCarrito, type InventarioCarritoValue };

const CASHEA_INICIAL: OpcionesCashea = { activo: false, ...ELECCION_CASHEA_INICIAL };

export function InventarioCarritoProvider({
  agentId,
  bcvRate,
  children,
}: {
  agentId: string;
  bcvRate: number;
  children: ReactNode;
}) {
  const [lineas, despachar] = useReducer(reducirCarrito, [] as LineaCarritoInventario[]);
  const [abierto, setAbierto] = useState(false);
  const [cashea, setCashea] = useState<OpcionesCashea>(CASHEA_INICIAL);

  // Refs y no estado: son banderas de control que no pintan nada, y un
  // `setState` aquí dispararía `react-hooks/set-state-in-effect`.
  // `hidratado`: ya se leyó lo guardado; antes de eso escribir pisaría el
  // carrito del asesor con el estado vacío del primer render.
  // `escrituraActiva`: se apaga si la lectura falló, para no borrar lo guardado
  // con un carrito que quedó vacío por un corte de red, no por decisión del asesor.
  const hidratado = useRef(false);
  const escrituraActiva = useRef(true);
  const clave = `${CARRITO_STORAGE_PREFIX}${agentId}`;

  // Lectura al montar (o al cambiar de asesor).
  useEffect(() => {
    hidratado.current = false;
    escrituraActiva.current = true;

    let crudo: string | null = null;
    try {
      crudo = window.localStorage.getItem(clave);
    } catch {
      // Almacenamiento bloqueado (navegación privada, política del navegador):
      // el carrito sigue funcionando en memoria, solo que no se recuerda.
      hidratado.current = true;
      return;
    }

    const guardado = leerCarritoGuardado(crudo);
    if (guardado.length === 0) {
      hidratado.current = true;
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
        for (const { productId, quantity } of guardado) {
          const product = porId.get(productId);
          if (product) restauradas.push({ product, quantity, quotedPriceUsd: null });
        }
        hidratado.current = true;
        despachar({ tipo: "restaurar", lineas: restauradas });
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
  }, [clave]);

  // Escritura en cada cambio, solo tras hidratar.
  useEffect(() => {
    if (!hidratado.current || !escrituraActiva.current) return;
    try {
      window.localStorage.setItem(clave, serializarCarrito(lineas));
    } catch {
      // Cuota llena o almacenamiento bloqueado: la cotización sigue en memoria.
    }
  }, [lineas, clave]);

  const agregar = useCallback((product: Product) => {
    // La fila ya deshabilita "Agregar" en los inactivos; esto es la defensa.
    if (!product.isActive) return;
    despachar({ tipo: "agregar", product });
  }, []);
  const cambiarCantidad = useCallback(
    (productId: string, quantity: number) => despachar({ tipo: "cantidad", productId, quantity }),
    [],
  );
  const quitar = useCallback((productId: string) => despachar({ tipo: "quitar", productId }), []);
  const vaciar = useCallback(() => despachar({ tipo: "vaciar" }), []);
  const abrir = useCallback(() => setAbierto(true), []);
  const cerrar = useCallback(() => setAbierto(false), []);

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
    }),
    [lineas, abierto, cashea, agregar, cambiarCantidad, quitar, vaciar, abrir, cerrar],
  );

  return (
    <CarritoContext.Provider value={valor}>
      {children}
      <CarritoPanel bcvRate={bcvRate} />
    </CarritoContext.Provider>
  );
}
