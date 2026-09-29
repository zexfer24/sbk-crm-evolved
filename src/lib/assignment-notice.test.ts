import { describe, expect, it, beforeEach } from "vitest";
import {
  isAssignmentNotice,
  isDelayEscalationNotice,
  shouldShowDelayEscalationNotice,
  markAssignmentNoticeSeen,
  resetAssignmentNoticeDedupe,
  shouldShowAssignmentNotice,
  type AssignmentHandoffRow,
} from "@/lib/assignment-notice";

const MI_AGENTE = "11111111-1111-1111-1111-111111111111";
const OTRO_AGENTE = "22222222-2222-2222-2222-222222222222";

function handoff(overrides: Partial<AssignmentHandoffRow> = {}): AssignmentHandoffRow {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    to_kind: "human",
    to_id: MI_AGENTE,
    reason: "escalada",
    ...overrides,
  };
}

beforeEach(() => {
  resetAssignmentNoticeDedupe();
});

describe("isAssignmentNotice", () => {
  it("avisa cuando la IA escaló al asesor que mira la pantalla", () => {
    expect(isAssignmentNotice(handoff(), MI_AGENTE)).toBe(true);
  });

  it("avisa también cuando el cron de demora te reasignó el caso (reasignada_por_demora)", () => {
    expect(isAssignmentNotice(handoff({ reason: "reasignada_por_demora" }), MI_AGENTE)).toBe(true);
  });

  it("no avisa con reasignada_por_demora si el caso se le pasó a OTRO asesor", () => {
    expect(
      isAssignmentNotice(handoff({ reason: "reasignada_por_demora", to_id: OTRO_AGENTE }), MI_AGENTE)
    ).toBe(false);
  });

  it("no avisa con demora_sin_asesor: es el aviso a supervisores, no una asignación", () => {
    expect(isAssignmentNotice(handoff({ reason: "demora_sin_asesor" }), MI_AGENTE)).toBe(false);
  });

  it("no avisa con reason 'asignada': el turno la escribe en CADA mensaje de una conversación que ya tiene dueño, no solo cuando se asigna algo nuevo — avisar acá dispararía el aviso una vez por mensaje del cliente durante toda la conversación", () => {
    expect(isAssignmentNotice(handoff({ reason: "asignada" }), MI_AGENTE)).toBe(false);
  });

  it("no avisa cuando el traspaso es para OTRO asesor", () => {
    expect(isAssignmentNotice(handoff({ to_id: OTRO_AGENTE }), MI_AGENTE)).toBe(false);
  });

  it("no avisa con to_kind 'unassigned'", () => {
    expect(
      isAssignmentNotice(handoff({ to_kind: "unassigned", to_id: null }), MI_AGENTE)
    ).toBe(false);
  });

  it("no avisa con to_kind 'ai'", () => {
    expect(isAssignmentNotice(handoff({ to_kind: "ai", to_id: null }), MI_AGENTE)).toBe(false);
  });

  it("no avisa con to_kind 'closed'", () => {
    expect(isAssignmentNotice(handoff({ to_kind: "closed", to_id: null }), MI_AGENTE)).toBe(
      false
    );
  });

  it("no avisa con to_id null aunque to_kind y reason calcen", () => {
    expect(isAssignmentNotice(handoff({ to_id: null }), MI_AGENTE)).toBe(false);
  });
});

describe("dedupe por id de handoff (Set de módulo)", () => {
  it("el mismo id de handoff dos veces avisa una sola vez", () => {
    const fila = handoff({ id: "id-1" });
    expect(shouldShowAssignmentNotice(fila, MI_AGENTE)).toBe(true);
    expect(shouldShowAssignmentNotice(fila, MI_AGENTE)).toBe(false);
  });

  it("dos ids distintos avisan dos veces", () => {
    expect(shouldShowAssignmentNotice(handoff({ id: "id-1" }), MI_AGENTE)).toBe(true);
    expect(shouldShowAssignmentNotice(handoff({ id: "id-2" }), MI_AGENTE)).toBe(true);
  });

  it("markAssignmentNoticeSeen por sí solo respeta el mismo dedupe", () => {
    expect(markAssignmentNoticeSeen("id-1")).toBe(true);
    expect(markAssignmentNoticeSeen("id-1")).toBe(false);
    expect(markAssignmentNoticeSeen("id-2")).toBe(true);
  });

  it("resetAssignmentNoticeDedupe vacía el Set para el siguiente test", () => {
    markAssignmentNoticeSeen("id-1");
    resetAssignmentNoticeDedupe();
    expect(markAssignmentNoticeSeen("id-1")).toBe(true);
  });

  it("una fila que no pasa la regla nunca marca el dedupe (no gasta el Set)", () => {
    const fila = handoff({ id: "id-1", reason: "asignada" });
    expect(shouldShowAssignmentNotice(fila, MI_AGENTE)).toBe(false);
    // Si hubiera marcado el dedupe igual, una escalada real con el mismo id
    // (no puede pasar en la práctica, pero prueba el aislamiento) quedaría
    // silenciada. markAssignmentNoticeSeen todavía la ve como nueva:
    expect(markAssignmentNoticeSeen("id-1")).toBe(true);
  });
});

describe("isDelayEscalationNotice (T10b-5, 29/9/2026): el aviso a supervisores de que ya no hay a quién rotar", () => {
  const SIN_ASESOR = { to_kind: "unassigned", to_id: null, reason: "demora_sin_asesor" };

  it("avisa a un supervisor cuando llega demora_sin_asesor", () => {
    expect(isDelayEscalationNotice(handoff(SIN_ASESOR), "supervisor")).toBe(true);
  });

  it("avisa a un admin", () => {
    expect(isDelayEscalationNotice(handoff(SIN_ASESOR), "admin")).toBe(true);
  });

  it("avisa aunque el traspaso quede en manos de un asesor (mismo dueño): no mira to_kind ni to_id", () => {
    expect(isDelayEscalationNotice(handoff({ reason: "demora_sin_asesor" }), "supervisor")).toBe(true);
  });

  it("NO avisa a un asesor común, ni siquiera si el traspaso lo deja a él como dueño", () => {
    expect(isDelayEscalationNotice(handoff({ reason: "demora_sin_asesor", to_id: MI_AGENTE }), "agent")).toBe(false);
  });

  it("NO avisa si el rol todavía no se resolvió (null/undefined): en la duda, callar", () => {
    expect(isDelayEscalationNotice(handoff(SIN_ASESOR), null)).toBe(false);
    expect(isDelayEscalationNotice(handoff(SIN_ASESOR), undefined)).toBe(false);
  });

  it.each(["escalada", "reasignada_por_demora", "asignada", "escalada_sin_asesor"])(
    "no avisa con la razón %s: solo demora_sin_asesor es este aviso",
    (reason) => {
      expect(isDelayEscalationNotice(handoff({ reason }), "supervisor")).toBe(false);
    }
  );
});

describe("shouldShowDelayEscalationNotice: la regla más el dedupe compartido", () => {
  it("el mismo id dos veces avisa una sola vez", () => {
    const fila = handoff({ id: "d-1", reason: "demora_sin_asesor", to_kind: "unassigned", to_id: null });
    expect(shouldShowDelayEscalationNotice(fila, "supervisor")).toBe(true);
    expect(shouldShowDelayEscalationNotice(fila, "supervisor")).toBe(false);
  });

  it("un asesor no gasta el dedupe: si después el rol se resuelve como supervisor, todavía avisa", () => {
    const fila = handoff({ id: "d-2", reason: "demora_sin_asesor" });
    expect(shouldShowDelayEscalationNotice(fila, "agent")).toBe(false);
    expect(markAssignmentNoticeSeen("d-2")).toBe(true);
  });
});
