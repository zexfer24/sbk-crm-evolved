import { tool } from "ai";
import { z } from "zod";
import type { PaymentMethodConfig } from "@/lib/payment-methods";
import type { Product } from "@/lib/types";
import type { TurnEffects } from "./effects";
import {
  armarPedido,
  formatoUsd,
  renglonesParaNota,
  tipoDePrecio,
  type RazonDePase,
  type RazonDeRechazo,
  type RenglonDePedido,
  type ResultadoPedido,
} from "./pedido";
import type { SesionDeTurno } from "./sesion";
import { ENTREGAS, type Entrega, type EstadoSeba, type LineaDeCarrito } from "./tipos";
import { lineaTiendaCerrada } from "./textos";

/**
 * La herramienta `prepararPago` de Seba v2 (S5, 17/11/2026).
 *
 * El modelo la llama cuando el cliente ya aceptó el producto y dijo cómo paga y
 * cómo lo recibe; el CÓDIGO arma el total y escribe el mensaje (`armarPedido`).
 * El modelo no recibe ni una cifra de dinero ni un dato de pago: solo la
 * instrucción de qué hacer después. Cuando la herramienta envía, el turno queda
 * `terminado` —todo lo que había que decir ya salió— y el bucle del modelo se corta.
 *
 * Los productos y la tasa llegan por funciones inyectadas (`cargarProductos`,
 * `leerTasa`): este archivo no toca Supabase ni Redis, así se prueba con
 * `crearEffectsDeMemoria`. En producción el turno inyecta `fetchProductsByIds`
 * (que ya aplica el recargo del 6/11/2026) y `getBcvRate`.
 */

export const NOMBRE_PREPARAR_PAGO = "prepararPago";

export interface DepsDePrepararPago {
  effects: TurnEffects;
  sesion: SesionDeTurno;
  metodos: PaymentMethodConfig[];
  cashea: { datosText: string; minimoUsd: number; seisCuotasDesdeUsd: number };
  /** Carga productos por id YA con el recargo aplicado (el turno inyecta `fetchProductsByIds`). */
  cargarProductos: (ids: string[]) => Promise<Product[]>;
  /** Tasa BCV vigente o `null`. */
  leerTasa: () => Promise<number | null>;
}

export interface EntradaDePrepararPago {
  lineas: { productId: string; cantidad: number }[];
  formaDePago: string;
  entrega: Entrega;
  ciudad?: string;
}

/** Hasta aquí llega la nota al asesor: es un campo de texto corto en su panel. */
const NOTA_MAX = 600;

/** Si faltan entre un centavo y esto para las seis cuotas de Cashea, vale la pena sugerir un complemento. */
const COMPLEMENTO_SEIS_CUOTAS_MAX_USD = 15;

const ENVIADO_Y_PASADO = "Listo: el resumen ya se envió y el caso pasó a ventas. No escribas nada más.";
// El mensaje del pedido ya trae la línea del comprobante: si el modelo escribiera otra, se repetiría.
const ENVIADO_DATOS_DE_PAGO = "Listo: el resumen y los datos de pago ya se enviaron. No escribas nada más.";
const ENVIO_FALLIDO = "No se pudo enviar el mensaje.";

const ENTREGA_EN_NOTA: Record<Entrega, string> = {
  envio: "envío",
  retiro: "retiro en tienda",
  delivery: "delivery",
};

function instruccionDeRechazo(razon: RazonDeRechazo, detalle: string, metodos: PaymentMethodConfig[]): string {
  switch (razon) {
    case "falta_ciudad":
      return "Falta la ciudad de envío: pregúntasela al cliente.";
    case "producto_no_buscado":
      return "Ese producto no se ha cotizado en esta conversación: búscalo primero con buscarRepuesto.";
    case "sin_existencia":
      return `${detalle} no tiene existencia: ofrécele otra opción o pasa el caso.`;
    case "pedido_vacio":
      return "El pedido está vacío: pregúntale al cliente qué producto quiere llevar.";
    case "cantidad_invalida":
      return `${detalle} Confirma la cantidad con el cliente.`;
    case "forma_inactiva": {
      const disponibles = ["Cashea", ...metodos.filter((m) => m.isActive).map((m) => m.label)];
      return `Esa forma de pago no está disponible. Las formas disponibles son: ${disponibles.join(", ")}. Pregúntale al cliente cuál prefiere.`;
    }
  }
}

function etiquetaDeForma(forma: string, metodos: PaymentMethodConfig[]): string {
  if (forma === "cashea") return "Cashea";
  return metodos.find((m) => m.key === forma)?.label ?? forma;
}

function queFalta(razon: RazonDePase, detalle: string, etiqueta: string): string {
  switch (razon) {
    case "binance_divisa":
      return `precio en divisa y datos de ${etiqueta}`;
    case "sin_precio_estandar":
      return `precio con envío de ${detalle} (sin peso cargado)`;
    case "sin_tasa":
      return "tasa BCV vigente para confirmar el total";
    case "sin_precio":
      return `precio de ${detalle}`;
    case "metodo_no_entregable":
      return `datos de pago de ${etiqueta}`;
  }
}

interface DatosDeNota {
  renglones: RenglonDePedido[];
  forma: string;
  entrega: Entrega;
  ciudad: string | null;
  etiquetaForma: string;
  totalLinea: string;
  precioLinea: string;
  falta: string | null;
}

/** La nota que lee el asesor: qué pidió, cuánto, cómo paga, cómo lo recibe y qué falta. Máximo 600 caracteres. */
function armarNota(d: DatosDeNota): string {
  const resto = [
    d.totalLinea,
    d.precioLinea,
    `Pago: ${d.etiquetaForma}`,
    `Entrega: ${ENTREGA_EN_NOTA[d.entrega]}${d.ciudad ? ` (${d.ciudad})` : ""}`,
    ...(d.falta ? [`Falta: ${d.falta}`] : []),
  ].join("\n");
  // Lo que se recorta, si algo, son los renglones: «Falta» y el total son lo que el asesor no puede perder.
  const prefijo = "Pedido armado por la IA: ";
  const presupuesto = NOTA_MAX - resto.length - 1 - prefijo.length;
  const renglones = renglonesParaNota(d.renglones).join("; ");
  const recortados =
    renglones.length <= presupuesto ? renglones : `${renglones.slice(0, Math.max(0, presupuesto - 1))}…`;
  return `${prefijo}${recortados}\n${resto}`.slice(0, NOTA_MAX);
}

function fusionarLineas(lineas: EntradaDePrepararPago["lineas"]): { productId: string; cantidad: number }[] {
  const porId = new Map<string, number>();
  for (const l of lineas) porId.set(l.productId, (porId.get(l.productId) ?? 0) + l.cantidad);
  return [...porId.entries()].map(([productId, cantidad]) => ({ productId, cantidad }));
}

/**
 * La lógica de `execute`, exportada para probarla sin el SDK. Devuelve el texto
 * que recibe el MODELO (nunca el que recibe el cliente).
 */
export async function ejecutarPrepararPago(
  deps: DepsDePrepararPago,
  entrada: EntradaDePrepararPago,
): Promise<string> {
  const { effects, sesion, metodos } = deps;
  sesion.herramientas.push(NOMBRE_PREPARAR_PAGO);

  const lineasFusionadas = fusionarLineas(entrada.lineas);
  const ids = lineasFusionadas.map((l) => l.productId);
  const [cargados, bcvRate, cotizadosAntes] = await Promise.all([
    deps.cargarProductos(ids),
    deps.leerTasa(),
    effects.productosYaCotizados(),
  ]);
  // Lo cotizado en ESTE turno también cuenta. En sombra la búsqueda no inserta
  // en `conversation_quotes` (el cliente nunca vio esa cotización), así que la
  // base no lo sabe: el turno lo anota en `sesion.productos` (17/11/2026).
  const yaCotizados = new Set<string>([...cotizadosAntes, ...sesion.productos]);

  const porId = new Map(cargados.map((p) => [p.id, p]));
  // Un id que la base no devuelve es, para el modelo, un producto que nunca se buscó.
  if (ids.some((id) => !porId.has(id))) return instruccionDeRechazo("producto_no_buscado", "", metodos);

  const ciudad = entrada.ciudad?.trim() ? entrada.ciudad.trim() : null;
  const renglones: RenglonDePedido[] = lineasFusionadas.map((l) => ({
    product: porId.get(l.productId) as Product,
    cantidad: l.cantidad,
  }));

  const resultado = armarPedido({
    lineas: renglones,
    forma: entrada.formaDePago,
    entrega: entrada.entrega,
    ciudad,
    bcvRate,
    metodos,
    yaCotizados,
    casheaDatosText: deps.cashea.datosText,
    casheaMinimoUsd: deps.cashea.minimoUsd,
    casheaSeisCuotasDesdeUsd: deps.cashea.seisCuotasDesdeUsd,
  });

  if (resultado.tipo === "rechazado") {
    return instruccionDeRechazo(resultado.razon, resultado.detalle, metodos);
  }

  const priceKind = tipoDePrecio(entrada.formaDePago, entrada.entrega);
  const carrito: LineaDeCarrito[] = lineasFusionadas.map((l) => ({ ...l, priceKind }));
  const etiquetaForma = etiquetaDeForma(entrada.formaDePago, metodos);

  const comunes = {
    renglones,
    forma: entrada.formaDePago,
    entrega: entrada.entrega,
    ciudad,
    etiquetaForma,
    precioLinea:
      priceKind === "estandar" ? "Precio: estándar (envío MRW incluido)" : "Precio: de promoción",
  };

  if (resultado.tipo === "datos_de_pago") {
    return enviarDatosDePago(deps, resultado, carrito, {
      lineas: lineasFusionadas,
      forma: entrada.formaDePago,
      entrega: entrada.entrega,
      ciudad,
    });
  }

  if (resultado.tipo === "cashea") {
    // Una sola vez por conversación: si al pedido le falta poco para algo que le conviene al cliente,
    // el modelo lo sugiere antes de pasar el caso. Después de eso no se vuelve a frenar.
    if (!sesion.estado.complementoSugerido) {
      const sugerencia = sugerenciaDeComplemento(resultado);
      if (sugerencia !== null) {
        sesion.estado = {
          ...sesion.estado,
          complementoSugerido: true,
          actualizadoEn: sesion.ahora.toISOString(),
        };
        // El modelo va a repetir esta cifra al cliente: tiene que tener fuente en el turno.
        sesion.fuentes.push(sugerencia);
        return sugerencia;
      }
    }
    const nota = armarNota({
      ...comunes,
      totalLinea: `Total: ${formatoUsd(resultado.totalUsd)} BCV (envío gratis con Cashea)`,
      falta: "enviarle el link de Cashea",
    });
    return pasarACaso(deps, {
      mensaje: resultado.mensaje,
      carrito,
      nota,
      estado: {
        lineas: lineasFusionadas,
        forma: entrada.formaDePago,
        entrega: entrada.entrega,
        ciudad,
        totalUsd: resultado.totalUsd,
        totalBs: resultado.totalBs,
        priceKind,
      },
    });
  }

  // pasar_a_ventas: sin montos, con la razón en la nota.
  const nota = armarNota({
    ...comunes,
    totalLinea: "Total: sin calcular (el cliente no recibió montos)",
    falta: queFalta(resultado.razon, resultado.detalle, etiquetaForma),
  });
  return pasarACaso(deps, {
    mensaje: resultado.mensaje,
    carrito,
    nota,
    estado: {
      lineas: lineasFusionadas,
      forma: entrada.formaDePago,
      entrega: entrada.entrega,
      ciudad,
      totalUsd: null,
      totalBs: null,
      priceKind,
    },
  });
}

/** La instrucción para el modelo si falta poco para el mínimo o para las seis cuotas; `null` si no hay nada que sugerir. */
function sugerenciaDeComplemento(r: Extract<ResultadoPedido, { tipo: "cashea" }>): string | null {
  if (r.faltaParaMinimoUsd !== null) {
    return `Al pedido le faltan ${formatoUsd(r.faltaParaMinimoUsd)} para la compra mínima de Cashea. Dilo en una línea y sugiere UNA vez agregar algo o pagar de contado. No des cifras de cuotas.`;
  }
  const seis = r.faltaParaSeisCuotasUsd;
  if (seis !== null && seis >= 0.01 && seis <= COMPLEMENTO_SEIS_CUOTAS_MAX_USD) {
    return `Al pedido le faltan ${formatoUsd(seis)} para acceder a seis cuotas. Dilo en una línea y sugiere UNA vez agregar algo. No des cifras de cuotas.`;
  }
  return null;
}

async function enviarDatosDePago(
  deps: DepsDePrepararPago,
  r: Extract<ResultadoPedido, { tipo: "datos_de_pago" }>,
  carrito: LineaDeCarrito[],
  pedido: Pick<EstadoSeba, "lineas" | "forma" | "entrega" | "ciudad">,
): Promise<string> {
  const { effects, sesion } = deps;
  await effects.guardarCarrito(carrito);
  const envio = await effects.enviarTexto(r.mensaje, "herramienta");
  if (!envio.ok) return ENVIO_FALLIDO;

  sesion.estado = estadoNuevo(sesion, "datos_enviados", {
    ...pedido,
    totalUsd: r.totalUsd,
    totalBs: r.totalBs,
    priceKind: r.priceKind,
  });
  return finalizar(sesion, r.mensaje, carrito, ENVIADO_DATOS_DE_PAGO);
}

/** Estado nuevo (el objeto se REEMPLAZA, no se muta campo a campo). */
function estadoNuevo(sesion: SesionDeTurno, etapa: EstadoSeba["etapa"], campos: Partial<EstadoSeba>): EstadoSeba {
  return { ...sesion.estado, ...campos, etapa, actualizadoEn: sesion.ahora.toISOString() };
}

function finalizar(
  sesion: SesionDeTurno,
  mensaje: string,
  lineas: { productId: string }[],
  devuelto: string,
): string {
  sesion.fuentes.push(mensaje);
  for (const l of lineas) sesion.productos.add(l.productId);
  sesion.terminado = true;
  return devuelto;
}

/**
 * Envía el resumen y le pasa el caso a ventas (Cashea y todo pase sin montos).
 * Orden fijo: carrito → texto → pase → línea de tienda cerrada; el estado y
 * `terminado` solo se tocan cuando todo salió bien.
 */
async function pasarACaso(
  deps: DepsDePrepararPago,
  p: {
    mensaje: string;
    carrito: LineaDeCarrito[];
    nota: string;
    estado: Partial<EstadoSeba>;
  },
): Promise<string> {
  const { effects, sesion } = deps;
  await effects.guardarCarrito(p.carrito);
  const envio = await effects.enviarTexto(p.mensaje, "herramienta");
  if (!envio.ok) return ENVIO_FALLIDO;

  let pase;
  try {
    pase = await effects.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: p.nota });
  } catch (error) {
    // El resumen ya salió pero el caso no quedó con nadie: el turno decide qué hacer (no se reintenta aquí).
    sesion.terminado = true;
    throw error;
  }

  if (!pase.abierta && pase.cuandoAbre) {
    await effects.enviarTexto(lineaTiendaCerrada(pase.cuandoAbre), "fijo");
  }

  sesion.paso = { area: "ventas", motivo: "listo_para_comprar" };
  sesion.estado = estadoNuevo(sesion, "con_asesor", p.estado);
  return finalizar(sesion, p.mensaje, p.carrito, ENVIADO_Y_PASADO);
}

export function buildPrepararPagoTool(deps: DepsDePrepararPago) {
  const formasActivas = deps.metodos.filter((m) => m.isActive).map((m) => m.key);
  return tool({
    description:
      "Arma el pedido del cliente y le envía el resumen con el total (y los datos de pago, si aplica). Llámala UNA vez, cuando el cliente ya aceptó el producto y dijo cómo va a pagar y cómo lo quiere recibir (envío, retiro en tienda o delivery). El total y los datos de pago los escribe el sistema: NO escribas montos, cuentas ni datos de pago por tu cuenta, ni antes ni después de llamarla. Con envío necesitas la ciudad; si falta, pregúntala antes. Solo puedes pedir productos que ya cotizaste en esta conversación.",
    inputSchema: z.object({
      lineas: z
        .array(
          z.object({
            productId: z.string().uuid().describe("El id del producto, tal como lo devolvió buscarRepuesto."),
            cantidad: z.number().int().min(1).max(20).describe("Unidades que lleva el cliente."),
          }),
        )
        .min(1)
        .max(15),
      formaDePago: z
        .enum(["cashea", ...formasActivas] as [string, ...string[]])
        .describe("La forma de pago que eligió el cliente: cashea o la clave de una forma de contado."),
      entrega: z.enum(ENTREGAS).describe("Cómo recibe el pedido: envio, retiro (en tienda) o delivery."),
      ciudad: z.string().max(60).optional().describe("Ciudad de destino. Obligatoria si la entrega es envio."),
    }),
    execute: async (entrada) => ejecutarPrepararPago(deps, entrada),
  });
}
