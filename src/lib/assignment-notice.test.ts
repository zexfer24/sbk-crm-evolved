import { describe, expect, it, beforeEach } from "vitest";
import {
  isAssignmentNotice,
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
