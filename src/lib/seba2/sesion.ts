import type { MotivoV2 } from "@/lib/seba2/motivos";
import type { Area, EstadoSeba, GuardaDisparada } from "@/lib/seba2/tipos";

/**
 * Lo que un turno de Seba v2 va sabiendo de sí mismo mientras corre.
 *
 * Las herramientas (`prepararPago`, `pasarAAsesor`, `recibirComprobante`) no
 * devuelven su efecto al turno: lo anotan acá. Así el turno sabe, sin releer
 * nada, si una herramienta ya cerró la conversación por este turno, a qué área
 * pasó el caso y qué textos de herramientas puede citar una cifra (las fuentes
 * de las guardas de salida).
 *
 * Es un objeto mutable A PROPÓSITO y vive lo que dura un turno: nunca se
 * comparte entre turnos ni se guarda. Lo que sí persiste es `estado`, que el
 * turno entrega a `effects.guardarEstado` al cerrar.
 */
export interface SesionDeTurno {
  /** Estado del pedido. Las herramientas lo REEMPLAZAN (no lo mutan campo a campo). */
  estado: EstadoSeba;
  /** Una herramienta ya dejó dicho todo lo de este turno: el bucle del modelo se corta. */
  terminado: boolean;
  /** Si este turno ya le pasó el caso a un asesor, a dónde y por qué. */
  paso: { area: Area; motivo: MotivoV2 } | null;
  /** Había una escalada abierta al empezar el turno (el cliente ya espera a una persona). */
  escaladaAbierta: boolean;
  /** Nombres de las herramientas que corrieron, en orden. */
  herramientas: string[];
  /** Ids de producto cotizados o pedidos en este turno. */
  productos: Set<string>;
  /** Lo que devolvieron las herramientas en este turno: de ahí puede salir una cifra o un enlace. */
  fuentes: string[];
  /** Guardas de salida que se dispararon. */
  guardas: GuardaDisparada[];
  /** Si la tienda está abierta ahora y, si no, cuándo abre («el lunes a las 8:00 am»). */
  tiendaAbierta: boolean;
  cuandoAbre: string | null;
  /** El reloj del turno: una sola lectura, para que todo el turno hable de la misma hora. */
  ahora: Date;
}

export function crearSesion(inicio: {
  estado: EstadoSeba;
  escaladaAbierta: boolean;
  tiendaAbierta: boolean;
  cuandoAbre: string | null;
  ahora: Date;
}): SesionDeTurno {
  return {
    estado: inicio.estado,
    terminado: false,
    paso: null,
    escaladaAbierta: inicio.escaladaAbierta,
    herramientas: [],
    productos: new Set<string>(),
    fuentes: [],
    guardas: [],
    tiendaAbierta: inicio.tiendaAbierta,
    cuandoAbre: inicio.cuandoAbre,
    ahora: inicio.ahora,
  };
}
