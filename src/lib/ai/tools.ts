import "server-only";
import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { BUSINESS_NAME } from "@/lib/brand";
import { getBcvRate } from "@/lib/ai/bcv";
import { catalogFilter, rankByTerms, searchTerms } from "@/lib/ai/catalog-search";
import { formatQuote } from "@/lib/ai/precio";
import { RECLAMO_CATEGORIES, escalateConversation, type EscalationMotivo } from "@/lib/ai/escalate";
import { inventoryAgeInstruction, inventoryFreshness } from "@/lib/inventory-freshness";
import { errorText, log } from "@/lib/log";
import type { BusinessHours, BusinessStatus } from "@/lib/business-hours";

/**
 * Tope de repuestos que se le pasan al modelo de una vez.
 *
 * Sin tope, un término genérico —«repuesto», «moto», «aceite»— metía el
 * catálogo entero en el contexto, con precios, stock y compatibilidades de
 * cada producto, y se repetía en cada paso del tool loop.
 *
 * Diez no es solo por costo: nadie lee veinticinco repuestos en un mensaje de
 * WhatsApp. Si hay más, conviene que la IA pida precisar antes que enumerar.
 */
const MAX_CATALOG_RESULTS = 10;

/**
 * Cuántas filas se le piden a la base antes de ordenar.
 *
 * La consulta une los términos con OR, así que trae de más a propósito:
 * "bujía NGK" calza tanto la bujía de NGK como cualquier otra bujía. Se
 * ordena por cuántos términos calzan y recién ahí se recorta a diez, para
 * que el recorte no se lleve por delante justo el que el cliente buscaba.
 */
const CATALOG_FETCH_LIMIT = MAX_CATALOG_RESULTS * 3 + 1;

/**
 * Se le dice en palabras qué hacer con el recorte: si no, el modelo enumera
 * los que le llegaron como si fueran todo el catálogo.
 */
const RECORTE_INSTRUCTION =
  "Hay más resultados de los que caben acá. Muestra estos y pídele al cliente que precise (marca del repuesto, modelo de su moto) en vez de dar a entender que esto es todo lo que hay.";

/**
 * Un repuesto activo en cero se sigue cotizando —el cliente pregunta por el
 * precio igual— pero no se ofrece como disponible. La regla ya está en el
 * prompt; acá viaja pegada al resultado, que es lo que el modelo tiene
 * delante en el momento de redactar.
 */
const SIN_STOCK_INSTRUCTION =
  "Alguno de estos repuestos está en cero: de ese NO digas que hay ni lo ofrezcas como disponible. Dilo claro y ofrece pasarle el caso a un asesor por si viene reposición.";

/** El `updated_at` más viejo del grupo, o null si ninguna fila trae fecha. */
function oldestUpdate(rows: { updated_at?: string | null }[]): string | null {
  const fechas = rows.map((row) => row.updated_at).filter((fecha): fecha is string => Boolean(fecha));
  return fechas.length === 0 ? null : fechas.reduce((viejo, fecha) => (fecha < viejo ? fecha : viejo));
}

interface ToolDeps {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  contactId: string;
  /**
   * Horario de la tienda (Frente B4, "El reloj dice la verdad", 5/9/2026):
   * solo lo usa `buildEscalateTool` para saber cuándo prometer que un asesor
   * escribe. Opcional porque el resto de las herramientas no lo necesitan y
   * `escalateConversation` ya tiene su propio default si llega `undefined`.
   */
  businessHours?: BusinessHours;
  /** Inyectable en tests; en producción usa el reloj real. */
  now?: Date;
}

/** Se llena cuando el turno escala, para que el orquestador sepa qué pasó sin volver a tocar la base de datos. */
export interface EscalationOutcome {
  escalated: boolean;
  motivo?: EscalationMotivo;
  assignedAgentName?: string;
  reason?: string;
  /**
   * La escalación quedó sin ningún asesor disponible (anexo A1, 5/9/2026).
   * Hasta el 14/9/2026 el orquestador la usaba para decidir si el mensaje
   * final es una despedida sin nadie detrás —`isAutoReply: true` en
   * `sendAgentText`—; desde la Tarea 5 ("La voz cercana y la espera
   * visible") la promesa de un asesor TAMPOCO es una respuesta real (170
   * promesas ≥ 30 min sin cumplir, 23 de ellas nunca atendidas, medidas en
   * la auditoría de esa tarea), así que `isAutoReply` pasó a depender solo
   * de `escalated` — este campo se sigue usando para elegir QUÉ despedida
   * fija mandar (`DESPEDIDA_SIN_ASESOR` vs. `despedidaConAsesor`, agent.ts).
   */
  unassigned?: boolean;
  /**
   * El horario de la tienda en el momento de escalar (Tarea 5, 14/9/2026):
   * `escalateConversation` lo calcula siempre (ver escalate.ts) y viaja acá
   * para que la despedida fija CON asesor (`despedidaConAsesor`, agent.ts) y
   * la instrucción que lee el modelo (`escalationInstruction`, este
   * archivo) usen el MISMO reloj — nunca uno recalculado después, que podría
   * cruzar el borde de la hora de cierre entre el escalamiento y el envío.
   */
  businessStatus?: BusinessStatus;
}

// ---------------------------------------------------------------------------
// Buscar repuesto — consulta_disponibilidad / otro. Solo lectura.
// ---------------------------------------------------------------------------
export function buildCatalogTool({ supabase, conversationId }: ToolDeps) {
  return tool({
    description:
      `Busca repuestos en el catálogo real de ${BUSINESS_NAME} por nombre o marca del repuesto, y opcionalmente filtra por marca/modelo de la moto del cliente. Devuelve precio en USD y Bs (tasa BCV del día) y el stock disponible. Si no devuelve nada, ese repuesto no existe en el catálogo — no te lo inventes.`,
    inputSchema: z.object({
      query: z.string().describe("Qué repuesto busca el cliente, ej. 'carburador', 'bujía NGK', 'kit de arrastre'"),
      motoBrand: z.string().optional().describe("Marca de la moto del cliente, si la mencionó (ej. 'Bera')"),
      motoModel: z.string().optional().describe("Modelo de la moto del cliente, si lo mencionó (ej. 'SBR 200')"),
    }),
    execute: async ({ query, motoBrand, motoModel }) => {
      // Palabra por palabra y sin acentos: buscar la frase completa hacía que
      // "bujía NGK" no encontrara la Bujía CR7HSA de NGK, y el agente
      // respondiera con toda seguridad que no la tenemos. Ver catalog-search.ts.
      const terms = searchTerms(query);
      if (terms.length === 0) return { results: [] };

      // `query` lo redacta el modelo a partir de lo que escribe el cliente:
      // es entrada no confiable y el filtro `.or()` es un mini-lenguaje, no
      // una cadena inerte. Sin entrecomillar, una coma en el texto agrega
      // condiciones a la consulta (lo hace catalogFilter).
      const { data: products, error } = await supabase
        .from("products")
        .select(
          "id, name, brand, price, currency, stock_quantity, updated_at, search_text, product_compatibility(moto_brand, moto_model)"
        )
        .eq("is_active", true)
        .or(catalogFilter(terms))
        .limit(CATALOG_FETCH_LIMIT);

      if (error) {
        // D3 (6/9/2026): antes este error se tragaba en silencio. El 5/9/2026
        // se buscó en vano el rastro de un "catálogo fuera de servicio" que
        // resultó ser el interruptor por herramienta apagado, pero la
        // búsqueda fue a ciegas porque un error real de la base tampoco
        // habría dejado nada en el log del servidor.
        log.error("herramienta_catalogo_fallo", { conversationId, detail: errorText(error) });
        return { results: [], error: "No se pudo consultar el catálogo en este momento." };
      }

      const ranked = rankByTerms(products ?? [], terms);
      const hayMas = ranked.length > MAX_CATALOG_RESULTS;

      let filtered = ranked.slice(0, MAX_CATALOG_RESULTS);
      if (motoBrand) {
        filtered = filtered.filter(
          (p) =>
            p.product_compatibility.length === 0 ||
            p.product_compatibility.some((c) => c.moto_brand.toLowerCase().includes(motoBrand.toLowerCase()))
        );
      }
      if (motoModel) {
        filtered = filtered.filter(
          (p) =>
            p.product_compatibility.length === 0 ||
            p.product_compatibility.some((c) => c.moto_model.toLowerCase().includes(motoModel.toLowerCase()))
        );
      }

      const { rate, isStale } = await getBcvRate(supabase);

      const quoted = filtered.map((p) => ({
        id: p.id,
        nombre: p.name,
        marca: p.brand,
        precioUsd: p.currency === "USD" ? p.price : Number((p.price / rate).toFixed(2)),
        precioBs: p.currency === "USD" ? Number((p.price * rate).toFixed(2)) : p.price,
        stock: p.stock_quantity,
        compatibleCon: p.product_compatibility.map((c) => `${c.moto_brand} ${c.moto_model}`),
      }));

      // La antigüedad se mide por el repuesto MÁS VIEJO de los que se están
      // cotizando: la respuesta es tan confiable como el peor dato que lleva
      // dentro. Quedarse con el más reciente dejaría pasar justo el que puede
      // estar vendido.
      const freshness = inventoryFreshness(oldestUpdate(filtered));
      if (freshness.isStale) {
        // El mismo aviso que el del BCV y por la misma razón: una función
        // degradada que no se nota es peor que una que falla. Sin esta línea,
        // "el inventario lleva días congelado" solo se ve consultando la base.
        log.warn("inventario_desactualizado", {
          conversationId,
          dias: freshness.ageDays,
          desde: freshness.updatedAt,
        });
      }

      // Las advertencias se juntan en una sola instrucción: el modelo lee una
      // frase, no un formulario. Van primero las que limitan lo que puede
      // prometer y de última la del recorte, que es de forma.
      const instrucciones = [
        quoted.some((q) => q.stock <= 0) ? SIN_STOCK_INSTRUCTION : null,
        inventoryAgeInstruction(freshness),
        hayMas ? RECORTE_INSTRUCTION : null,
      ].filter((linea): linea is string => linea !== null);

      // El monto de una venta sale de lo que se cotizó acá, no de un número
      // que el agente escriba a mano al cerrar -- por eso se deja registro
      // de cada resultado que el modelo efectivamente vio, con el precio
      // exacto en el momento de la cotización.
      if (quoted.length > 0) {
        await supabase.from("conversation_quotes").insert(
          quoted.map((q) => ({
            conversation_id: conversationId,
            product_id: q.id,
            product_name: q.nombre,
            price_usd: q.precioUsd,
            price_bs: q.precioBs,
            bcv_rate: rate,
          }))
        );
      }

      return {
        // El precio va como texto ya escrito y los números crudos se quedan
        // acá. Convertir o reformatear un número es aritmética, y es donde
        // los modelos alucinan; sin el número no hay nada que calcular.
        results: quoted.map((q) => ({
          nombre: q.nombre,
          marca: q.marca,
          precio: formatQuote(q.precioUsd, q.precioBs),
          stock: q.stock,
          compatibleCon: q.compatibleCon,
        })),
        tasaBcvUsada: rate,
        tasaDesactualizada: isStale,
        inventarioDesactualizado: freshness.isStale,
        hayMas,
        ...(instrucciones.length > 0 ? { instruccionParaTuRespuesta: instrucciones.join(" ") } : {}),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Historial de compras — devolucion. Solo lectura: no hay forma de aprobar,
// rechazar ni modificar nada desde esta herramienta.
// ---------------------------------------------------------------------------
export function buildOrderHistoryTool({ supabase, contactId, conversationId }: ToolDeps) {
  return tool({
    description:
      "Consulta el historial real de compras del cliente (qué compró, cuándo, cuánto pagó). Solo lectura: úsala para armar contexto, nunca para aprobar ni procesar una devolución.",
    inputSchema: z.object({}),
    execute: async () => {
      const { data: orders, error } = await supabase
        .from("orders")
        .select("id, purchased_at, total_amount, currency, order_items(description, quantity, unit_price)")
        .eq("contact_id", contactId)
        .order("purchased_at", { ascending: false })
        .limit(10);

      if (error) {
        // D3 (6/9/2026): mismo rastro que la herramienta de catálogo, misma
        // historia (ver el comentario de arriba en `buildCatalogTool`).
        log.error("herramienta_historial_fallo", { conversationId, detail: errorText(error) });
        return { orders: [], error: "No se pudo consultar el historial de compras." };
      }

      return {
        orders: (orders ?? []).map((o) => ({
          fecha: o.purchased_at,
          total: o.total_amount,
          moneda: o.currency,
          items: o.order_items.map((i) => ({
            descripcion: i.description,
            cantidad: i.quantity,
            precioUnitario: i.unit_price,
          })),
        })),
      };
    },
  });
}

/**
 * La instrucción con la que el modelo redacta la despedida al escalar, con o
 * sin asesor asignado.
 *
 * Nace en el Frente B4 ("El reloj dice la verdad", 5/9/2026) cubriendo solo
 * el caso SIN asesor: hasta ahí la IA no sabía si la tienda estaba abierta,
 * así que no podía decir cuándo la iban a atender sin arriesgarse a prometer
 * un plazo falso ("ya te atienden" a las 2 am de un domingo). La Tarea 5
 * ("La voz cercana y la espera visible", 14/9/2026) encontró la MISMA falla
 * del lado CON asesor —170 promesas "ya te paso con un asesor" en 72 h, 23
 * con la tienda ya cerrada y sin decir cuándo— y la cerró acá, renombrando la
 * función (antes `unassignedEscalationInstruction`) porque dejó de ser
 * exclusiva del caso sin asesor.
 *
 * Con `businessStatus` ya calculado por `escalateConversation` (mismo
 * `now`/horario que dejó el evento de sistema, SIEMPRE presente desde la
 * Tarea 5 — ver escalate.ts), acá solo se traduce a prosa, en las cuatro
 * combinaciones de asesor × horario:
 * - con asesor, abierta: cálida, sin horario ("un asesor toma su caso").
 * - con asesor, cerrada: agradece la paciencia y nombra cuándo escribe el
 *   asesor (día y hora exactos, o "apenas la tienda vuelva a abrir" si no hay
 *   ninguna franja en los próximos 7 días).
 * - sin asesor, abierta: promete "en breve", que sí es cierto porque hay
 *   quién conteste hoy.
 * - sin asesor, cerrada: mismo criterio de B4, con o sin próxima apertura.
 *
 * Tarea 3 ("La voz cercana y la espera visible", 14/9/2026): hasta acá solo
 * la rama "con asesor, cerrada" llevaba calidez explícita ("dile con
 * calidez..."); las otras tres decían el hecho seco ("un asesor lo va a
 * atender", "su caso quedó registrado") sin agradecer ni suavizar. Las
 * cuatro ramas reciben ahora el mismo trato: agradecer la espera o la
 * paciencia, y nombrar con calidez lo que va a pasar.
 *
 * Corrección del 15/9/2026 (verificación final de "La voz de mostrador con
 * nombre propio y el cierre de v1.1"): un chat NUEVO ("buenas tardes,
 * tienen tanque de EK Xpress") no encontró stock, escaló por
 * `escalarAAsesor` (motivo `seguimiento`) y la redacción final salió SIN el
 * saludo de franja que `needsGreeting` pedía en el sufijo de `prompt.ts` —el
 * modelo obedece la ÚLTIMA instrucción que lee, y esta no mencionaba el
 * saludo, así que se lo comía. Las cuatro ramas terminan ahora con
 * `RECORDATORIO_SALUDO` para que el saludo del primer mensaje sobreviva
 * también cuando el turno termina en una escalada.
 */
export const RECORDATORIO_SALUDO =
  " Si este es el primer mensaje que recibe de nosotros (TURNO ACTUAL te lo dice), abre igual con el saludo exacto que te dio antes de esta promesa; si no, no saludes.";

function escalationInstruction(status: BusinessStatus | undefined, assignedName: string | null): string {
  const abierta = !status || status.open;

  if (assignedName) {
    if (abierta) {
      return `Ya está asignado a ${assignedName}. Dile al cliente, con calidez, que un asesor toma su caso y le escribe por acá; agradécele la espera.${RECORDATORIO_SALUDO}`;
    }
    const cuando = status?.nextOpening
      ? `${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}`
      : "apenas la tienda vuelva a abrir";
    return `Ya está asignado a ${assignedName}, pero la tienda está cerrada. Dile al cliente, con calidez, que un asesor toma su caso y le escribe ${cuando}; agradécele la paciencia. NO prometas que lo atienden ahora.${RECORDATORIO_SALUDO}`;
  }

  if (abierta) {
    return `No hay ningún asesor conectado ahora. Dile al cliente, con calidez, que su caso quedó registrado y que le escriben en breve, apenas haya alguien disponible; agradécele la espera. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
  }

  if (!status?.nextOpening) {
    return `No hay ningún asesor conectado ahora y la tienda está cerrada. Dile al cliente, con calidez, que su caso quedó registrado y que le escriben apenas la tienda vuelva a abrir; agradécele la paciencia. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
  }

  return `No hay ningún asesor conectado ahora y la tienda está cerrada. Dile al cliente, con calidez, que su caso quedó registrado y que un asesor le escribe ${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}; agradécele la paciencia. NO prometas que lo atienden enseguida.${RECORDATORIO_SALUDO}`;
}

// ---------------------------------------------------------------------------
// Escalar a un asesor — devolucion, queja, e intención de compra dentro de
// consulta_disponibilidad. Única forma de tocar dinero o cerrar un caso: la
// IA nunca aprueba, rechaza ni cierra nada por su cuenta.
// ---------------------------------------------------------------------------
export function buildEscalateTool(
  { supabase, conversationId, contactId, businessHours, now }: ToolDeps,
  outcome: EscalationOutcome
) {
  return tool({
    description:
      "Escala la conversación a un asesor de la tienda: pausa la IA, asigna al asesor con más tiempo sin recibir un cliente nuevo, y deja un resumen para que no tenga que volver a preguntar todo. Es la única forma de tocar dinero real (devoluciones, ventas) o reclamos — la IA nunca los resuelve sola.",
    inputSchema: z.object({
      // Tarea 7 ("El guion atiende a quien no es cliente…", 14/9/2026): suma
      // `seguimiento` (ya admitido por `EscalationMotivo` en escalate.ts,
      // que no tuvo que tocarse) para el aviso de reposición de un repuesto
      // agotado, las listas largas o de mayoreo, y la postventa en general —
      // casos que no son ni una devolución, ni una queja, ni una venta en
      // curso, y que hasta ahora no tenían dónde caer sin forzar uno de los
      // otros tres motivos.
      motivo: z
        .enum(["devolucion", "queja", "intencion_compra", "seguimiento"])
        .describe(
          "Por qué se escala: devolucion (quiere devolver o cambiar algo que ya compró), queja (reclamo), intencion_compra (quiere comprar y hay que cobrarle), seguimiento (avisar cuando llegue un repuesto agotado, una lista larga o de mayoreo, o cualquier postventa que no sea devolución ni queja)."
        ),
      resumen: z
        .string()
        .describe("Resumen para el asesor: qué quiere el cliente, qué compró si aplica, y por qué se escala."),
      categoriaReclamo: z
        .enum(RECLAMO_CATEGORIES)
        .optional()
        .describe("Solo si motivo='queja': la categoría que mejor describe el reclamo."),
    }),
    execute: async ({ motivo, resumen, categoriaReclamo }) => {
      const result = await escalateConversation(supabase, {
        conversationId,
        contactId,
        motivo,
        resumen,
        categoriaReclamo,
        businessHours,
        now,
      });

      outcome.escalated = result.escalated;
      outcome.motivo = motivo;
      outcome.assignedAgentName = result.assignedAgentName ?? undefined;
      outcome.reason = result.reason;
      outcome.unassigned = result.unassigned;
      outcome.businessStatus = result.businessStatus;

      // El modelo redacta el cierre con esto, así que se le dice en palabras
      // qué prometer: ni con asesor ni sin él puede decir «ya te atienden»
      // sin saber si la tienda está abierta (Tarea 5, 14/9/2026).
      return {
        ...result,
        instruccionParaTuRespuesta: escalationInstruction(result.businessStatus, result.assignedAgentName ?? null),
      };
    },
  });
}
