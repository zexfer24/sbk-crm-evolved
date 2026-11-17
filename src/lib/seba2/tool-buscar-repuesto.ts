import { tool } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  PREGUNTA_QUE_BUSCA_INSTRUCTION,
  buildCatalogTool,
  type AvisoCatalogo,
  type CatalogOutcome,
  type LineaCotizada,
  type PersistenciaDeCatalogo,
} from "@/lib/ai/tools";
import { errorText, log } from "@/lib/log";
import type { SesionDeTurno } from "./sesion";

// ---------------------------------------------------------------------------
// `buscarRepuesto` de Seba v2 (S8b, 17/11/2026, entrega 3 del rework de Seba).
//
// La BÚSQUEDA es la de v1, sin tocarla (`buildCatalogTool`: orden y conteos en
// SQL, corrector de tipeos, memoria del pedido, avisos). Lo que cambia es lo
// que le llega al MODELO:
//
//   1. Las instrucciones de v1 le dicen «escale con confirmar_inventario» con
//      la herramienta `escalarAAsesor`, porque en v1 toda cotización termina
//      con un asesor. En v2 no: Seba v2 vende hasta el comprobante, no tiene
//      esa herramienta sino `pasarAAsesor` con otros motivos (`MOTIVOS_V2`).
//      Dejarle la instrucción de v1 lo empujaría a llamar a una herramienta
//      que no existe o a prometer un asesor que nadie pidió.
//   2. El guion de v2 manda «El sistema arma y envía la cotización con el
//      nombre exacto, el precio y la foto si existe. No reescribas nombres ni
//      precios» y «Nunca digas cuántas unidades hay». Si el modelo ve el precio
//      y el stock en la salida, termina copiándolos o redondeándolos: por eso
//      la salida de esta herramienta no trae ninguno de los dos. Los precios
//      siguen existiendo, pero en `sesion.fuentes` (la fuente de las cifras que
//      dejan pasar las guardas de salida) y en el bloque que arma el código
//      (`armarCotizacion` con `existencia: "sin_cantidad"`).
//
// Esta herramienta NO envía nada al cliente: el turno arma la salida.
// ---------------------------------------------------------------------------

export const NOMBRE_BUSCAR_REPUESTO = "buscarRepuesto";

export interface DepsDeBusqueda {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  contactId: string;
  /** Lo que el cliente escribió en la ráfaga que se está respondiendo (la más vieja primero). */
  rafaga: string[];
  persistencia: PersistenciaDeCatalogo;
  sesion: SesionDeTurno;
  /** El acumulado del turno que `buildCatalogTool` va llenando. */
  catalogOutcome: CatalogOutcome;
  /** Para tests: por defecto `buildCatalogTool`. */
  construir?: typeof buildCatalogTool;
}

/** Un producto que la herramienta le muestra al modelo: sin precio y sin cantidad. */
export interface ProductoParaElModelo {
  productId: string;
  nombre: string;
  disponible: boolean;
  /** `stock === 1`: la única forma en que Seba v2 puede decir «es el último». */
  ultimaUnidad: boolean;
  /** Es la UNA alternativa que se ofrece porque la variante pedida está agotada. */
  esAlternativa: boolean;
}

export interface SalidaDeBusquedaV2 {
  productos: ProductoParaElModelo[];
  instruccionParaTuRespuesta: string;
}

export type CasoDeBusqueda =
  | "con_existencia"
  | "agotado"
  | "pregunta_moto"
  | "pregunta_producto"
  | "sin_calce"
  | "no_encontrado"
  | "no_nombro_producto"
  | "error";

/** Cuánto llevaba el `CatalogOutcome` antes de la llamada: para saber qué trajo ESTA. */
export interface FotoDelOutcome {
  lineas: number;
  consultas: number;
  avisos: number;
  preguntaFiltro: CatalogOutcome["preguntaFiltro"];
  motivoForzado: CatalogOutcome["motivoForzado"];
}

export function fotoDelOutcome(outcome: CatalogOutcome): FotoDelOutcome {
  return {
    lineas: outcome.cotizacion.length,
    consultas: outcome.consultas.length,
    avisos: outcome.avisos.length,
    preguntaFiltro: outcome.preguntaFiltro,
    motivoForzado: outcome.motivoForzado,
  };
}

function tieneError(salidaV1: unknown): boolean {
  return typeof salidaV1 === "object" && salidaV1 !== null && "error" in salidaV1 && Boolean(salidaV1.error);
}

function esPreguntaQueBusca(salidaV1: unknown): boolean {
  return (
    typeof salidaV1 === "object" &&
    salidaV1 !== null &&
    "instruccionParaTuRespuesta" in salidaV1 &&
    salidaV1.instruccionParaTuRespuesta === PREGUNTA_QUE_BUSCA_INSTRUCTION
  );
}

/**
 * Qué pasó en ESTA llamada. `buildCatalogTool` ACUMULA en el outcome durante
 * todo el turno (la pregunta de filtro, por ejemplo, nunca se borra), así que
 * se compara contra la foto de antes de la llamada y solo cuenta lo nuevo.
 * Precedencia: error > con existencia > agotado > pregunta de filtro >
 * sin calce > no nombró producto > no encontrado.
 *
 * La pregunta de filtro es de ESTA llamada cuando hubo una consulta NUEVA que
 * terminó `generico` y `preguntaFiltro` sigue puesta: un genérico que NO
 * pregunta (moto sin calce, «varias opciones» de una lista) también termina
 * `generico`, pero deja un aviso `moto_sin_calce`/`varias_opciones` en el
 * outcome o un `motivoForzado` recién puesto; una consulta que sí pregunta no
 * deja ninguno de los dos (v1 no registra sus avisos).
 */
export function casoDeLaLlamada(
  antes: FotoDelOutcome,
  despues: CatalogOutcome,
  salidaV1: unknown,
): { caso: CasoDeBusqueda; lineas: LineaCotizada[]; avisos: AvisoCatalogo[] } {
  const lineas = despues.cotizacion.slice(antes.lineas);
  const avisos = despues.avisos.slice(antes.avisos);
  const consultas = despues.consultas.slice(antes.consultas);
  const resultado = (caso: CasoDeBusqueda) => ({ caso, lineas, avisos });

  if (tieneError(salidaV1)) return resultado("error");
  if (lineas.some((l) => l.stock > 0)) return resultado("con_existencia");
  if (lineas.length > 0) return resultado("agotado");

  const motivoNuevo = despues.motivoForzado !== null && antes.motivoForzado === null;
  const sinCalce = avisos.some((a) => a.tipo === "moto_sin_calce");
  const itemSinCotizar = avisos.some((a) => a.tipo === "varias_opciones");
  const hayGenerico = consultas.some((c) => c.resultado === "generico");
  if (hayGenerico && despues.preguntaFiltro !== null && !sinCalce && !itemSinCotizar && !motivoNuevo) {
    return resultado(despues.preguntaFiltro === "moto" ? "pregunta_moto" : "pregunta_producto");
  }

  if (sinCalce || motivoNuevo) return resultado("sin_calce");
  if (esPreguntaQueBusca(salidaV1)) return resultado("no_nombro_producto");
  return resultado("no_encontrado");
}

const BASE_CON_EXISTENCIA =
  "El sistema ya le envía al cliente la cotización con el nombre exacto y el precio: no repitas nombres ni precios ni digas cuántas unidades hay. Escribe UNA línea corta: pregúntale si lo quiere llevar y cómo prefiere pagar, con Cashea o de contado.";

/**
 * La instrucción de v2 para ese caso: texto para el MODELO, nunca para el
 * cliente. Ninguna nombra `escalarAAsesor`, `confirmar_inventario` ni cifras, y
 * todo motivo que cita existe en `MOTIVOS_V2` (un test lo extrae con una regex:
 * si se escribe uno nuevo, tiene que seguir la forma «el motivo <nombre>»).
 */
export function instruccionV2(caso: CasoDeBusqueda, lineas: LineaCotizada[], avisos: AvisoCatalogo[]): string {
  switch (caso) {
    case "con_existencia": {
      const partes = [BASE_CON_EXISTENCIA];
      if (lineas.some((l) => l.esAlternativa === true)) {
        partes.push("La variante que pidió está agotada y lo cotizado es otra opción: dilo.");
      }
      if (lineas.some((l) => l.stock === 1)) partes.push("Es la última unidad: puedes decirlo.");
      if (avisos.some((a) => a.tipo === "universales" || a.tipo === "relajado")) {
        partes.push(
          "No está confirmado que sea exactamente lo que pidió o que le sirva a su moto: no afirmes compatibilidad; si la necesita confirmada, pasa el caso con el motivo consulta_tecnica.",
        );
      }
      if (lineas.some((l) => l.stock <= 0) || avisos.some((a) => a.tipo === "varias_opciones")) {
        partes.push("El sistema marca en la lista lo agotado y lo que no se encontró: no lo repitas.");
      }
      return partes.join(" ");
    }
    case "agotado":
      return "Está agotado y el sistema se lo dice al cliente. Escribe UNA línea: ofrécele buscar otra opción. No des fecha de reposición ni prometas avisar; si pide que le avisen, pasa el caso con el motivo apartado_o_aviso.";
    case "pregunta_moto":
      return "Hay varias opciones y depende de la moto. Pregunta en UNA línea el modelo y el año de la moto. No afirmes existencia ni precio todavía.";
    case "pregunta_producto":
      return "Hay varias opciones. Pregunta en UNA línea el dato que las distingue (marca, medida, talla o modelo). No afirmes existencia ni precio todavía.";
    case "sin_calce":
      return "El inventario no confirma uno para su moto. No cotices ni afirmes compatibilidad: pasa el caso con el motivo consulta_tecnica y cuenta en la nota qué pidió y para qué moto.";
    case "no_nombro_producto":
      return "El cliente no nombró ningún producto: pregúntale en UNA línea qué busca.";
    case "no_encontrado":
      return "No se encontró en el inventario. Si todavía no le pediste el dato que falta (el producto exacto, la moto o la medida), pídelo en UNA línea; si ya lo pediste, pasa el caso con el motivo no_identificado.";
    case "error":
      return "No se pudo consultar el inventario. No afirmes existencia ni precio: pasa el caso con el motivo no_identificado y cuenta en la nota qué pidió.";
  }
}

const DESCRIPCION_V2 =
  "Busca en el inventario real de la tienda por nombre, marca o medida del repuesto o accesorio, y ordena primero lo que sirve para la moto del cliente. Úsala SIEMPRE antes de afirmar que hay algo o de dar un precio: no lo inventes ni lo digas de memoria. Si el cliente pide VARIOS productos en el mismo mensaje, llámala UNA sola vez con `productos` (hasta 5). Si el cliente contesta solo con un dato suelto (una talla, una medida, un color), llámala con ese dato: el sistema lo combina con lo que pidió antes. Devuelve los productos encontrados sin precio ni cantidad (el sistema se los envía al cliente) y una instrucción de qué hacer con tu respuesta.";

/** `execute` puede devolver el valor, una promesa o un iterable asíncrono (el último valor es el resultado). */
async function resolverSalida(valor: unknown): Promise<unknown> {
  if (typeof valor === "object" && valor !== null && Symbol.asyncIterator in valor) {
    let ultimo: unknown;
    for await (const parcial of valor as AsyncIterable<unknown>) ultimo = parcial;
    return ultimo;
  }
  return valor;
}

export function buildBuscarRepuestoV2(deps: DepsDeBusqueda) {
  const { sesion, catalogOutcome } = deps;
  const construir = deps.construir ?? buildCatalogTool;
  const v1 = construir(
    {
      supabase: deps.supabase,
      conversationId: deps.conversationId,
      contactId: deps.contactId,
      persistencia: deps.persistencia,
      rafagaCliente: deps.rafaga,
    },
    catalogOutcome,
  );

  return tool({
    description: DESCRIPCION_V2,
    // El MISMO esquema de v1 (misma referencia): el modelo manda lo de siempre.
    inputSchema: v1.inputSchema,
    execute: async (entrada, opciones): Promise<SalidaDeBusquedaV2> => {
      sesion.herramientas.push(NOMBRE_BUSCAR_REPUESTO);
      const antes = fotoDelOutcome(catalogOutcome);

      let salidaV1: unknown;
      try {
        salidaV1 = await resolverSalida(await v1.execute!(entrada, opciones));
      } catch (error) {
        // No se relanza: el modelo recibe la instrucción de no afirmar nada y
        // de pasar el caso, en vez de que el turno reviente a mitad de la charla.
        log.warn("seba2_busqueda_fallida", { conversationId: deps.conversationId, detail: errorText(error) });
        return { productos: [], instruccionParaTuRespuesta: instruccionV2("error", [], []) };
      }

      const { caso, lineas, avisos } = casoDeLaLlamada(antes, catalogOutcome, salidaV1);

      for (const linea of lineas) sesion.productos.add(linea.productId);
      // La salida de v1 trae los precios: es la fuente de las cifras del turno.
      sesion.fuentes.push(JSON.stringify(salidaV1));

      return {
        productos: lineas.map((l) => ({
          productId: l.productId,
          nombre: l.nombre,
          disponible: l.stock > 0,
          ultimaUnidad: l.stock === 1,
          esAlternativa: l.esAlternativa === true,
        })),
        instruccionParaTuRespuesta: instruccionV2(caso, lineas, avisos),
      };
    },
  });
}
