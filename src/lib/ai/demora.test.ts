import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import {
  evaluarDemora,
  type EpisodioGuardado,
  type EstadoDemora,
} from "./demora";

// Todas las fechas son fijas (lunes 28/9/2026, Caracas = UTC-4 sin horario de
// verano): NUNCA el reloj real. Un test de demora que dependa de la hora en que
// corre la suite se pone rojo fuera de horario laboral sin que nada haya
// cambiado (misma lección de `playbooks.test.ts`, 15/9/2026).
const en = (dia: number, hora: number, minuto = 0, segundo = 0): Date =>
  new Date(Date.UTC(2026, 8, dia, hora + 4, minuto, segundo));

/** Lunes 28/9/2026, hora de Caracas. */
const lun = (hora: number, minuto = 0, segundo = 0): Date => en(28, hora, minuto, segundo);

const ASESOR_A = "11111111-1111-1111-1111-111111111111";
const ASESOR_B = "22222222-2222-2222-2222-222222222222";

const HORARIO = DEFAULT_BUSINESS_HOURS;

/** Estado base: demora encendida desde el domingo, conversación abierta, nada pendiente. */
function estado(parche: Partial<EstadoDemora> = {}): EstadoDemora {
  return {
    demoraActiva: true,
    demoraActivaDesde: en(27, 9),
    abierta: true,
    awaitingReply: false,
    ventanaAbierta: true,
    rafagaSoloCortesia: false,
    asesorAsignadoId: ASESOR_A,
    lastCustomerMessageAt: null,
    ultimaSalidaAt: null,
    ultimoMensajeAsesorAt: null,
    traspasos: [],
    episodios: [],
    ...parche,
  };
}

function episodio(parche: Partial<EpisodioGuardado> & { episodeAt: Date }): EpisodioGuardado {
  return {
    origen: "escalada",
    respondedAt: null,
    reassignments: 0,
    agentesPrevios: [],
    ultimaReasignacionAt: null,
    supervisorNotifiedAt: null,
    ...parche,
  };
}

/** Escalada a las 10:00 con la despedida de Seba pegada (el cliente no vuelve a escribir). */
function escaladaDe10(parche: Partial<EstadoDemora> = {}): EstadoDemora {
  return estado({
    lastCustomerMessageAt: lun(9, 58),
    ultimaSalidaAt: lun(10, 0, 5),
    traspasos: [{ reason: "escalada", createdAt: lun(10, 0) }],
    ...parche,
  });
}

describe("evaluarDemora — origen 1: escalada abierta sin mensaje del asesor", () => {
  it("escalada 10:00: a las 10:10 nada, a las 10:15 reasigna", () => {
    const e = escaladaDe10();
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");

    const r = evaluarDemora(e, lun(10, 15), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect(r.episodio).toEqual({ origen: "escalada", episodeAt: lun(10, 0) });
  });

  it("no responde a los 10 min: Seba ya respondió al escalar (sin mensaje nuevo del cliente)", () => {
    const r = evaluarDemora(escaladaDe10(), lun(10, 10), HORARIO);
    expect(r.accion).toBe("nada");
  });

  it("cuenta desde el traspaso aunque awaiting_reply sea false (la despedida lo apaga)", () => {
    const e = escaladaDe10({ awaitingReply: false });
    expect(evaluarDemora(e, lun(10, 15), HORARIO).accion).toBe("reasignar");
  });

  it("escalada_sin_asesor también abre el episodio y reasigna sin asesor asignado", () => {
    const e = escaladaDe10({
      asesorAsignadoId: null,
      traspasos: [{ reason: "escalada_sin_asesor", createdAt: lun(10, 0) }],
    });
    const r = evaluarDemora(e, lun(10, 15), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect(r.excluir).toEqual([]);
  });

  it("reasignar excluye al asesor actual y a los que ya rotaron en el episodio (D4)", () => {
    const e = escaladaDe10({
      episodios: [
        episodio({
          episodeAt: lun(10, 0),
          reassignments: 1,
          agentesPrevios: [ASESOR_B],
          ultimaReasignacionAt: lun(10, 15),
        }),
      ],
    });
    const r = evaluarDemora(e, lun(10, 30), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect([...(r.excluir ?? [])].sort()).toEqual([ASESOR_A, ASESOR_B].sort());
  });

  it("esperaMinutos de la segunda reasignación cuenta lo que el asesor saliente tuvo el caso (15), no desde la escalada (30)", () => {
    // 29/9/2026, prueba a mano: la nota decía "ASESOR 3 no contestó en 30 min"
    // cuando ese asesor recibió el caso a las 10:15 y lo perdió a las 10:30.
    const e = escaladaDe10({
      asesorAsignadoId: ASESOR_B,
      traspasos: [
        { reason: "escalada", createdAt: lun(10, 0) },
        { reason: "reasignada_por_demora", createdAt: lun(10, 15) },
      ],
      episodios: [
        episodio({
          episodeAt: lun(10, 0),
          reassignments: 1,
          agentesPrevios: [ASESOR_A],
          ultimaReasignacionAt: lun(10, 15),
        }),
      ],
    });
    const r = evaluarDemora(e, lun(10, 30), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect(r.esperaMinutos).toBe(15);
  });

  it("esperaMinutos de la primera reasignación sigue contando desde la escalada", () => {
    const r = evaluarDemora(escaladaDe10(), lun(10, 15), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect(r.esperaMinutos).toBe(15);
  });

  it("14:59 no reasigna y 15:00 sí (no se adelanta el plazo)", () => {
    const e = escaladaDe10();
    expect(evaluarDemora(e, lun(10, 14, 59), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(e, lun(10, 15, 0), HORARIO).accion).toBe("reasignar");
  });

  it("TEST DEL PLAN: 10:00 → 10:10 nada, 10:15 reasigna, 10:30 reasigna, 10:45 avisa al supervisor y no rota más", () => {
    // Estado del episodio tal como lo dejaría el cron entre pasadas: la fila
    // de `conversation_delay_episodes` acumula reasignaciones bajo el MISMO
    // `episode_at` (10:00) aunque el último traspaso ya sea `reasignada_por_demora`.
    const base = escaladaDe10();

    expect(evaluarDemora(base, lun(10, 10), HORARIO).accion).toBe("nada");

    // 10:15: primera reasignación.
    expect(evaluarDemora(base, lun(10, 15), HORARIO).accion).toBe("reasignar");

    // 10:30: el traspaso más reciente ya es `reasignada_por_demora`.
    const tras1 = escaladaDe10({
      asesorAsignadoId: ASESOR_B,
      traspasos: [
        { reason: "escalada", createdAt: lun(10, 0) },
        { reason: "reasignada_por_demora", createdAt: lun(10, 15) },
      ],
      episodios: [
        episodio({
          episodeAt: lun(10, 0),
          reassignments: 1,
          agentesPrevios: [ASESOR_A],
          ultimaReasignacionAt: lun(10, 15),
        }),
      ],
    });
    // 10:29 todavía no: los 15 min se cuentan desde la última reasignación.
    expect(evaluarDemora(tras1, lun(10, 29), HORARIO).accion).toBe("nada");
    const r30 = evaluarDemora(tras1, lun(10, 30), HORARIO);
    expect(r30.accion).toBe("reasignar");
    expect(r30.episodio).toEqual({ origen: "escalada", episodeAt: lun(10, 0) });

    // 10:45: tope de 2 (D3) → avisa al supervisor.
    const tras2 = escaladaDe10({
      asesorAsignadoId: ASESOR_A,
      traspasos: [
        { reason: "escalada", createdAt: lun(10, 0) },
        { reason: "reasignada_por_demora", createdAt: lun(10, 15) },
        { reason: "reasignada_por_demora", createdAt: lun(10, 30) },
      ],
      episodios: [
        episodio({
          episodeAt: lun(10, 0),
          reassignments: 2,
          agentesPrevios: [ASESOR_A, ASESOR_B],
          ultimaReasignacionAt: lun(10, 30),
        }),
      ],
    });
    expect(evaluarDemora(tras2, lun(10, 44), HORARIO).accion).toBe("nada");
    const r45 = evaluarDemora(tras2, lun(10, 45), HORARIO);
    expect(r45.accion).toBe("avisar_supervisor");
    expect(r45.episodio).toEqual({ origen: "escalada", episodeAt: lun(10, 0) });

    // Ya avisado: ni rota más ni vuelve a avisar, pase lo que pase.
    const avisado = {
      ...tras2,
      episodios: [
        episodio({
          episodeAt: lun(10, 0),
          reassignments: 2,
          agentesPrevios: [ASESOR_A, ASESOR_B],
          ultimaReasignacionAt: lun(10, 30),
          supervisorNotifiedAt: lun(10, 45, 10),
        }),
      ],
    };
    expect(evaluarDemora(avisado, lun(10, 46), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(avisado, lun(11, 30), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(avisado, lun(15, 0), HORARIO).accion).toBe("nada");
  });

  it("un asesor que escribió después de la escalada cierra el episodio", () => {
    const e = escaladaDe10({ ultimoMensajeAsesorAt: lun(10, 7) });
    expect(evaluarDemora(e, lun(10, 15), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(e, lun(10, 45), HORARIO).accion).toBe("nada");
  });

  it("un asesor que escribió ANTES de la escalada no la cierra", () => {
    const e = escaladaDe10({ ultimoMensajeAsesorAt: lun(9, 30) });
    expect(evaluarDemora(e, lun(10, 15), HORARIO).accion).toBe("reasignar");
  });

  it("si el último traspaso ya no es una escalada (devuelta a la IA, asesor lo reclamó) no hay episodio", () => {
    const e = escaladaDe10({
      traspasos: [
        { reason: "escalada", createdAt: lun(10, 0) },
        { reason: "devuelto_a_ia", createdAt: lun(10, 5) },
      ],
    });
    expect(evaluarDemora(e, lun(10, 15), HORARIO).accion).toBe("nada");
  });

  it("los traspasos llegan en cualquier orden: manda el más reciente", () => {
    const e = escaladaDe10({
      traspasos: [
        { reason: "reasignada_por_demora", createdAt: lun(10, 15) },
        { reason: "escalada", createdAt: lun(10, 0) },
      ],
      episodios: [
        episodio({ episodeAt: lun(10, 0), reassignments: 1, ultimaReasignacionAt: lun(10, 15) }),
      ],
    });
    const r = evaluarDemora(e, lun(10, 30), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect(r.episodio?.episodeAt).toEqual(lun(10, 0));
  });

  it("reasignada_por_demora sin una escalada detrás no es un episodio de escalada", () => {
    const e = escaladaDe10({
      traspasos: [{ reason: "reasignada_por_demora", createdAt: lun(10, 15) }],
    });
    expect(evaluarDemora(e, lun(10, 30), HORARIO).accion).toBe("nada");
  });

  it("una escalada nueva después de una cadena de reasignaciones abre su propio episodio", () => {
    const e = escaladaDe10({
      traspasos: [
        { reason: "escalada", createdAt: lun(10, 0) },
        { reason: "reasignada_por_demora", createdAt: lun(10, 15) },
        { reason: "escalada", createdAt: lun(11, 0) },
      ],
      episodios: [
        episodio({ episodeAt: lun(10, 0), reassignments: 1, ultimaReasignacionAt: lun(10, 15) }),
      ],
    });
    const r = evaluarDemora(e, lun(11, 15), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect(r.episodio?.episodeAt).toEqual(lun(11, 0));
    // El episodio nuevo arranca sin reasignaciones ni exclusiones heredadas.
    expect(r.excluir).toEqual([ASESOR_A]);
  });

  it("si el cliente escribió DESPUÉS de la despedida, sí responde a los 10 min (el origen 2 no aplica)", () => {
    // awaiting_reply en false a propósito: sin el origen 2 valido, es el origen 1
    // quien responde, contando desde el mensaje nuevo.
    const e = escaladaDe10({
      awaitingReply: false,
      lastCustomerMessageAt: lun(10, 5),
    });
    expect(evaluarDemora(e, lun(10, 14, 59), HORARIO).accion).toBe("nada");
    const r = evaluarDemora(e, lun(10, 15), HORARIO);
    // 10:15 es a la vez 10 min del mensaje nuevo y 15 de la escalada: la
    // reasignación pasa primero (ver el comentario de `evaluarDemora`).
    expect(r.accion).toBe("reasignar");
  });

  it("mensaje nuevo del cliente tras la escalada, a los 10 min del mensaje y antes de los 15 de la escalada: responde", () => {
    const e = escaladaDe10({
      awaitingReply: false,
      lastCustomerMessageAt: lun(10, 2),
    });
    const r = evaluarDemora(e, lun(10, 12), HORARIO);
    expect(r.accion).toBe("responder");
    expect(r.episodio?.origen).toBe("escalada");
    expect(r.episodio?.episodeAt).toEqual(lun(10, 0));
  });

  it("en el origen 1 tampoco responde a un 'ok'/'gracias'/sticker posterior a la despedida", () => {
    const e = escaladaDe10({
      awaitingReply: false,
      lastCustomerMessageAt: lun(10, 2),
      rafagaSoloCortesia: true,
    });
    expect(evaluarDemora(e, lun(10, 12), HORARIO).accion).toBe("nada");
  });

  it("origen 1 con mensaje nuevo pero ya respondido (responded_at) no vuelve a responder", () => {
    const e = escaladaDe10({
      awaitingReply: false,
      lastCustomerMessageAt: lun(10, 2),
      episodios: [episodio({ episodeAt: lun(10, 0), respondedAt: lun(10, 12, 3) })],
    });
    expect(evaluarDemora(e, lun(10, 13), HORARIO).accion).toBe("nada");
  });
});

describe("evaluarDemora — origen 2: mensaje del cliente sin respuesta real", () => {
  const pendiente = (parche: Partial<EstadoDemora> = {}): EstadoDemora =>
    estado({
      awaitingReply: true,
      lastCustomerMessageAt: lun(10, 0),
      ultimaSalidaAt: lun(9, 0),
      ...parche,
    });

  it("9:59 no responde y 10:00 sí (el plazo es >= 10 min, no >)", () => {
    const e = pendiente();
    expect(evaluarDemora(e, lun(10, 9, 59), HORARIO).accion).toBe("nada");
    const r = evaluarDemora(e, lun(10, 10, 0), HORARIO);
    expect(r.accion).toBe("responder");
    expect(r.episodio).toEqual({ origen: "cliente", episodeAt: lun(10, 0) });
    expect(r.esperaMinutos).toBe(10);
  });

  it("responde una sola vez por episodio (responded_at)", () => {
    const e = pendiente({
      episodios: [episodio({ episodeAt: lun(10, 0), origen: "cliente", respondedAt: lun(10, 10, 4) })],
    });
    expect(evaluarDemora(e, lun(10, 11), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(e, lun(10, 14), HORARIO).accion).toBe("nada");
  });

  it("a los 15 min, con asesor asignado y en horario, reasigna", () => {
    const e = pendiente({
      episodios: [episodio({ episodeAt: lun(10, 0), origen: "cliente", respondedAt: lun(10, 10, 4) })],
    });
    const r = evaluarDemora(e, lun(10, 15), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect(r.episodio).toEqual({ origen: "cliente", episodeAt: lun(10, 0) });
    expect(r.excluir).toEqual([ASESOR_A]);
  });

  it("sin asesor y sin escalada abierta no hay a quién reasignar: solo responde", () => {
    const e = pendiente({ asesorAsignadoId: null });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("responder");
    const conRespuesta = pendiente({
      asesorAsignadoId: null,
      episodios: [episodio({ episodeAt: lun(10, 0), origen: "cliente", respondedAt: lun(10, 10, 4) })],
    });
    expect(evaluarDemora(conRespuesta, lun(10, 15), HORARIO).accion).toBe("nada");
  });

  it("sin asesor pero con la escalada abierta (sin_asesor) sí reasigna", () => {
    const e = pendiente({
      asesorAsignadoId: null,
      traspasos: [{ reason: "escalada_sin_asesor", createdAt: lun(9, 30) }],
      episodios: [episodio({ episodeAt: lun(10, 0), origen: "cliente", respondedAt: lun(10, 10, 4) })],
    });
    expect(evaluarDemora(e, lun(10, 15), HORARIO).accion).toBe("reasignar");
  });

  it("'ok'/'gracias'/sticker (ráfaga solo de cortesía) no dispara nada", () => {
    const e = pendiente({ rafagaSoloCortesia: true });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(e, lun(10, 30), HORARIO).accion).toBe("nada");
  });

  it("conversación cerrada no dispara nada", () => {
    const e = pendiente({ abierta: false });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");
  });

  it("sin awaiting_reply no hay episodio del cliente", () => {
    const e = pendiente({ awaitingReply: false });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");
  });

  it("con la ventana de 24 h cerrada no hay episodio del cliente", () => {
    const e = pendiente({ ventanaAbierta: false });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");
  });

  it("un asesor que escribió después del mensaje del cliente lo da por atendido", () => {
    const e = pendiente({ ultimoMensajeAsesorAt: lun(10, 3) });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(e, lun(10, 30), HORARIO).accion).toBe("nada");
  });

  it("un asesor que escribió ANTES del mensaje del cliente no lo atiende", () => {
    const e = pendiente({ ultimoMensajeAsesorAt: lun(9, 30) });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("responder");
  });

  it("sin last_customer_message_at no hay episodio", () => {
    const e = pendiente({ lastCustomerMessageAt: null });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");
  });

  it("origen 2 con ventana cerrada en origen 1 sigue reasignando pero no responde", () => {
    const e = escaladaDe10({
      awaitingReply: true,
      ventanaAbierta: false,
      lastCustomerMessageAt: lun(10, 2),
    });
    expect(evaluarDemora(e, lun(10, 12), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(e, lun(10, 15), HORARIO).accion).toBe("reasignar");
  });
});

describe("evaluarDemora — el más reciente de los dos orígenes gana", () => {
  it("cliente que escribe tras la escalada: gana su mensaje (origen cliente), y su reloj arranca ahí", () => {
    const e = escaladaDe10({
      awaitingReply: true,
      lastCustomerMessageAt: lun(10, 20),
      traspasos: [{ reason: "escalada", createdAt: lun(10, 0) }],
    });
    // 10:29: a 9 min del mensaje → nada (aunque la escalada lleve 29).
    // ... y tampoco reasigna: los 15 min se cuentan desde el mensaje más reciente.
    expect(evaluarDemora(e, lun(10, 29), HORARIO).accion).toBe("nada");
    const r = evaluarDemora(e, lun(10, 30), HORARIO);
    expect(r.accion).toBe("responder");
    expect(r.episodio).toEqual({ origen: "cliente", episodeAt: lun(10, 20) });
  });

  it("escalada posterior al mensaje del cliente: gana la escalada", () => {
    const e = estado({
      awaitingReply: true,
      lastCustomerMessageAt: lun(10, 0),
      ultimaSalidaAt: lun(10, 5, 5),
      traspasos: [{ reason: "escalada", createdAt: lun(10, 5) }],
    });
    // Con el origen del cliente (10:00) habría respondido a las 10:10; la
    // escalada (10:05) es más reciente: Seba ya habló y a las 10:10 no repite.
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");
    const r = evaluarDemora(e, lun(10, 20), HORARIO);
    expect(r.accion).toBe("reasignar");
    expect(r.episodio).toEqual({ origen: "escalada", episodeAt: lun(10, 5) });
  });

  it("empate exacto: gana la escalada", () => {
    const e = estado({
      awaitingReply: true,
      lastCustomerMessageAt: lun(10, 0),
      traspasos: [{ reason: "escalada", createdAt: lun(10, 0) }],
      ultimaSalidaAt: lun(10, 0, 2),
    });
    expect(evaluarDemora(e, lun(10, 15), HORARIO).episodio?.origen).toBe("escalada");
  });
});

describe("evaluarDemora — interruptor, backlog y horario", () => {
  it("demora apagada: nada, aunque haya de todo pendiente", () => {
    const e = escaladaDe10({ demoraActiva: false });
    expect(evaluarDemora(e, lun(10, 45), HORARIO).accion).toBe("nada");
    const c = estado({
      demoraActiva: false,
      awaitingReply: true,
      lastCustomerMessageAt: lun(10, 0),
    });
    expect(evaluarDemora(c, lun(10, 10), HORARIO).accion).toBe("nada");
  });

  it("demora encendida sin fecha de encendido: falla cerrado (no dispara el backlog)", () => {
    const e = escaladaDe10({ demoraActivaDesde: null });
    expect(evaluarDemora(e, lun(10, 45), HORARIO).accion).toBe("nada");
  });

  it("backlog anterior a demora_activa_desde no dispara (origen 2)", () => {
    const e = estado({
      demoraActivaDesde: lun(10, 0, 1),
      awaitingReply: true,
      lastCustomerMessageAt: lun(10, 0),
    });
    expect(evaluarDemora(e, lun(10, 10), HORARIO).accion).toBe("nada");
    // Un mensaje posterior al encendido sí.
    const nuevo = { ...e, lastCustomerMessageAt: lun(10, 1) };
    expect(evaluarDemora(nuevo, lun(10, 11), HORARIO).accion).toBe("responder");
  });

  it("backlog anterior a demora_activa_desde no dispara (origen 1)", () => {
    const e = escaladaDe10({ demoraActivaDesde: lun(10, 0, 1) });
    expect(evaluarDemora(e, lun(10, 15), HORARIO).accion).toBe("nada");
  });

  it("la fecha de encendido es estricta: un origen justo EN el encendido no cuenta", () => {
    const e = escaladaDe10({ demoraActivaDesde: lun(10, 0) });
    expect(evaluarDemora(e, lun(10, 15), HORARIO).accion).toBe("nada");
  });

  it("fuera de horario no reasigna", () => {
    // 17:50 escalada; a las 18:15 la tienda ya cerró.
    const e = escaladaDe10({
      lastCustomerMessageAt: lun(17, 48),
      ultimaSalidaAt: lun(17, 50, 5),
      traspasos: [{ reason: "escalada", createdAt: lun(17, 50) }],
    });
    expect(evaluarDemora(e, lun(18, 15), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(e, lun(23, 0), HORARIO).accion).toBe("nada");
  });

  it("sábado (cerrado) no reasigna, y al abrir el lunes cuenta 15 min de horario, no de pared", () => {
    const sab = escaladaDe10({
      lastCustomerMessageAt: en(26, 11, 58),
      ultimaSalidaAt: en(26, 12, 0, 5),
      traspasos: [{ reason: "escalada", createdAt: en(26, 12, 0) }],
      demoraActivaDesde: en(20, 9),
    });
    expect(evaluarDemora(sab, en(26, 12, 30), HORARIO).accion).toBe("nada");
    // Lunes 08:00 en punto: pasó el fin de semana entero de pared, pero el
    // asesor tiene 0 minutos de horario para atenderlo.
    expect(evaluarDemora(sab, lun(8, 0), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(sab, lun(8, 14), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(sab, lun(8, 15), HORARIO).accion).toBe("reasignar");
  });

  it("fuera de horario Seba sí responde a los 10 min (el cliente no espera en silencio hasta la mañana)", () => {
    const e = estado({
      awaitingReply: true,
      lastCustomerMessageAt: lun(20, 0),
      ultimaSalidaAt: lun(19, 0),
      demoraActivaDesde: en(20, 9),
    });
    expect(evaluarDemora(e, lun(20, 9, 59), HORARIO).accion).toBe("nada");
    expect(evaluarDemora(e, lun(20, 10), HORARIO).accion).toBe("responder");
  });

  it("en horario, a los 15 min sin responder todavía, prefiere reasignar (nadie queda esperando por Seba)", () => {
    const e = estado({
      awaitingReply: true,
      lastCustomerMessageAt: lun(10, 0),
    });
    expect(evaluarDemora(e, lun(10, 16), HORARIO).accion).toBe("reasignar");
  });

  it("fuera de horario, con 15 min cumplidos y sin responder, Seba responde (no reasigna)", () => {
    const e = estado({
      awaitingReply: true,
      lastCustomerMessageAt: lun(18, 30),
      demoraActivaDesde: en(20, 9),
    });
    const r = evaluarDemora(e, lun(18, 50), HORARIO);
    expect(r.accion).toBe("responder");
  });

  it("tope: con dos reasignaciones no vuelve a reasignar ni fuera ni dentro del plazo", () => {
    const e = escaladaDe10({
      episodios: [
        episodio({
          episodeAt: lun(10, 0),
          reassignments: 2,
          ultimaReasignacionAt: lun(10, 30),
          supervisorNotifiedAt: lun(10, 45, 3),
        }),
      ],
    });
    for (const t of [lun(11, 0), lun(12, 0), lun(17, 0)]) {
      expect(evaluarDemora(e, t, HORARIO).accion).toBe("nada");
    }
  });

  it("el aviso al supervisor también espera horario laboral", () => {
    const e = escaladaDe10({
      lastCustomerMessageAt: lun(17, 20),
      ultimaSalidaAt: lun(17, 30, 5),
      traspasos: [{ reason: "escalada", createdAt: lun(17, 0) }],
      episodios: [
        episodio({ episodeAt: lun(17, 0), reassignments: 2, ultimaReasignacionAt: lun(17, 45) }),
      ],
    });
    expect(evaluarDemora(e, lun(17, 55), HORARIO).accion).toBe("nada");
    // 18:30: cerrado. El aviso llegaría a un panel sin nadie mirando.
    expect(evaluarDemora(e, lun(18, 30), HORARIO).accion).toBe("nada");
  });

  it("dos pasadas con el mismo estado dan la misma acción (la función es pura)", () => {
    const e = escaladaDe10();
    const a = evaluarDemora(e, lun(10, 15), HORARIO);
    const b = evaluarDemora(e, lun(10, 15), HORARIO);
    expect(b).toEqual(a);
  });
});
