import { isValidCedulaNumber } from "@/lib/sale-draft";
import type { CedulaType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Reglas puras de "Enviar a SAINT" (25/10/2026, plan "Enviar a SAINT", T2).
//
// El asesor (o la caja) manda un presupuesto o el carrito del chat a SAINT
// como factura en espera: la app inserta un borrador `pendiente` en la base y
// un agente aparte lo crea en SAINT. Todo lo que decide la interfaz —qué datos
// del cliente se exigen, qué estado se pinta, cuándo pedir confirmación para
// reenviar, qué texto sale ante un error— vive acá, sin React ni Supabase,
// para probarlo sin levantar nada. La validación de verdad la repite la base
// (`enviar_borrador_saint`, 22023): esta es la primera barrera, la que evita
// el viaje.
// ---------------------------------------------------------------------------

export type OrigenSaint = "presupuesto" | "carrito";
export type EstadoSaint = "pendiente" | "procesando" | "creado" | "error";

export interface BorradorSaint {
  id: string;
  origen: OrigenSaint;
  origenId: string;
  creadoPor: string | null;
  cedulaTipo: CedulaType;
  cedulaNumero: string;
  nombre: string;
  apellido: string;
  telefono: string;
  estado: EstadoSaint;
  numeroSaint: string | null;
  codclie: string | null;
  clienteCreado: boolean | null;
  error: string | null;
  createdAt: string;
  procesadoAt: string | null;
}

/** Una fila de la RPC `borradores_saint`, tal como llega de la base. */
export interface FilaBorradorSaint {
  id: string;
  origen: string;
  origen_id: string;
  creado_por: string | null;
  cedula_tipo: string;
  cedula_numero: string;
  nombre: string;
  apellido: string;
  telefono: string;
  estado: string;
  numero_saint: string | null;
  codclie: string | null;
  cliente_creado: boolean | null;
  error: string | null;
  created_at: string;
  procesado_at: string | null;
}

export function borradorDesdeFila(row: FilaBorradorSaint): BorradorSaint {
  return {
    id: row.id,
    origen: row.origen as OrigenSaint,
    origenId: row.origen_id,
    creadoPor: row.creado_por,
    cedulaTipo: row.cedula_tipo as CedulaType,
    cedulaNumero: row.cedula_numero,
    nombre: row.nombre,
    apellido: row.apellido,
    telefono: row.telefono,
    estado: row.estado as EstadoSaint,
    numeroSaint: row.numero_saint,
    codclie: row.codclie,
    clienteCreado: row.cliente_creado,
    error: row.error,
    createdAt: row.created_at,
    procesadoAt: row.procesado_at,
  };
}

// --- Datos del cliente ------------------------------------------------------

export interface DatosClienteSaint {
  cedulaTipo: CedulaType | "";
  cedulaNumero: string;
  nombre: string;
  apellido: string;
  telefono: string;
}

export type CampoClienteSaint = "cedula" | "nombre" | "apellido" | "telefono";

const TELEFONO_PATTERN = /^\+?[0-9]{7,19}$/;

/**
 * Cédula válida para SAINT: la regla del cierre de venta (5 a 10 dígitos) y,
 * además, que no sea todo ceros — SAINT rechaza "00000" aunque tenga el largo.
 */
export function esCedulaSaintValida(numero: string): boolean {
  const limpio = numero.trim();
  return isValidCedulaNumber(limpio) && !/^0+$/.test(limpio);
}

export function esTelefonoSaintValido(telefono: string): boolean {
  return TELEFONO_PATTERN.test(telefono.trim());
}

/** Un mensaje por cada campo que falla; `{}` si todo está en regla. */
export function validarClienteSaint(d: DatosClienteSaint): Partial<Record<CampoClienteSaint, string>> {
  const errores: Partial<Record<CampoClienteSaint, string>> = {};

  if (!d.cedulaTipo) {
    errores.cedula = "Elige si la cédula es V o E.";
  } else if (!esCedulaSaintValida(d.cedulaNumero)) {
    errores.cedula = "La cédula debe tener entre 5 y 10 dígitos, sin letras ni guiones.";
  }
  if (!d.nombre.trim()) errores.nombre = "Falta el nombre.";
  if (!d.apellido.trim()) errores.apellido = "Falta el apellido.";
  if (!esTelefonoSaintValido(d.telefono)) {
    errores.telefono = "Teléfono inválido: solo dígitos, con + inicial opcional.";
  }
  return errores;
}

// --- Estado del envío -------------------------------------------------------

/**
 * Un borrador `pendiente` que lleva más de esto sin que el agente lo tome
 * casi seguro es porque el agente (un proceso aparte, en otra máquina) está
 * apagado: la interfaz lo dice en vez de dejar "Enviando…" para siempre.
 */
export const SAINT_SIN_RESPUESTA_MS = 2 * 60 * 1000;

export function estaSinRespuesta(b: BorradorSaint, ahora: Date): boolean {
  return b.estado === "pendiente" && ahora.getTime() - new Date(b.createdAt).getTime() > SAINT_SIN_RESPUESTA_MS;
}

export type DecisionEnvio =
  | { tipo: "libre" }
  | { tipo: "en_curso" }
  | { tipo: "confirmar"; numeroSaint: string | null; createdAt: string };

/**
 * Qué pasa al pulsar "Enviar a SAINT" según el ÚLTIMO envío de ese origen:
 * ninguno o fallido → se envía; en vuelo → se bloquea (el índice único de la
 * base lo haría igual); ya creado → se pregunta antes de duplicar la factura.
 */
export function decidirEnvio(ultimo: BorradorSaint | null): DecisionEnvio {
  if (!ultimo || ultimo.estado === "error") return { tipo: "libre" };
  if (ultimo.estado === "pendiente" || ultimo.estado === "procesando") return { tipo: "en_curso" };
  return { tipo: "confirmar", numeroSaint: ultimo.numeroSaint, createdAt: ultimo.createdAt };
}

/** "24/10 10:52" en la hora de Caracas (24 h), nunca la del navegador. */
function fechaCaracas(iso: string): string {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Caracas",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const valor = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${valor("day")}/${valor("month")} ${valor("hour")}:${valor("minute")}`;
}

export function textoConfirmacionReenvio(origen: OrigenSaint, numeroSaint: string | null, createdAt: string): string {
  const que = origen === "presupuesto" ? "presupuesto" : "carrito";
  const como = numeroSaint ? ` como ${numeroSaint}` : "";
  return `Este ${que} ya se envió a SAINT${como} el ${fechaCaracas(createdAt)}. ¿Enviar de nuevo?`;
}

export type TonoEstado = "progreso" | "ok" | "error" | "alerta";

export function etiquetaEstado(
  b: BorradorSaint,
  ahora: Date,
): { texto: string; detalle: string | null; tono: TonoEstado } {
  switch (b.estado) {
    case "pendiente":
      if (estaSinRespuesta(b, ahora)) {
        return {
          texto: "SAINT no responde: el agente podría estar apagado.",
          detalle: "Se creará cuando vuelva.",
          tono: "alerta",
        };
      }
      return { texto: "Enviando a SAINT…", detalle: null, tono: "progreso" };
    case "procesando":
      return { texto: "Creando en SAINT…", detalle: null, tono: "progreso" };
    case "creado": {
      const texto = b.numeroSaint ? `En SAINT como ${b.numeroSaint}` : "Creado en SAINT";
      let detalle: string | null = null;
      if (b.codclie) {
        detalle = b.clienteCreado ? `Cliente ${b.codclie} · cliente nuevo registrado` : `Cliente ${b.codclie}`;
      }
      return { texto, detalle, tono: "ok" };
    }
    case "error":
      return { texto: b.error ?? "No se pudo crear en SAINT.", detalle: null, tono: "error" };
  }
}

// --- Errores del envío ------------------------------------------------------

const ERROR_GENERICO = "No se pudo enviar a SAINT. Intenta de nuevo.";

/**
 * Traduce el error de `enviar_borrador_saint` a texto para el toast. La RPC
 * pone en `details` un texto en español listo para mostrar solo cuando el
 * `message` es `saint_dato_invalido`; cualquier otro error (red, base caída)
 * no se le enseña crudo al asesor.
 */
export function mensajeErrorEnvio(err: unknown): string {
  if (typeof err !== "object" || err === null) return ERROR_GENERICO;
  const { code, message, details } = err as { code?: unknown; message?: unknown; details?: unknown };
  if (code === "23505") return "Ya hay un envío en curso.";
  if (code === "22023" && message === "saint_dato_invalido" && typeof details === "string" && details.trim() !== "") {
    return details;
  }
  if (code === "42501") return "No tienes permiso para enviar esto a SAINT.";
  return ERROR_GENERICO;
}

// --- Renglones que SAINT no puede recibir ------------------------------------

/**
 * Los productos que la base va a rechazar: sin código SAINT, o dados de baja
 * en el inventario. Avisar antes evita el viaje y dice cuáles son. Un producto
 * en ambos casos se cuenta solo como "sin código" (es el problema de fondo).
 * Nombres en el orden recibido, sin repetir.
 */
export function renglonesBloqueados(
  productos: { name: string; saintCode: string | null; isActive: boolean }[],
): { sinCodigo: string[]; inactivos: string[] } {
  const sinCodigo = new Set<string>();
  const inactivos = new Set<string>();
  for (const p of productos) {
    if (!p.saintCode || p.saintCode.trim() === "") sinCodigo.add(p.name);
    else if (!p.isActive) inactivos.add(p.name);
  }
  return { sinCodigo: [...sinCodigo], inactivos: [...inactivos] };
}

export function textoBloqueo(b: { sinCodigo: string[]; inactivos: string[] }): string | null {
  const partes: string[] = [];
  if (b.sinCodigo.length > 0) partes.push(`Sin código SAINT: ${b.sinCodigo.join(", ")}.`);
  if (b.inactivos.length > 0) partes.push(`Dados de baja en el inventario: ${b.inactivos.join(", ")}.`);
  return partes.length > 0 ? partes.join(" ") : null;
}
