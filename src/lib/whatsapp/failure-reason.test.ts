import { describe, expect, it } from "vitest";
import { failureReason } from "@/lib/whatsapp/failure-reason";

// ---------------------------------------------------------------------------
// El valor de esta función no es traducir: es que dos fallos que hoy se ven
// idénticos —un triángulo rojo— pasen a sugerir dos acciones distintas.
// ---------------------------------------------------------------------------

describe("failureReason", () => {
  it("separa el número que no existe de la ventana vencida", () => {
    const numeroMalo = failureReason(131026, "Message Undeliverable.");
    const ventanaVencida = failureReason(131047, "Re-engagement message");

    expect(numeroMalo).toMatch(/número/i);
    expect(ventanaVencida).toMatch(/24 h/);
    expect(numeroMalo).not.toEqual(ventanaVencida);
  });

  /** La traducción gana al texto de Meta: es la que dice qué hacer. */
  it("prefiere el motivo conocido antes que el texto en inglés", () => {
    expect(failureReason(131026, "Message Undeliverable.")).not.toContain("Undeliverable");
  });

  /**
   * La tabla cubre lo que pasa en una repuestera, no el catálogo de Meta. Lo
   * que no esté tiene que salir igual, con el código a mano para buscarlo.
   */
  it("con un código desconocido devuelve el texto de Meta y el número", () => {
    const motivo = failureReason(999888, "Something odd happened");

    expect(motivo).toContain("Something odd happened");
    expect(motivo).toContain("999888");
  });

  it("con código desconocido y sin texto, al menos dice el código", () => {
    expect(failureReason(999888, null)).toContain("999888");
  });

  it("sin código pero con texto, devuelve el texto tal cual", () => {
    expect(failureReason(null, "ETIMEDOUT contra graph.facebook.com")).toBe(
      "ETIMEDOUT contra graph.facebook.com"
    );
  });

  /**
   * Null y no cadena vacía: la burbuja distingue "no falló" de "falló y no
   * sabemos por qué", y son dos cosas distintas de mostrar.
   */
  it("devuelve null cuando no hay nada que contar", () => {
    expect(failureReason(null, null)).toBeNull();
    expect(failureReason(null, "   ")).toBeNull();
  });
});
