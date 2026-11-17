import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { SeenMarker } from "@/lib/ai/history-line";
import { turnCallsSnapshot } from "@/lib/ai/turn-telemetry";
import { businessStatus, type BusinessHours, type BusinessStatus } from "@/lib/business-hours";
import { errorText, log } from "@/lib/log";
import type { RazonDeSilencio, TurnEffects } from "./effects";
import type { MotivoV2 } from "./motivos";
import {
  estadoVigente,
  parseEstadoSeba,
  type Area,
  type EstadoSeba,
  type LineaDeCarrito,
  type MensajeDeTurno,
  type OrigenTexto,
  type ResultadoDePase,
  type ResumenDeTurno,
} from "./tipos";

/**
 * Efectos de SOMBRA y COPILOTO de Seba v2 (S2b, 17/11/2026): el turno corre entero
 * pero NADA sale al cliente ni toca la conversación. Lo que Seba habría dicho,
 * hecho y guardado se junta en memoria y, al cerrar, se escribe en UNA fila de
 * `agent_shadow_drafts` — para medirla (sombra) o para que el asesor la vea como
 * sugerencia en su chat (copiloto).
 *
 * REGLA DURA: el ÚNICO efecto en la base es ese `insert` de `cerrar`. Ni otra
 * tabla, ni Redis, ni WhatsApp. Las lecturas (estado, bienvenida, cotizados) sí
 * consultan la base, pero solo `select`; por eso el estado del pedido de la sombra
 * vive en el propio borrador (`estado_despues`) y no en `conversations.seba_pedido`
 * (que es de Seba real), y la marca «visto hasta» en `contexto.visto` y no en
 * Redis: así sombra y real no se pisan aunque corran sobre la misma conversación.
 */

export interface DepsDeEffectsDeSombra {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  modo: "sombra" | "copiloto";
  businessHours: BusinessHours;
  ahora: () => Date;
  asesorAsignado: boolean;
  /** Llamadas al proveedor del turno (por defecto `turnCallsSnapshot`, la telemetría del turno en curso). */
  llamadas?: () => unknown[];
}

const MS_POR_HORA = 60 * 60 * 1000;
/** Una bienvenida (o un borrador que la lleve) por ventana de 24 h. */
const BIENVENIDA_VENTANA_HORAS = 24;
/** Lo cotizado en las últimas 72 h cuenta como «ya se le dijo al cliente». */
const COTIZADOS_VENTANA_HORAS = 72;

/** Ver `cuandoAbre` de `effects-real.ts`: misma redacción que v1; copia a propósito (cuatro líneas). */
function cuandoAbre(status: BusinessStatus): string | null {
  if (status.open || !status.nextOpening) return null;
  return `${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}`;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

function esSeenMarker(valor: unknown): valor is SeenMarker {
  if (!esObjeto(valor)) return false;
  return typeof valor.hasta === "string" && Array.isArray(valor.ids) && valor.ids.every((id) => typeof id === "string");
}

export function crearEffectsDeSombra(deps: DepsDeEffectsDeSombra): TurnEffects {
  const { supabase, conversationId, modo } = deps;

  const mensajes: MensajeDeTurno[] = [];
  let pase: { area: Area; motivo: MotivoV2; nota: string } | null = null;
  let carrito: LineaDeCarrito[] | null = null;
  let estadoGuardado: EstadoSeba | null = null;
  let visto: SeenMarker | null = null;
  let silencio: RazonDeSilencio | null = null;
  const notas: string[] = [];

  function acumular(mensaje: Omit<MensajeDeTurno, "orden">): void {
    mensajes.push({ orden: mensajes.length + 1, ...mensaje });
  }

  return {
    modo,

    escribiendo() {
      // Nada sale al cliente: tampoco el «escribiendo…».
    },

    async enviarTexto(texto: string, origen: OrigenTexto) {
      acumular({ tipo: "texto", texto, origen });
      return { ok: true };
    },

    async enviarImagen(mediaUrl: string, pie: string | null) {
      // Una imagen sale siempre de una herramienta (la foto del producto).
      acumular({ tipo: "imagen", texto: pie ?? "", origen: "herramienta", mediaUrl });
      return { ok: true };
    },

    async pasarAAsesor(i): Promise<ResultadoDePase> {
      pase = { area: i.area, motivo: i.motivo, nota: i.nota };
      const status = businessStatus(deps.ahora(), deps.businessHours);
      // No se asigna a nadie de verdad: se responde «sí, hay asesor» para que el
      // turno redacte lo que habría dicho; quedaría `escalaria: true` en el borrador.
      return { asignado: true, abierta: status.open, cuandoAbre: cuandoAbre(status), yaTeniaAsesor: deps.asesorAsignado };
    },

    async guardarCarrito(lineas: LineaDeCarrito[]) {
      carrito = lineas;
    },

    // S8c (17/11/2026): el silencio y las notas del turno viajan en `contexto` del
    // borrador; la sombra no escribe traspasos ni notas reales en la conversación.
    async registrarSilencio(razon: RazonDeSilencio) {
      silencio = razon;
    },

    async anotarParaAsesor(texto: string) {
      notas.push(texto);
    },

    async leerEstado(): Promise<EstadoSeba | null> {
      const { data, error } = await supabase
        .from("agent_shadow_drafts")
        .select("estado_despues")
        .eq("conversation_id", conversationId)
        .eq("modo", modo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        log.warn("sombra_estado_no_legible", { conversationId, detail: error.message });
        return null;
      }
      return estadoVigente(parseEstadoSeba(data?.estado_despues ?? null), deps.ahora());
    },

    async guardarEstado(estado: EstadoSeba) {
      // Solo en memoria: va a `estado_despues` del borrador. `conversations.seba_pedido` es de Seba real.
      estadoGuardado = estado;
    },

    async reclamarBienvenida(): Promise<boolean> {
      const ahora = deps.ahora();
      const limite = new Date(ahora.getTime() - BIENVENIDA_VENTANA_HORAS * MS_POR_HORA).toISOString();

      // 1) ¿Algún borrador de esta conversación (sombra o copiloto) en 24 h? Entonces la
      //    bienvenida ya «se dio» en el simulacro y no se repite en cada turno.
      const { data: borradores, error: errorBorradores } = await supabase
        .from("agent_shadow_drafts")
        .select("id")
        .eq("conversation_id", conversationId)
        .gte("created_at", limite)
        .limit(1);
      if (errorBorradores) {
        log.warn("sombra_bienvenida_no_legible", { conversationId, detail: errorBorradores.message });
        return false;
      }
      if ((borradores?.length ?? 0) > 0) return false;

      // 2) ¿La conversación ya recibió una bienvenida real en 24 h? (Seba v1/v2 reales, el webhook.)
      const { data: conversacion, error: errorConversacion } = await supabase
        .from("conversations")
        .select("welcome_sent_at")
        .eq("id", conversationId)
        .maybeSingle();
      if (errorConversacion) {
        log.warn("sombra_bienvenida_no_legible", { conversationId, detail: errorConversacion.message });
        return false;
      }
      const sello = conversacion?.welcome_sent_at ? Date.parse(conversacion.welcome_sent_at) : NaN;
      if (!Number.isNaN(sello) && sello > Date.parse(limite)) return false;

      // No se escribe nada: solo se dice «le tocaría».
      return true;
    },

    async marcarVisto(marker: SeenMarker) {
      visto = marker;
    },

    async productosYaCotizados(): Promise<Set<string>> {
      const desde = new Date(deps.ahora().getTime() - COTIZADOS_VENTANA_HORAS * MS_POR_HORA).toISOString();
      const ids = new Set<string>();

      const { data: cotizaciones, error: errorCotizaciones } = await supabase
        .from("conversation_quotes")
        .select("product_id")
        .eq("conversation_id", conversationId)
        .gte("quoted_at", desde);
      if (errorCotizaciones) {
        log.warn("sombra_cotizados_no_legibles", { conversationId, fuente: "cotizaciones", detail: errorCotizaciones.message });
      } else {
        for (const fila of cotizaciones ?? []) if (fila.product_id) ids.add(fila.product_id);
      }

      // Lo que la propia sombra ya cotizó en turnos anteriores: sin esto cada turno
      // de sombra volvería a cotizar lo mismo, porque nada queda en `conversation_quotes`.
      const { data: borradores, error: errorBorradores } = await supabase
        .from("agent_shadow_drafts")
        .select("productos")
        .eq("conversation_id", conversationId)
        .gte("created_at", desde);
      if (errorBorradores) {
        log.warn("sombra_cotizados_no_legibles", { conversationId, fuente: "borradores", detail: errorBorradores.message });
      } else {
        for (const fila of borradores ?? []) for (const id of fila.productos ?? []) ids.add(id);
      }

      return ids;
    },

    async hayMensajeNuevoDelCliente() {
      // La sombra no cede: el borrador se guarda igual, aunque el cliente haya escrito en medio.
      return false;
    },

    clienteEsperaPersona() {
      // La sombra no envía nada: no hay mensaje que marcar como automático.
    },

    async cerrar(resumen: ResumenDeTurno) {
      // Un turno que solo constató «no hay nada nuevo que contestar» no deja borrador:
      // no hay qué comparar y llenaría el panel de filas vacías (una por cada reintento
      // del reconciliador). `cortesia_tras_escalada` SÍ lo deja: el borrador lleva la
      // marca «visto» de la que la sombra lee dónde se quedó en el turno siguiente.
      if (silencio === "sin_mensaje_nuevo" && mensajes.length === 0) return;

      try {
        const llamadas = (deps.llamadas ?? turnCallsSnapshot)();
        const fila: Database["public"]["Tables"]["agent_shadow_drafts"]["Insert"] = {
          conversation_id: conversationId,
          modo,
          trigger_message_id: resumen.triggerMessageId,
          rafaga: resumen.rafaga as unknown as Json,
          mensajes: mensajes as unknown as Json,
          herramientas: resumen.herramientas as unknown as Json,
          productos: resumen.productos,
          escalaria: pase !== null,
          motivo: pase?.motivo ?? null,
          area: pase?.area ?? null,
          nota: pase?.nota ?? null,
          estado_antes: (resumen.estadoAntes as unknown as Json) ?? null,
          estado_despues: ((estadoGuardado ?? resumen.estadoDespues) as unknown as Json) ?? null,
          guardas: resumen.guardas as unknown as Json,
          // Claves en snake_case: así las documenta la migración 20261117010000
          // para `agent_shadow_drafts.contexto`.
          contexto: {
            ia_global: resumen.contexto.iaGlobal,
            asesor_asignado: resumen.contexto.asesorAsignado,
            asesor_escribio_hace_min: resumen.contexto.asesorEscribioHaceMin,
            visto: visto as unknown as Json,
            carrito: carrito as unknown as Json,
            accion: resumen.accion,
            resumen: resumen.resumen,
            // Solo si los hubo: un borrador de un turno que habló no necesita las claves vacías.
            ...(silencio !== null ? { silencio } : {}),
            ...(notas.length > 0 ? { notas } : {}),
          },
          model: resumen.modelo,
          input_tokens: resumen.tokens?.input ?? 0,
          output_tokens: resumen.tokens?.output ?? 0,
          cached_input_tokens: resumen.tokens?.cachedInput ?? 0,
          reasoning_tokens: resumen.tokens?.reasoning ?? 0,
          llamadas: llamadas as unknown as Json,
          duration_ms: Math.round(resumen.duracionMs),
          // Solo el copiloto tiene sugerencia que resolver; sin mensajes no hay nada que sugerir.
          sugerencia_estado: modo === "copiloto" && mensajes.length > 0 ? "pendiente" : null,
        };

        const { error } = await supabase.from("agent_shadow_drafts").insert(fila);
        if (error) log.error("sombra_borrador_no_escrito", { conversationId, modo, detail: error.message });
      } catch (err) {
        // El borrador es medición: perderlo nunca puede tumbar el turno.
        log.error("sombra_borrador_no_escrito", { conversationId, modo, detail: errorText(err) });
      }
    },
  };
}

/**
 * La marca «visto hasta» de la sombra: sale del último borrador (`contexto.visto`),
 * no de Redis (la de Redis es de Seba real y la sombra no la toca). `null` si no
 * hay borrador, si no trae marca o si la base falla (el turno trata todo como pendiente).
 */
export async function leerVistoDeSombra(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  modo: "sombra" | "copiloto"
): Promise<SeenMarker | null> {
  const { data, error } = await supabase
    .from("agent_shadow_drafts")
    .select("contexto")
    .eq("conversation_id", conversationId)
    .eq("modo", modo)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.warn("sombra_visto_no_legible", { conversationId, modo, detail: error.message });
    return null;
  }
  const contexto = data?.contexto;
  if (!esObjeto(contexto)) return null;
  return esSeenMarker(contexto.visto) ? contexto.visto : null;
}
