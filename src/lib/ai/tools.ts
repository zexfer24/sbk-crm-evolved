import "server-only";
import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getBcvRate } from "@/lib/ai/bcv";
import { RECLAMO_CATEGORIES, escalateConversation, type EscalationMotivo } from "@/lib/ai/escalate";

interface ToolDeps {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  contactId: string;
}

/** Se llena cuando el turno escala, para que el orquestador sepa qué pasó sin volver a tocar la base de datos. */
export interface EscalationOutcome {
  escalated: boolean;
  motivo?: EscalationMotivo;
  assignedAgentName?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Buscar repuesto — consulta_disponibilidad / otro. Solo lectura.
// ---------------------------------------------------------------------------
export function buildCatalogTool({ supabase, conversationId }: ToolDeps) {
  return tool({
    description:
      "Busca repuestos en el catálogo real de SBK Motors por nombre o marca del repuesto, y opcionalmente filtra por marca/modelo de la moto del cliente. Devuelve precio en USD y Bs (tasa BCV del día) y el stock disponible. Si no devuelve nada, ese repuesto no existe en el catálogo — no te lo inventes.",
    inputSchema: z.object({
      query: z.string().describe("Qué repuesto busca el cliente, ej. 'carburador', 'bujía NGK', 'kit de arrastre'"),
      motoBrand: z.string().optional().describe("Marca de la moto del cliente, si la mencionó (ej. 'Bera')"),
      motoModel: z.string().optional().describe("Modelo de la moto del cliente, si lo mencionó (ej. 'SBR 200')"),
    }),
    execute: async ({ query, motoBrand, motoModel }) => {
      const { data: products, error } = await supabase
        .from("products")
        .select("id, name, brand, price, currency, stock_quantity, product_compatibility(moto_brand, moto_model)")
        .eq("is_active", true)
        .or(`name.ilike.%${query}%,brand.ilike.%${query}%`);

      if (error) return { results: [], error: "No se pudo consultar el catálogo en este momento." };

      let filtered = products ?? [];
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
        results: quoted.map(({ id: _id, ...rest }) => rest),
        tasaBcvUsada: rate,
        tasaDesactualizada: isStale,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Historial de compras — devolucion. Solo lectura: no hay forma de aprobar,
// rechazar ni modificar nada desde esta herramienta.
// ---------------------------------------------------------------------------
export function buildOrderHistoryTool({ supabase, contactId }: ToolDeps) {
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

      if (error) return { orders: [], error: "No se pudo consultar el historial de compras." };

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

// ---------------------------------------------------------------------------
// Escalar a un asesor — devolucion, queja, e intención de compra dentro de
// consulta_disponibilidad. Única forma de tocar dinero o cerrar un caso: la
// IA nunca aprueba, rechaza ni cierra nada por su cuenta.
// ---------------------------------------------------------------------------
export function buildEscalateTool({ supabase, conversationId, contactId }: ToolDeps, outcome: EscalationOutcome) {
  return tool({
    description:
      "Escala la conversación a un asesor humano: pausa la IA, asigna al asesor con más tiempo sin recibir un cliente nuevo, y deja un resumen para que no tenga que volver a preguntar todo. Es la única forma de tocar dinero real (devoluciones, ventas) o reclamos — la IA nunca los resuelve sola.",
    inputSchema: z.object({
      motivo: z.enum(["devolucion", "queja", "intencion_compra"]),
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
      });

      outcome.escalated = result.escalated;
      outcome.motivo = motivo;
      outcome.assignedAgentName = result.assignedAgentName;
      outcome.reason = result.reason;

      return result;
    },
  });
}
