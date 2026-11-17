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
 * Por qué un turno decidió NO escribirle al cliente y lo deja dicho (S8c,
 * 17/11/2026). Son las dos razones de «silencio decidido» de v1 que aplican a
 * v2 (`sin_mensaje_nuevo` y `cortesia_tras_escalada`, `handoffs.ts`): un turno
 * que se calla sin dejar una de estas dos filas rompe la invariante «ningún lead
 * invisible».
 */
export type RazonDeSilencio = "sin_mensaje_nuevo" | "cortesia_tras_escalada";

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

  /**
   * El turno decidió no escribirle al cliente: deja el rastro (el traspaso de
   * silencio decidido que ya usa v1). Nunca lanza: un rastro que no se pudo
   * escribir queda en el log, no tumba al turno.
   */
  registrarSilencio(razon: RazonDeSilencio): Promise<void>;

  /**
   * Nota interna para el asesor (el cliente no la ve): lo que el cliente agregó
   * mientras espera. LANZA si no se pudo escribir —igual que v1—: un pendiente
   * del cliente no puede perderse en silencio.
   */
  anotarParaAsesor(texto: string): Promise<void>;

  leerEstado(): Promise<EstadoSeba | null>;
  guardarEstado(estado: EstadoSeba): Promise<void>;

  /** `true` si a este turno le toca mandar la bienvenida (una por ventana de 24 h). */
  reclamarBienvenida(): Promise<boolean>;

  marcarVisto(marker: SeenMarker): Promise<void>;

  /** Ids de los productos que ya se le cotizaron al cliente en esta conversación (72 h). */
  productosYaCotizados(): Promise<Set<string>>;

  /**
   * ¿Entró un mensaje del cliente que NO está en `desde`? En modo real decide si el
   * turno cede. `desde` es la marca de TODO lo que este turno ya vio (el marcador de su
   * ráfaga, `RafagaDeTurno.marcador`), nunca la marca «visto» del turno anterior:
   * comparar contra la del turno anterior hacía que los mensajes que el turno estaba
   * contestando contaran como «nuevos» y el turno cediera SIEMPRE, sin enviar nada
   * (R1/C1, 17/11/2026). Con `null` no hay contra qué comparar y la respuesta es `false`.
   */
  hayMensajeNuevoDelCliente(desde: SeenMarker | null): Promise<boolean>;

  /**
   * El cliente ya espera a una persona (hay una escalada abierta que nadie tomó o un
   * asesor asignado): toda salida de este turno es automática (`is_auto_reply`), para
   * que una respuesta informativa no apague `awaiting_reply` y el chat no desaparezca
   * de «Pendientes» y «Sin dueño» (R1/C3, 17/11/2026). El turno la llama una vez, al
   * cargar los datos. Síncrona y sin efecto externo.
   */
  clienteEsperaPersona(): void;

  /** Registra el turno. En sombra y copiloto escribe el borrador. Se llama UNA vez. */
  cerrar(resumen: ResumenDeTurno): Promise<void>;
}
