import { tool } from "ai";
import { z } from "zod";
import { errorText, log } from "@/lib/log";
import type { TurnEffects } from "./effects";
import { revisarSalida } from "./guardas";
import { MOTIVOS_V2, areaDeMotivo, type MotivoV2 } from "./motivos";
import type { SesionDeTurno } from "./sesion";
import { TEXTO_PASE, TEXTO_SEGUIMOS_POR_AQUI, lineaTiendaCerrada } from "./textos";

// ---------------------------------------------------------------------------
// `pasarAAsesor`: la única forma en que Seba v2 le entrega un caso a una persona
// (S6, 17/11/2026).
//
// El modelo elige el MOTIVO desde un enum cerrado; el ÁREA la decide
// `areaDeMotivo`, nunca el modelo. Secuencia fija: guarda de salida sobre lo que
// el modelo quiere decirle al cliente → asignar (`effects.pasarAAsesor`) →
// enviar. La asignación va ANTES del envío a propósito: si el envío saliera
// primero y la asignación fallara, el cliente quedaría con la promesa «ya te paso
// con un asesor» sin que nadie lo supiera (la invariante «ningún lead
// invisible»). Si la asignación LANZA no se relanza: al cliente se le contesta
// con un texto que no promete a nadie y el turno termina.
//
// La herramienta termina el turno (`sesion.terminado`): no queda nada más que
// decirle al cliente.
// ---------------------------------------------------------------------------

export const NOMBRE_PASAR_A_ASESOR = "pasarAAsesor";

export interface DepsDePase {
  effects: TurnEffects;
  sesion: SesionDeTurno;
  /** Lo que el cliente escribió en la ráfaga que se está respondiendo. */
  rafaga: string[];
  /** `display_name` de los asesores, para que el modelo no nombre a ninguno. */
  nombresDeAsesores: string[];
}

const AVISO_YA_PASADO = "El caso ya está con un asesor: no lo pases de nuevo.";
const AVISO_SIN_ASIGNAR = "No se pudo asignar el caso; ya se le avisó al cliente. No escribas nada más.";

export async function ejecutarPase(
  deps: DepsDePase,
  entrada: { motivo: MotivoV2; nota: string; mensajeAlCliente: string },
): Promise<string> {
  const { effects, sesion } = deps;
  sesion.herramientas.push(NOMBRE_PASAR_A_ASESOR);

  // Un solo pase por turno, y ninguno si ya había una escalada abierta: el
  // cliente ya espera a una persona y repetirle «ya te paso» no aporta nada.
  if (sesion.paso !== null || sesion.escaladaAbierta) return AVISO_YA_PASADO;

  const area = areaDeMotivo(entrada.motivo);

  // 1. Qué texto sale. Si la guarda rechaza lo que escribió el modelo, sale el
  // texto fijo del área: el pase no se frena por una frase mal redactada.
  const veredicto = revisarSalida(entrada.mensajeAlCliente, {
    fuentes: sesion.fuentes,
    pasoEnEsteTurno: true,
    nombresDeAsesores: deps.nombresDeAsesores,
    rafaga: deps.rafaga,
  });
  if (!veredicto.ok) sesion.guardas.push({ guarda: veredicto.guarda, fragmento: veredicto.fragmento });
  const texto = veredicto.ok ? entrada.mensajeAlCliente : TEXTO_PASE[area];

  // 2. Asignar ANTES de enviar.
  let resultado;
  try {
    resultado = await effects.pasarAAsesor({ area, motivo: entrada.motivo, nota: entrada.nota });
  } catch (error) {
    log.error("seba2_pase_no_asignado", {
      area,
      motivo: entrada.motivo,
      detail: errorText(error),
    });
    await effects.enviarTexto(TEXTO_SEGUIMOS_POR_AQUI, "fijo");
    sesion.terminado = true;
    return AVISO_SIN_ASIGNAR;
  }

  // 3. Enviar.
  await effects.enviarTexto(texto, veredicto.ok ? "modelo" : "fijo");
  if (!resultado.abierta && resultado.cuandoAbre) {
    await effects.enviarTexto(lineaTiendaCerrada(resultado.cuandoAbre), "fijo");
  }

  // 4. El turno lo sabe.
  sesion.paso = { area, motivo: entrada.motivo };
  sesion.estado = { ...sesion.estado, etapa: "con_asesor", actualizadoEn: sesion.ahora.toISOString() };
  sesion.terminado = true;
  return `Listo: el caso pasó a ${area}. No escribas nada más.`;
}

export function buildPasarAAsesorTool(deps: DepsDePase) {
  return tool({
    description:
      "Pasa la conversación a una persona del equipo y le escribe al cliente que ya la tiene. Elige el motivo que mejor describa el caso; el área que lo atiende la decide el sistema según el motivo. Úsala cuando el cliente está listo para comprar, pide hablar con una persona, tiene un reclamo, un problema con un pago o un envío, o cuando no puedes resolver lo que pide. Después de llamarla no escribas nada más: el sistema ya le avisó al cliente.",
    inputSchema: z.object({
      motivo: z
        .enum(MOTIVOS_V2 as unknown as [MotivoV2, ...MotivoV2[]])
        .describe("Por qué pasa el caso. Un valor de la lista; no inventes otro."),
      nota: z
        .string()
        .min(10)
        .max(600)
        .describe(
          "Nota interna para el asesor: qué quiere el cliente, qué se le cotizó o dijo y qué falta. Que no tenga que volver a preguntar todo. El cliente no la ve.",
        ),
      mensajeAlCliente: z
        .string()
        .min(10)
        .max(300)
        .describe("Una o dos frases para el cliente avisándole que su caso pasa a una persona. Sin nombres propios ni promesas de tiempo."),
    }),
    execute: async (entrada) => ejecutarPase(deps, entrada),
  });
}
