import type { SeenMarker } from "@/lib/ai/history-line";
import type { TurnEffects } from "./effects";
import type { MotivoV2 } from "./motivos";
import type {
  Area,
  EstadoSeba,
  LineaDeCarrito,
  MensajeDeTurno,
  OrigenTexto,
  ResultadoDePase,
  ResumenDeTurno,
} from "./tipos";

/**
 * Implementación de `TurnEffects` que vive solo en memoria (17/11/2026): no toca
 * red, disco ni reloj global. Sirve a los tests del turno y al arnés, que afirman
 * sobre `registro` en vez de sobre un fake de Supabase.
 *
 * Es PURA a propósito: sin Supabase, sin Redis, sin `server-only`.
 */

export interface GuionDeMemoria {
  /** Lo que devuelve `leerEstado` al empezar. */
  estado?: EstadoSeba | null;
  /** Default `true`. */
  bienvenidaDisponible?: boolean;
  /** Default `[]`. */
  yaCotizados?: readonly string[];
  /** Default `{ asignado: true, abierta: true, cuandoAbre: null, yaTeniaAsesor: false }`. */
  pase?: Partial<ResultadoDePase>;
  /** Si está, `pasarAAsesor` rechaza con este error. */
  paseLanza?: Error;
  /** Si `true`, los envíos devuelven `{ ok: false }` y NO registran el mensaje. */
  envioFalla?: boolean;
  /**
   * `hayMensajeNuevoDelCliente` da `true` cuando ya salieron al menos N mensajes;
   * `null` (o ausente) = nunca.
   */
  mensajeNuevoTrasEnvios?: number | null;
  /** Default `"memoria"`; los otros dos sirven para probar ramas del turno que miran el modo. */
  modo?: "memoria" | "sombra" | "copiloto";
}

export interface RegistroDeMemoria {
  /** En orden; `orden` empieza en 1. */
  mensajes: MensajeDeTurno[];
  /** Veces que se llamó a `escribiendo`. */
  escribiendo: number;
  pases: { area: Area; motivo: MotivoV2; nota: string }[];
  /** La última llamada a `guardarCarrito`. */
  carrito: LineaDeCarrito[] | null;
  /** El último guardado (o el del guion si nunca se guardó). */
  estado: EstadoSeba | null;
  /** Bienvenidas CONCEDIDAS (las que devolvieron `true`), no intentos. */
  bienvenidasReclamadas: number;
  vistos: SeenMarker[];
  cierre: ResumenDeTurno | null;
  /**
   * Nombre de cada efecto que ESCRIBE o consume algo, en el orden en que ocurrió
   * («enviarTexto», «pasarAAsesor», «guardarEstado»…), para afirmar secuencias.
   * Las lecturas puras (`leerEstado`, `productosYaCotizados`,
   * `hayMensajeNuevoDelCliente`) no entran: ensuciarían toda aserción de orden.
   * Un envío o un pase que falla por guion SÍ queda: el intento ocurrió.
   */
  secuencia: string[];
}

const PASE_POR_DEFECTO: ResultadoDePase = {
  asignado: true,
  abierta: true,
  cuandoAbre: null,
  yaTeniaAsesor: false,
};

export function crearEffectsDeMemoria(
  guion: GuionDeMemoria = {},
): TurnEffects & { readonly registro: RegistroDeMemoria } {
  const registro: RegistroDeMemoria = {
    mensajes: [],
    escribiendo: 0,
    pases: [],
    carrito: null,
    estado: guion.estado ?? null,
    bienvenidasReclamadas: 0,
    vistos: [],
    cierre: null,
    secuencia: [],
  };

  let bienvenidaYaReclamada = false;

  function registrarMensaje(mensaje: Omit<MensajeDeTurno, "orden">): void {
    registro.mensajes.push({ orden: registro.mensajes.length + 1, ...mensaje });
  }

  return {
    registro,
    modo: guion.modo ?? "memoria",

    escribiendo() {
      registro.secuencia.push("escribiendo");
      registro.escribiendo += 1;
    },

    async enviarTexto(texto: string, origen: OrigenTexto) {
      registro.secuencia.push("enviarTexto");
      if (guion.envioFalla) return { ok: false };
      registrarMensaje({ tipo: "texto", texto, origen });
      return { ok: true };
    },

    async enviarImagen(mediaUrl: string, pie: string | null) {
      registro.secuencia.push("enviarImagen");
      if (guion.envioFalla) return { ok: false };
      // Una imagen sale siempre de una herramienta (la foto del producto).
      registrarMensaje({ tipo: "imagen", texto: pie ?? "", origen: "herramienta", mediaUrl });
      return { ok: true };
    },

    async pasarAAsesor(i) {
      registro.secuencia.push("pasarAAsesor");
      if (guion.paseLanza) throw guion.paseLanza;
      registro.pases.push({ area: i.area, motivo: i.motivo, nota: i.nota });
      return { ...PASE_POR_DEFECTO, ...guion.pase };
    },

    async guardarCarrito(lineas) {
      registro.secuencia.push("guardarCarrito");
      registro.carrito = lineas;
    },

    async leerEstado() {
      return registro.estado;
    },

    async guardarEstado(estado) {
      registro.secuencia.push("guardarEstado");
      registro.estado = estado;
    },

    async reclamarBienvenida() {
      registro.secuencia.push("reclamarBienvenida");
      // Una bienvenida por turno: solo la PRIMERA llamada puede concederla.
      if (bienvenidaYaReclamada) return false;
      bienvenidaYaReclamada = true;
      const concedida = guion.bienvenidaDisponible ?? true;
      if (concedida) registro.bienvenidasReclamadas += 1;
      return concedida;
    },

    async marcarVisto(marker) {
      registro.secuencia.push("marcarVisto");
      registro.vistos.push(marker);
    },

    async productosYaCotizados() {
      return new Set(guion.yaCotizados ?? []);
    },

    async hayMensajeNuevoDelCliente() {
      const umbral = guion.mensajeNuevoTrasEnvios;
      if (umbral === null || umbral === undefined) return false;
      return registro.mensajes.length >= umbral;
    },

    async cerrar(resumen) {
      if (registro.cierre !== null) throw new Error("cerrar se llamó dos veces");
      registro.secuencia.push("cerrar");
      registro.cierre = resumen;
    },
  };
}
