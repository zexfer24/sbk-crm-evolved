import { describe, expect, it } from "vitest";
import {
  NonRetryableTurnError,
  ProviderFailedAfterGreetingError,
  isNonRetryable,
  isProviderFailedAfterGreeting,
  newTurnDelivery,
} from "@/lib/ai/turn-delivery";

// ---------------------------------------------------------------------------
// Este archivo prueba la barrera en sí misma, sin correr un turno entero: si
// `newTurnDelivery` empezara en `true`, TODO turno se declararía "ya
// entregado" antes de intentar nada y la cola abandonaría cada fallo previo
// al envío como si hubiera duplicado un mensaje que nunca salió. Y si
// `isNonRetryable` confundiera un error cualquiera con éste, un corte de red
// común dejaría de reintentarse — el efecto contrario: clientes sin
// respuesta que sí se podían recuperar.
// ---------------------------------------------------------------------------

describe("newTurnDelivery", () => {
  it("arranca en falso: ningún turno nace ya declarado como entregado", () => {
    expect(newTurnDelivery()).toEqual({ intentado: false });
  });

  it("cada llamada devuelve su propio objeto, no uno compartido entre turnos", () => {
    const a = newTurnDelivery();
    const b = newTurnDelivery();
    a.intentado = true;

    expect(b.intentado).toBe(false);
  });
});

describe("NonRetryableTurnError", () => {
  it("conserva el conversationId con el que se construyó", () => {
    const err = new NonRetryableTurnError("conv-1", "el contacto no trae teléfono");

    expect(err.conversationId).toBe("conv-1");
  });

  it("lleva el name propio y no el genérico 'Error', que es lo que usa la cola para reconocerla", () => {
    const err = new NonRetryableTurnError("conv-1", "el contacto no trae teléfono");

    expect(err.name).toBe("NonRetryableTurnError");
  });

  it("es un Error de verdad: instanceof Error sigue funcionando", () => {
    const err = new NonRetryableTurnError("conv-1", "el contacto no trae teléfono");

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("el contacto no trae teléfono");
  });

  /**
   * `cause` es lo que deja ver, en el registro, el error original que motivó
   * el abandono (un TurnIdentityError, un fallo posterior al envío) sin
   * perder ese detalle detrás del mensaje genérico de la envoltura.
   */
  it("conserva la causa original cuando se le pasa una", () => {
    const original = new Error("la conversación volvió sin id");

    const err = new NonRetryableTurnError("conv-1", "identidad no verificable", { cause: original });

    expect(err.cause).toBe(original);
  });

  it("sin causa, cause queda undefined en vez de inventar una", () => {
    const err = new NonRetryableTurnError("conv-1", "identidad no verificable");

    expect(err.cause).toBeUndefined();
  });
});

describe("isNonRetryable", () => {
  it("reconoce un NonRetryableTurnError", () => {
    expect(isNonRetryable(new NonRetryableTurnError("conv-1", "x"))).toBe(true);
  });

  /**
   * La distinción es la que separa "abandonar sin reintentar" de "volver a
   * la cola": un Error común —un 429 del proveedor, un corte de red— tiene
   * que seguir siendo reintentable, o la cola dejaría de recuperarse de
   * fallas transitorias.
   */
  it("no confunde un Error común con uno no reintentable", () => {
    expect(isNonRetryable(new Error("fallo cualquiera"))).toBe(false);
  });

  it("no confunde otra subclase de Error, aunque el nombre se parezca", () => {
    class OtraCosaError extends Error {
      constructor() {
        super("no soy NonRetryableTurnError");
        this.name = "NonRetryableTurnError"; // mismo name, distinta clase
      }
    }

    expect(isNonRetryable(new OtraCosaError())).toBe(false);
  });

  it("no lanza ni confunde valores que no son errores", () => {
    expect(isNonRetryable(null)).toBe(false);
    expect(isNonRetryable(undefined)).toBe(false);
    expect(isNonRetryable("no soy un error")).toBe(false);
  });
});

// T12, plan "Seba sale sin pisar a nadie" (19/9/2026, cierra la decisión
// abierta #1): esta clase es la ÚNICA excepción a "si entrega.intentado, no
// se reintenta" — por diseño NO puede confundirse con `NonRetryableTurnError`
// en ningún sentido, o la cola dejaría de reintentar el único caso donde
// reintentar es seguro (agent.ts, catch de runAgentTurn).
describe("ProviderFailedAfterGreetingError", () => {
  it("conserva el conversationId con el que se construyó", () => {
    const err = new ProviderFailedAfterGreetingError("conv-1", "clasificar falló después del saludo");

    expect(err.conversationId).toBe("conv-1");
  });

  it("lleva el name propio, no el genérico 'Error'", () => {
    const err = new ProviderFailedAfterGreetingError("conv-1", "clasificar falló después del saludo");

    expect(err.name).toBe("ProviderFailedAfterGreetingError");
  });

  it("es un Error de verdad: instanceof Error sigue funcionando", () => {
    const err = new ProviderFailedAfterGreetingError("conv-1", "clasificar falló después del saludo");

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("clasificar falló después del saludo");
  });

  it("conserva la causa original cuando se le pasa una", () => {
    const original = new Error("rate limit del proveedor");

    const err = new ProviderFailedAfterGreetingError("conv-1", "clasificar falló después del saludo", {
      cause: original,
    });

    expect(err.cause).toBe(original);
  });
});

describe("isProviderFailedAfterGreeting", () => {
  it("reconoce un ProviderFailedAfterGreetingError", () => {
    expect(isProviderFailedAfterGreeting(new ProviderFailedAfterGreetingError("conv-1", "x"))).toBe(true);
  });

  /**
   * La distinción que le importa a la cola: `isNonRetryable` decide
   * "abandonar sin reintentar" y esta clase es justo lo contrario —"sí
   * reintentar"—, así que las dos funciones NUNCA pueden estar de acuerdo
   * sobre el mismo error.
   */
  it("NO es un NonRetryableTurnError — la cola tiene que poder distinguirlos", () => {
    const err = new ProviderFailedAfterGreetingError("conv-1", "clasificar falló después del saludo");

    expect(isNonRetryable(err)).toBe(false);
  });

  it("un NonRetryableTurnError no se reconoce como ProviderFailedAfterGreetingError", () => {
    const err = new NonRetryableTurnError("conv-1", "identidad no verificable");

    expect(isProviderFailedAfterGreeting(err)).toBe(false);
  });

  it("no confunde un Error común", () => {
    expect(isProviderFailedAfterGreeting(new Error("fallo cualquiera"))).toBe(false);
  });

  it("no lanza ni confunde valores que no son errores", () => {
    expect(isProviderFailedAfterGreeting(null)).toBe(false);
    expect(isProviderFailedAfterGreeting(undefined)).toBe(false);
    expect(isProviderFailedAfterGreeting("no soy un error")).toBe(false);
  });
});
