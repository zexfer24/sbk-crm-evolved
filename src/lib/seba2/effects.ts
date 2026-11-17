import type { SeenMarker } from "@/lib/ai/history-line";
import type { MotivoV2 } from "./motivos";
import type {
  Area,
  EstadoSeba,
  LineaDeCarrito,
  OrigenTexto,
  ResultadoDePase,
  ResumenDeTurno,
} from "./tipos";

/**
 * TODO lo que un turno de Seba v2 escribe pasa por esta interfaz (17/11/2026).
 *
 * El turno es UNO solo y corre en cuatro modos que difieren únicamente en los
 * efectos: `real` envía de verdad; `sombra` y `copiloto` redactan sin enviar y
 * guardan un borrador (en `cerrar`); `memoria` no escribe en ningún lado y sirve a
 * los tests y al arnés. Como el turno no toca Supabase, WhatsApp ni Redis por su
 * cuenta, probar un modo nuevo es cambiar de implementación, no tocar el turno.
 *
 * Las implementaciones real y de sombra viven en otras tareas; la de memoria, en
 * `effects-memoria.ts`.
 */
export interface TurnEffects {
  readonly modo: "real" | "sombra" | "copiloto" | "memoria";

  /** Indicador de «escribiendo…». Nunca lanza ni se espera. */
  escribiendo(): void;

  enviarTexto(texto: string, origen: OrigenTexto): Promise<{ ok: boolean }>;
  enviarImagen(mediaUrl: string, pie: string | null): Promise<{ ok: boolean }>;

  /**
   * Asigna (o reitera) el caso a un asesor del área. `abierta` y `cuandoAbre` dicen
   * si la tienda está abierta y, si no, cuándo abre.
   */
  pasarAAsesor(i: { area: Area; motivo: MotivoV2; nota: string }): Promise<ResultadoDePase>;

  guardarCarrito(lineas: LineaDeCarrito[]): Promise<void>;

  leerEstado(): Promise<EstadoSeba | null>;
  guardarEstado(estado: EstadoSeba): Promise<void>;

  /** `true` si a este turno le toca mandar la bienvenida (una por ventana de 24 h). */
  reclamarBienvenida(): Promise<boolean>;

  marcarVisto(marker: SeenMarker): Promise<void>;

  /** Ids de los productos que ya se le cotizaron al cliente en esta conversación (72 h). */
  productosYaCotizados(): Promise<Set<string>>;

  /**
   * ¿Entró un mensaje nuevo del cliente desde que el turno cargó su historial? En
   * modo real decide si el turno cede.
   */
  hayMensajeNuevoDelCliente(): Promise<boolean>;

  /** Registra el turno. En sombra y copiloto escribe el borrador. Se llama UNA vez. */
  cerrar(resumen: ResumenDeTurno): Promise<void>;
}
