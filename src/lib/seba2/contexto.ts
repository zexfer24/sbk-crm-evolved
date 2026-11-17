import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelMessage } from "ai";
import { TOOL_KEYS, fetchEnabledToolKeys } from "@/lib/ai/agent-tools";
import { escalationOpen } from "@/lib/ai/handoffs";
import { customerFirstName } from "@/lib/ai/customer-name";
import {
  latestCustomerMarker,
  pendingCustomerEntries,
  pendingCustomerLines,
  previousConversationCutoff,
  type HistoryReading,
  type SeenMarker,
} from "@/lib/ai/history-line";
import { fetchTurnLessons, type TurnLessons } from "@/lib/ai/lessons";
import { businessStatus, parseBusinessHours, type BusinessHours } from "@/lib/business-hours";
import { errorText, log } from "@/lib/log";
import { parseImageFields, type ImageFields } from "@/lib/media-reading-fields";
import type { PaymentMethodConfig, PaymentMethodCurrency } from "@/lib/payment-methods";
import { isArea, type Area } from "@/lib/seba-v2-config";
import type { Database } from "@/lib/supabase/database.types";

// ---------------------------------------------------------------------------
// La carga de datos del turno de Seba v2 (entrega 3 del rework, 17/11/2026).
//
// UNA función (`cargarDatosDeTurno`) lee, en un solo `Promise.all`, todo lo que
// el turno necesita saber de la conversación y del negocio ANTES de llamar al
// modelo; y unas funciones puras (`derivarRafaga`, `recortarHastaElCliente`)
// derivan de ese material lo que el turno usa. El historial no se carga acá: lo
// trae `loadHistory` de `agent.ts` y le llega al turno por una función
// inyectada (este archivo no importa `agent.ts`, que es enorme y arrastra los
// dos SDK de IA).
//
// No se importa `fetchSebaV2Config`/`fetchPaymentMethods` de `data.ts` (17/11/
// 2026): ese módulo también corre en el navegador (por eso avisa con
// `console.error`, no con `log`), arrastra un grafo enorme de lecturas de
// pantalla que un turno no necesita, y ninguna pieza de `src/lib/ai/` lo
// importa hoy. Las dos consultas se repiten aquí con los MISMOS `select`; la
// diferencia buscada es que el horario de atención viaja en la misma consulta
// de `agent_settings` (una ida a la base menos) y que esta carga LANZA ante un
// `null`, que el panel sí puede pintar como «no disponible» y un turno no.
// ---------------------------------------------------------------------------

/**
 * La forma EXACTA de lo que devuelve `loadHistory` de `agent.ts` (su
 * `LoadedHistory` no se exporta): cuatro arreglos PARALELOS, del mismo largo y
 * con el mismo índice por mensaje, porque `loadHistory` los llena en el mismo
 * bucle. `messages` es el `ModelMessage` del SDK de IA (sin fecha); `createdAt`
 * e `ids` salen de la fila de `messages`; `lecturas` es lo que el webhook leyó
 * de un adjunto (`message_readings`), o `null`.
 */
export interface HistorialDeTurno {
  messages: ModelMessage[];
  createdAt: (string | null)[];
  ids: (string | null)[];
  lecturas: (HistoryReading | null)[];
}

export interface DatosDeTurno {
  conversacion: {
    id: string;
    contactId: string;
    assignedAgentId: string | null;
    aiEnabled: boolean;
    status: string;
    welcomeSentAt: string | null;
    lastCustomerMessageAt: string | null;
    escalationArea: Area | null;
  };
  /** Primer nombre validado del cliente, o null. */
  customerName: string | null;
  config: {
    welcomeText: string;
    welcomeFollowups: string[];
    casheaDatosText: string;
    casheaMinimoUsd: number;
    casheaSeisCuotasDesdeUsd: number;
  };
  /** Formas de pago de contado ACTIVAS, en su orden. */
  metodos: PaymentMethodConfig[];
  businessHours: BusinessHours;
  tiendaAbierta: boolean;
  /** «el lunes a las 8:00 am» o null si está abierta o no se sabe. */
  cuandoAbre: string | null;
  lessons: TurnLessons;
  /** Primeros nombres de los asesores activos (≥ 3 letras), sin el primer nombre del cliente. */
  nombresDeAsesores: string[];
  escaladaAbierta: boolean;
  /** Si hay escalada abierta: área y minutos desde que se escaló. */
  esperaDeAsesor: { area: Area; minutos: number } | null;
  /** Minutos desde el último mensaje real de un asesor al cliente (saliente, no nota interna); null si nunca. */
  asesorEscribioHaceMin: number | null;
  /**
   * Los interruptores por herramienta de Control IA (`agent_tools`), los mismos que respeta v1. R2/C1 (17/11/2026):
   * v2 ofrecía `buscarRepuesto` siempre y, con «Consulta de productos» apagada —la orden del operador de que la IA
   * no afirme existencia ni precio—, cotizaba igual. `catalogo` = `buscar_repuesto`; `biblioteca` =
   * `consultar_biblioteca`. Ante un error de lectura, `fetchEnabledToolKeys` enciende todas (como v1).
   */
  herramientas: { catalogo: boolean; biblioteca: boolean };
}

// ------------------------------- Carga -------------------------------------

/** Postgres `undefined_column`: la base todavía no tiene la migración 20261116030000. */
const UNDEFINED_COLUMN = "42703";

const MS_POR_MINUTO = 60_000;

/** Las columnas de configuración de Seba v2; el horario se suma solo si no viene precargado. */
const COLUMNAS_CONFIG = "welcome_text, welcome_followups, cashea_datos_text, cashea_minimo_usd, cashea_seis_cuotas_desde_usd";

interface FilaConfig {
  welcome_text: string;
  welcome_followups: unknown;
  cashea_datos_text: string;
  cashea_minimo_usd: number | string;
  cashea_seis_cuotas_desde_usd: number | string;
  business_hours?: unknown;
}

interface FilaMetodo {
  key: string;
  label: string;
  currency: PaymentMethodCurrency;
  instructions: string;
  seba_entrega: boolean;
  is_active: boolean;
  sort_order: number;
  updated_at: string;
}

interface FilaContacto {
  display_name: string | null;
  profile_name: string | null;
}

/** Sin tildes ni mayúsculas: «José», «JOSE» y «jose» son el mismo nombre. */
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Palabras que un primer token de `agents.display_name` puede ser SIN ser un nombre propio (R2/C2, 17/11/2026).
 * Con asesores llamados «ASESOR 2», «ADMIN PRUEBA» o «Ventas SBK», el primer token entraba a `nombresDeAsesores` y la
 * guarda `nombre_interno` frenaba cualquier texto que dijera «asesor», «admin» o «ventas»: en la prueba real
 * bloqueó dos veces una respuesta correcta por la palabra «asesor». Lista cerrada, sin tildes ni mayúsculas
 * (se compara con `normalizar`); una palabra nueva se agrega acá con su test.
 */
export const PALABRAS_QUE_NO_SON_NOMBRE: ReadonlySet<string> = new Set([
  "asesor",
  "asesora",
  "asesores",
  "admin",
  "administrador",
  "administradora",
  "ventas",
  "vendedor",
  "vendedora",
  "caja",
  "cajero",
  "cajera",
  "soporte",
  "supervisor",
  "supervisora",
  "gerente",
  "tienda",
  "equipo",
  "pagos",
  "envios",
  "reclamos",
  "atencion",
  "cliente",
  "clientes",
  "sbk",
  "motors",
  "motos",
  "prueba",
  "demo",
  "test",
  "usuario",
  "sistema",
  "almacen",
  "despacho",
  "taller",
  "repuestos",
]);

/**
 * El primer nombre de un asesor tal como se lo escribe a un cliente: el primer
 * token del nombre visible, sin signos pegados, y solo si tiene 3 letras o más
 * (un «Al» o un «J.» suelto no sirve para detectar que Seba nombró a un asesor)
 * y no es una palabra genérica de `PALABRAS_QUE_NO_SON_NOMBRE`. Un token sin
 * ninguna letra («2») tampoco es nombre. «ASESOR2» se compara por sus letras.
 */
function primerNombre(nombreVisible: string): string | null {
  const primero = nombreVisible.trim().split(/\s+/)[0] ?? "";
  const limpio = primero.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  const letras = limpio.replace(/[^\p{L}]/gu, "");
  if (letras.length < 3) return null;
  if (PALABRAS_QUE_NO_SON_NOMBRE.has(normalizar(letras))) return null;
  return limpio;
}

/**
 * Una lectura que puede fallar sin tumbar el turno: ante un error (de la base o
 * una excepción) devuelve el valor neutro y deja `seba2_contexto_parcial` — un
 * dato que falta no puede dejar al cliente sin respuesta.
 */
async function leerParcial<T>(
  conversationId: string,
  que: string,
  neutro: T,
  leer: () => PromiseLike<{ data: T | null; error: unknown }>
): Promise<T> {
  try {
    const { data, error } = await leer();
    if (error) {
      log.warn("seba2_contexto_parcial", { conversationId, que, detail: errorText(error) });
      return neutro;
    }
    return data ?? neutro;
  } catch (err) {
    log.warn("seba2_contexto_parcial", { conversationId, que, detail: errorText(err) });
    return neutro;
  }
}

function minutosDesde(fecha: string, ahora: Date): number | null {
  const ms = Date.parse(fecha);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((ahora.getTime() - ms) / MS_POR_MINUTO));
}

export async function cargarDatosDeTurno(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  ahora: Date,
  precargado?: { lessons?: TurnLessons; businessHours?: BusinessHours }
): Promise<DatosDeTurno> {
  const [
    conversacion,
    config,
    metodos,
    lessons,
    escaladaAbierta,
    agentes,
    ultimoAsesor,
    traspasoDeEscalada,
    herramientasEncendidas,
  ] =
    await Promise.all([
      supabase
        .from("conversations")
        .select(
          "id, contact_id, assigned_agent_id, ai_enabled, status, welcome_sent_at, last_customer_message_at, escalation_area, contact:contacts(display_name, profile_name)"
        )
        .eq("id", conversationId)
        .maybeSingle(),
      supabase
        .from("agent_settings")
        .select(precargado?.businessHours ? COLUMNAS_CONFIG : `${COLUMNAS_CONFIG}, business_hours`)
        .eq("id", true)
        .single(),
      supabase
        .from("payment_methods")
        .select("key, label, currency, instructions, seba_entrega, is_active, sort_order, updated_at")
        .eq("is_active", true)
        .order("sort_order")
        .order("label"),
      precargado?.lessons ? Promise.resolve(precargado.lessons) : fetchTurnLessons(supabase, conversationId),
      escalationOpen(supabase, conversationId),
      // Asesores activos: la guarda de nombres del turno los usa para detectar que Seba nombró a uno.
      leerParcial<{ display_name: string }[]>(conversationId, "asesores", [], () =>
        supabase.from("agents").select("display_name").eq("is_active", true).neq("role", "caja")
      ),
      // Último mensaje REAL de un asesor al cliente: saliente y sin notas internas (una nota no se le escribe a nadie).
      leerParcial<{ created_at: string } | null>(conversationId, "ultimo_mensaje_de_asesor", null, () =>
        supabase
          .from("messages")
          .select("created_at")
          .eq("conversation_id", conversationId)
          .eq("sender_type", "agent")
          .eq("direction", "outbound")
          .eq("is_internal_note", false)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      ),
      // Cuándo se escaló: el traspaso `escalada`/`escalada_sin_asesor` más reciente. Se lee siempre (va en el mismo
      // `Promise.all` que decide si la escalada sigue abierta) y solo se usa si lo está.
      leerParcial<{ created_at: string } | null>(conversationId, "fecha_de_escalada", null, () =>
        supabase
          .from("conversation_handoffs")
          .select("created_at")
          .eq("conversation_id", conversationId)
          .in("reason", ["escalada", "escalada_sin_asesor"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      ),
      // Los interruptores del panel: la MISMA función que v1 (ante un error corre con todas encendidas).
      fetchEnabledToolKeys(supabase),
    ]);

  // Sin estos tres Seba v2 no puede atender: lanzan y quien llama decide (la cola reintenta un corte transitorio).
  if (conversacion.error) {
    throw new Error(`Seba v2: no se pudo leer la conversación ${conversationId}: ${errorText(conversacion.error)}`, {
      cause: conversacion.error,
    });
  }
  const filaConversacion = conversacion.data;
  if (!filaConversacion) {
    throw new Error(`Seba v2: la conversación ${conversationId} no existe.`);
  }

  if (config.error || !config.data) {
    const faltaMigracion = (config.error as { code?: string } | null)?.code === UNDEFINED_COLUMN;
    throw new Error(
      `Seba v2: no se pudo leer la configuración de Seba v2 (agent_settings)${
        faltaMigracion ? ": falta aplicar la migración 20261116030000" : ""
      }${config.error ? `: ${errorText(config.error)}` : ": la fila no existe"}.`,
      { cause: config.error ?? undefined }
    );
  }
  const filaConfig = config.data as unknown as FilaConfig;

  if (metodos.error) {
    throw new Error(`Seba v2: no se pudieron leer las formas de pago: ${errorText(metodos.error)}`, {
      cause: metodos.error,
    });
  }

  const businessHours = precargado?.businessHours ?? parseBusinessHours(filaConfig.business_hours ?? undefined);
  const estado = businessStatus(ahora, businessHours);

  // `contact` es una relación muchos-a-uno (objeto); por si algún día llegara como arreglo, se toma el primero.
  const embebido = (filaConversacion as unknown as { contact: FilaContacto | FilaContacto[] | null }).contact;
  const contacto = Array.isArray(embebido) ? (embebido[0] ?? null) : embebido;
  const customerName = customerFirstName(contacto?.display_name ?? null, contacto?.profile_name ?? null);

  const nombreDelCliente = customerName ? normalizar(customerName) : null;
  const vistos = new Set<string>();
  const nombresDeAsesores: string[] = [];
  for (const fila of agentes) {
    const nombre = primerNombre(fila.display_name ?? "");
    if (!nombre) continue;
    const clave = normalizar(nombre);
    // Un cliente que se llama igual que un asesor no puede disparar la guarda de nombres al saludarlo.
    if (clave === nombreDelCliente || vistos.has(clave)) continue;
    vistos.add(clave);
    nombresDeAsesores.push(nombre);
  }

  const areaDeLaConversacion = isArea(filaConversacion.escalation_area) ? filaConversacion.escalation_area : null;
  const minutosDeEscalada = traspasoDeEscalada ? minutosDesde(traspasoDeEscalada.created_at, ahora) : null;

  return {
    conversacion: {
      id: filaConversacion.id,
      contactId: filaConversacion.contact_id,
      assignedAgentId: filaConversacion.assigned_agent_id,
      aiEnabled: filaConversacion.ai_enabled,
      status: filaConversacion.status,
      welcomeSentAt: filaConversacion.welcome_sent_at,
      lastCustomerMessageAt: filaConversacion.last_customer_message_at,
      escalationArea: areaDeLaConversacion,
    },
    customerName,
    config: {
      welcomeText: filaConfig.welcome_text,
      welcomeFollowups: Array.isArray(filaConfig.welcome_followups) ? (filaConfig.welcome_followups as string[]) : [],
      casheaDatosText: filaConfig.cashea_datos_text,
      // `numeric` llega como string o como number según el cliente: se normaliza.
      casheaMinimoUsd: Number(filaConfig.cashea_minimo_usd),
      casheaSeisCuotasDesdeUsd: Number(filaConfig.cashea_seis_cuotas_desde_usd),
    },
    metodos: ((metodos.data ?? []) as unknown as FilaMetodo[]).map((fila) => ({
      key: fila.key,
      label: fila.label,
      currency: fila.currency,
      instructions: fila.instructions,
      sebaEntrega: fila.seba_entrega,
      isActive: fila.is_active,
      sortOrder: fila.sort_order,
      updatedAt: fila.updated_at,
    })),
    businessHours,
    tiendaAbierta: estado.open,
    cuandoAbre:
      !estado.open && estado.nextOpening ? `${estado.nextOpening.dayLabel} a las ${estado.nextOpening.time}` : null,
    lessons,
    nombresDeAsesores,
    escaladaAbierta,
    esperaDeAsesor: escaladaAbierta ? { area: areaDeLaConversacion ?? "ventas", minutos: minutosDeEscalada ?? 0 } : null,
    asesorEscribioHaceMin: ultimoAsesor ? minutosDesde(ultimoAsesor.created_at, ahora) : null,
    herramientas: {
      catalogo: herramientasEncendidas.has(TOOL_KEYS.catalog),
      biblioteca: herramientasEncendidas.has(TOOL_KEYS.knowledge),
    },
  };
}

// ------------------------------- Ráfaga ------------------------------------

/**
 * Pasado este plazo desde el mensaje anterior del cliente, un mensaje nuevo
 * abre una ventana de WhatsApp nueva (la de atención gratuita dura 24 h).
 */
const VENTANA_NUEVA_HORAS = 24;
const MS_POR_HORA = 60 * MS_POR_MINUTO;

export interface RafagaDeTurno {
  /** Textos pendientes del cliente (lo que hay que contestar ahora), en orden. */
  lineas: string[];
  /** Lecturas de imagen de los mensajes de la ráfaga (comprobantes, fotos de producto…). */
  lecturas: ImageFields[];
  /** Id del último mensaje del cliente de la ráfaga, o null. */
  triggerMessageId: string | null;
  /** Marcador «visto hasta» para esta ráfaga (lo que el turno guardará al terminar). */
  marcador: SeenMarker | null;
  /** No hay un mensaje anterior del cliente antes de esta ráfaga, o el anterior tiene 24 h o más. */
  ventanaNueva: boolean;
  /** Fecha de corte de «conversación vieja» (previousConversationCutoff), o null. */
  cortePrevio: string | null;
}

/**
 * Deriva la ráfaga pendiente del historial y la marca «visto hasta» del turno
 * anterior, con las MISMAS reglas que v1 (`history-line.ts`: un sticker no
 * cuenta, hueco de 10 minutos entre líneas, línea sin fecha corta la ráfaga…).
 *
 * `marcador` es `latestCustomerMarker` sobre TODO el historial cargado —no solo
 * sobre las líneas pendientes—, igual que `marcarTurnoVisto` en `agent.ts`: un
 * sticker de cierre que llega después de la última pregunta queda visto, y no
 * reencola un turno sin nada que contestar (caso `75e26065…`, 24/10/2026).
 *
 * `ventanaNueva` mide desde el mensaje anterior del cliente (cualquier línea
 * `user` ANTERIOR a la primera de la ráfaga, visto o no, sticker incluido: para
 * Meta también abre ventana) hasta la primera línea de la ráfaga, o hasta
 * `ahora` si esa línea no trae fecha. Un mensaje anterior sin fecha legible NO
 * cuenta como ventana nueva: ante la duda no se vuelve a presentar a Seba a
 * mitad de una conversación (el saludo en medio fue el reclamo del 14/9/2026).
 */
export function derivarRafaga(historial: HistorialDeTurno, visto: SeenMarker | null, ahora: Date): RafagaDeTurno {
  // Mismo zip que `runTurnPhases` (agent.ts): los cuatro arreglos de `loadHistory` comparten índice.
  const zipped = historial.messages.map((message, i) => ({
    role: message.role as string,
    content: message.content as unknown,
    createdAt: historial.createdAt[i] ?? null,
    id: historial.ids[i] ?? null,
    lectura: historial.lecturas[i] ?? null,
  }));

  const entradas = pendingCustomerEntries(zipped, visto);
  if (entradas.length === 0) {
    return {
      lineas: [],
      lecturas: [],
      triggerMessageId: null,
      marcador: null,
      ventanaNueva: false,
      cortePrevio: null,
    };
  }

  const lecturas: ImageFields[] = [];
  for (const entrada of entradas) {
    if (!entrada.lectura || entrada.lectura.status !== "ok") continue;
    const campos = parseImageFields(entrada.lectura.fields);
    if (campos) lecturas.push(campos);
  }

  // Mensaje anterior del cliente: el último `user` antes de la primera línea de la ráfaga.
  const indicePrimera = zipped.indexOf(entradas[0]);
  let anterior: (typeof zipped)[number] | null = null;
  for (let i = indicePrimera - 1; i >= 0; i--) {
    if (zipped[i].role === "user") {
      anterior = zipped[i];
      break;
    }
  }

  let ventanaNueva: boolean;
  if (!anterior) {
    ventanaNueva = true;
  } else {
    const msAnterior = anterior.createdAt ? Date.parse(anterior.createdAt) : Number.NaN;
    const msPrimera = entradas[0].createdAt ? Date.parse(entradas[0].createdAt) : Number.NaN;
    const referencia = Number.isNaN(msPrimera) ? ahora.getTime() : msPrimera;
    ventanaNueva = !Number.isNaN(msAnterior) && referencia - msAnterior >= VENTANA_NUEVA_HORAS * MS_POR_HORA;
  }

  return {
    lineas: pendingCustomerLines(zipped, visto),
    lecturas,
    triggerMessageId: entradas[entradas.length - 1].id,
    marcador: latestCustomerMarker(zipped),
    ventanaNueva,
    cortePrevio: previousConversationCutoff(zipped, visto)?.cutoffAt ?? null,
  };
}

/**
 * Recorta del final del historial todo lo que no sea del cliente: la sombra ve
 * la conversación como estaba cuando el cliente escribió (sin la respuesta que
 * después dio v1 o un asesor). Recorta los cuatro arreglos paralelos a la vez
 * y no muta la entrada.
 */
export function recortarHastaElCliente(historial: HistorialDeTurno): HistorialDeTurno {
  let fin = historial.messages.length;
  while (fin > 0 && historial.messages[fin - 1].role !== "user") fin--;

  return {
    messages: historial.messages.slice(0, fin),
    createdAt: historial.createdAt.slice(0, fin),
    ids: historial.ids.slice(0, fin),
    lecturas: historial.lecturas.slice(0, fin),
  };
}
