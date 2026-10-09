import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  __reiniciarFilasParaTests,
  claveFila,
  enFila,
  esperaHastaPausa,
  marcarAceptado,
  PAUSA_360_MS,
  REINTENTOS_429_360,
  tareasEnFila,
  ultimoAceptadoMs,
} from "@/lib/whatsapp/fila-por-numero";

// Hotfix 2 (9/10/2026): los POST a un mismo número de cliente por 360dialog
// salen de a uno, en orden, y separados por la pausa medida.

beforeEach(() => {
  __reiniciarFilasParaTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("constantes medidas", () => {
  it("la pausa es de 5000 ms y hay 6 reintentos (7 intentos)", () => {
    expect(PAUSA_360_MS).toBe(5000);
    expect(REINTENTOS_429_360).toBe(6);
  });
});

describe("claveFila", () => {
  it("normaliza el teléfono a solo dígitos y antepone el proveedor", () => {
    expect(claveFila("360dialog", "+58 412-123")).toBe("360dialog:58412123");
  });
});

describe("enFila", () => {
  it("corre las tareas de una misma clave en orden de llegada, una a la vez", async () => {
    const orden: string[] = [];
    let simultaneas = 0;
    let maxSimultaneas = 0;
    const tarea = (nombre: string, ms: number) => async () => {
      simultaneas++;
      maxSimultaneas = Math.max(maxSimultaneas, simultaneas);
      orden.push(`ini-${nombre}`);
      await new Promise((r) => setTimeout(r, ms));
      orden.push(`fin-${nombre}`);
      simultaneas--;
      return nombre;
    };

    const resultados = await Promise.all([
      enFila("k", tarea("a", 30)),
      enFila("k", tarea("b", 1)),
      enFila("k", tarea("c", 1)),
    ]);

    expect(resultados).toEqual(["a", "b", "c"]);
    expect(orden).toEqual(["ini-a", "fin-a", "ini-b", "fin-b", "ini-c", "fin-c"]);
    expect(maxSimultaneas).toBe(1);
  });

  it("claves distintas no se esperan entre sí", async () => {
    const orden: string[] = [];
    const lenta = enFila("x", async () => {
      await new Promise((r) => setTimeout(r, 30));
      orden.push("x");
    });
    const rapida = enFila("y", async () => {
      orden.push("y");
    });
    await Promise.all([lenta, rapida]);
    expect(orden).toEqual(["y", "x"]);
  });

  it("un fallo no corta la cadena y llega intacto a quien lo pidió", async () => {
    const error = new Error("boom");
    const primera = enFila("k", async () => {
      throw error;
    });
    const segunda = enFila("k", async () => "ok");

    await expect(primera).rejects.toBe(error);
    await expect(segunda).resolves.toBe("ok");
  });

  it("tareasEnFila cuenta la que corre y las que esperan, y vuelve a 0", async () => {
    expect(tareasEnFila("k")).toBe(0);
    const a = enFila("k", async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const b = enFila("k", async () => {});
    expect(tareasEnFila("k")).toBe(2);
    await Promise.all([a, b]);
    expect(tareasEnFila("k")).toBe(0);
  });

  it("la hora del último aceptado sobrevive a que la cola se vacíe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await enFila("k", async () => {
      marcarAceptado("k");
    });
    expect(tareasEnFila("k")).toBe(0);
    expect(ultimoAceptadoMs("k")).toBe(1_000_000);
  });
});

describe("esperaHastaPausa", () => {
  it("0 si nunca se aceptó nada", () => {
    expect(esperaHastaPausa("k", 5_000)).toBe(0);
    expect(ultimoAceptadoMs("k")).toBeNull();
  });

  it("devuelve lo que falta para completar 5000 ms desde el último 200", () => {
    marcarAceptado("k", 10_000);
    expect(esperaHastaPausa("k", 10_000)).toBe(5000);
    expect(esperaHastaPausa("k", 12_000)).toBe(3000);
    expect(esperaHastaPausa("k", 14_999)).toBe(1);
    expect(esperaHastaPausa("k", 15_000)).toBe(0);
    expect(esperaHastaPausa("k", 99_000)).toBe(0);
  });

  it("la poda de entradas viejas no cambia el resultado", () => {
    marcarAceptado("viejo", 1_000);
    marcarAceptado("nuevo", 100_000);
    expect(ultimoAceptadoMs("viejo")).toBeNull();
    expect(esperaHastaPausa("viejo", 100_000)).toBe(0);
    expect(ultimoAceptadoMs("nuevo")).toBe(100_000);
  });
});
