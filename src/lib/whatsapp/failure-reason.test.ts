import { describe, expect, it } from "vitest";
import { failureAction, failureReason } from "@/lib/whatsapp/failure-reason";

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

// ---------------------------------------------------------------------------
// Tabla completa (T3.3, 5/9/2026): opt-out/bloqueo, límites de ritmo, la
// plantilla misma, y la cuenta/número restringidos. Uno por grupo alcanza:
// lo que importa es que cada código tenga SU frase (no cae al genérico) y que
// diga qué hacer, no solo que falló.
// ---------------------------------------------------------------------------
describe("failureReason — tabla completa de códigos conocidos", () => {
  it("131050: el cliente dejó de aceptar mensajes de marketing (opt-out)", () => {
    expect(failureReason(131050, "some meta text")).toMatch(/dejó de aceptar/);
  });

  it("131056: demasiados mensajes seguidos a ese mismo número", () => {
    expect(failureReason(131056, null)).toMatch(/demasiados mensajes/i);
  });

  it("130429, 80007 y 4 son el mismo motivo: límite de envío/peticiones de Meta", () => {
    const porThroughput = failureReason(130429, null);
    const porCuenta = failureReason(80007, null);
    const porApp = failureReason(4, null);

    expect(porThroughput).toMatch(/límite/i);
    expect(porCuenta).toMatch(/límite/i);
    expect(porApp).toMatch(/límite/i);
  });

  it("132012: el formato de los parámetros de la plantilla, no la plantilla en sí", () => {
    expect(failureReason(132012, null)).toMatch(/formato/i);
  });

  it("132015 (pausada) y 132016 (deshabilitada) son motivos distintos entre sí", () => {
    const pausada = failureReason(132015, null);
    const deshabilitada = failureReason(132016, null);

    expect(pausada).toMatch(/pausó/i);
    expect(deshabilitada).toMatch(/deshabilitó/i);
    expect(pausada).not.toEqual(deshabilitada);
  });

  it("131037, 131031 y 368 apuntan los tres a revisar el número/cuenta en el Administrador Comercial", () => {
    for (const codigo of [131037, 131031, 368]) {
      expect(failureReason(codigo, null)).toMatch(/administrador comercial/i);
    }
  });

  it("133010: el número de la tienda no está registrado en la Cloud API", () => {
    expect(failureReason(133010, null)).toMatch(/no está registrado/i);
  });

  it("131064: límite de la cuenta por plantillas de mala calidad", () => {
    expect(failureReason(131064, null)).toMatch(/mala calidad/i);
  });
});

describe("failureAction", () => {
  it("131047 (ventana vencida) sugiere abrir el selector de plantillas", () => {
    expect(failureAction(131047)).toBe("abrir_plantillas");
  });

  it("un motivo sin acción con botón propio devuelve null", () => {
    expect(failureAction(131026)).toBeNull();
    expect(failureAction(999888)).toBeNull();
    expect(failureAction(null)).toBeNull();
  });
});
