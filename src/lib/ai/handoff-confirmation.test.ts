import { describe, expect, it } from "vitest";
import { HANDOFF_CONFIRMATION_TTL_MS, handoffConfirmationState } from "@/lib/ai/handoff-confirmation";

const AHORA = new Date("2026-09-08T12:00:00.000Z");

describe("handoffConfirmationState", () => {
  it("sin sello, no hay oferta pendiente", () => {
    expect(
      handoffConfirmationState({ pendingAt: null, lastCustomerMessageAt: null, now: AHORA })
    ).toBe("none");
  });

  it("con un sello ilegible, se trata como si no hubiera ninguno", () => {
    expect(
      handoffConfirmationState({ pendingAt: "no-es-una-fecha", lastCustomerMessageAt: null, now: AHORA })
    ).toBe("none");
  });

  it("recién sellada y sin mensaje del cliente después, sigue esperando", () => {
    const pendingAt = new Date(AHORA.getTime() - 60_000).toISOString();

    expect(
      handoffConfirmationState({ pendingAt, lastCustomerMessageAt: null, now: AHORA })
    ).toBe("awaiting");
  });

  /**
   * El borde central del diseño (ver el comentario de cabecera del módulo):
   * un mensaje del cliente ANTERIOR o IGUAL al sello no confirma nada — es
   * el mismo mensaje que disparó la oferta, no uno nuevo respondiéndola.
   */
  it("con el último mensaje del cliente ANTES del sello, sigue esperando", () => {
    const pendingAt = new Date(AHORA.getTime() - 60_000).toISOString();
    const lastCustomerMessageAt = new Date(AHORA.getTime() - 120_000).toISOString();

    expect(
      handoffConfirmationState({ pendingAt, lastCustomerMessageAt, now: AHORA })
    ).toBe("awaiting");
  });

  it("con el último mensaje del cliente EXACTAMENTE en el instante del sello, sigue esperando (no confirma)", () => {
    const sello = new Date(AHORA.getTime() - 60_000).toISOString();

    expect(
      handoffConfirmationState({ pendingAt: sello, lastCustomerMessageAt: sello, now: AHORA })
    ).toBe("awaiting");
  });

  it("con un mensaje del cliente POSTERIOR al sello, queda confirmada", () => {
    const pendingAt = new Date(AHORA.getTime() - 120_000).toISOString();
    const lastCustomerMessageAt = new Date(AHORA.getTime() - 60_000).toISOString();

    expect(
      handoffConfirmationState({ pendingAt, lastCustomerMessageAt, now: AHORA })
    ).toBe("confirmed");
  });

  it("justo en el borde del TTL (exactamente 6h), todavía no vence", () => {
    const pendingAt = new Date(AHORA.getTime() - HANDOFF_CONFIRMATION_TTL_MS).toISOString();

    expect(
      handoffConfirmationState({ pendingAt, lastCustomerMessageAt: null, now: AHORA })
    ).toBe("awaiting");
  });

  it("un milisegundo pasado el TTL, vence", () => {
    const pendingAt = new Date(AHORA.getTime() - HANDOFF_CONFIRMATION_TTL_MS - 1).toISOString();

    expect(
      handoffConfirmationState({ pendingAt, lastCustomerMessageAt: null, now: AHORA })
    ).toBe("expired");
  });

  /**
   * "Vencida" gana aunque el cliente sí haya escrito después del sello: un
   * "sí" que tardó más de 6h en procesarse no puede confirmar una oferta ya
   * vieja. `buildEscalateTool` trata "expired" igual que "none" — vuelve a
   * sellar y a pedir el "sí" de nuevo.
   */
  it("vencida gana sobre confirmada, aunque el cliente haya escrito después del sello", () => {
    const pendingAt = new Date(AHORA.getTime() - HANDOFF_CONFIRMATION_TTL_MS - 60_000).toISOString();
    const lastCustomerMessageAt = new Date(AHORA.getTime() - 30_000).toISOString();

    expect(
      handoffConfirmationState({ pendingAt, lastCustomerMessageAt, now: AHORA })
    ).toBe("expired");
  });
});
