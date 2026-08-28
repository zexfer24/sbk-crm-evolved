import { describe, expect, it } from "vitest";
import {
  INVENTORY_STALE_DAYS,
  freshnessNote,
  freshnessValue,
  inventoryAgeInstruction,
  inventoryFreshness,
} from "@/lib/inventory-freshness";

const AHORA = new Date("2026-08-27T15:00:00Z");

/** Un `updated_at` de hace tantas horas, tal como lo guarda Postgres. */
function haceHoras(horas: number): string {
  return new Date(AHORA.getTime() - horas * 60 * 60 * 1000).toISOString();
}

describe("inventoryFreshness — cuán viejo es el dato que la IA está por afirmar", () => {
  it("un producto tocado esta mañana tiene cero días y no está viejo", () => {
    expect(inventoryFreshness(haceHoras(5), AHORA)).toEqual({
      updatedAt: haceHoras(5),
      ageDays: 0,
      isStale: false,
    });
  });

  it("cuenta días completos, no cambios de fecha", () => {
    // 30 horas cruzan la medianoche pero no son dos días de antigüedad.
    expect(inventoryFreshness(haceHoras(30), AHORA).ageDays).toBe(1);
  });

  /**
   * El umbral es el mismo criterio del BCV: un día de atraso es la vida normal
   * de un dato que se sincroniza a diario; dos ya es que la sincronización no
   * está corriendo.
   */
  it.each([
    [24, false],
    [47, false],
    [48, true],
    [24 * 7, true],
  ])("a las %i horas de antigüedad, viejo = %s", (horas, esperado) => {
    expect(inventoryFreshness(haceHoras(horas), AHORA).isStale).toBe(esperado);
  });

  it("el umbral son dos días", () => {
    expect(INVENTORY_STALE_DAYS).toBe(2);
  });

  /**
   * Sin fecha no se puede afirmar que el dato esté viejo — pero tampoco que
   * esté fresco. Se dice que no se sabe, que es distinto de las dos cosas.
   */
  it("sin fecha no inventa una antigüedad", () => {
    expect(inventoryFreshness(null, AHORA)).toEqual({ updatedAt: null, ageDays: null, isStale: false });
  });

  /** Un reloj corrido hacia atrás no puede dar una antigüedad negativa. */
  it("una fecha en el futuro cuenta como cero días", () => {
    expect(inventoryFreshness(haceHoras(-10), AHORA).ageDays).toBe(0);
  });
});

describe("freshnessValue — lo que se lee de un vistazo en el panel", () => {
  it.each([
    [0, "Hoy"],
    [1, "1 día"],
    [4, "4 días"],
  ])("con %i días de antigüedad muestra «%s»", (dias, esperado) => {
    expect(freshnessValue(inventoryFreshness(haceHoras(dias * 24 + 1), AHORA))).toBe(esperado);
  });

  it("sin fecha muestra una raya y no un cero", () => {
    expect(freshnessValue(inventoryFreshness(null, AHORA))).toBe("—");
  });
});

describe("freshnessNote — por qué le importa a quien mira el panel", () => {
  /**
   * El inventario llevaba cuatro días congelado y el panel lo mostraba igual
   * que si se hubiera cargado esa mañana. El dueño se enteró consultando la
   * base de datos.
   */
  it("avisa que la IA está cotizando con datos viejos", () => {
    const nota = freshnessNote(inventoryFreshness(haceHoras(24 * 4), AHORA));

    expect(nota).toMatch(/4 días/);
    expect(nota).toMatch(/cotiza/i);
  });

  it("cuando está al día, lo dice sin alarmar", () => {
    const nota = freshnessNote(inventoryFreshness(haceHoras(3), AHORA));

    expect(nota).not.toMatch(/desactualizad/i);
  });

  it("sin fecha explica que no se sabe, en vez de callarse", () => {
    expect(freshnessNote(inventoryFreshness(null, AHORA))).toMatch(/no se sabe|sin fecha/i);
  });
});

describe("inventoryAgeInstruction — lo que se le dice al modelo antes de que cotice", () => {
  /**
   * Un precio de hace tres horas y uno de hace tres semanas no se afirman
   * igual. Con el dato fresco no hay nada que agregar: cualquier matiz de más
   * hace que la IA dude de un precio que está bien.
   */
  it("no le dice nada al modelo cuando el dato está fresco", () => {
    expect(inventoryAgeInstruction(inventoryFreshness(haceHoras(5), AHORA))).toBeNull();
  });

  it("con el dato viejo le prohíbe afirmar disponibilidad y lo manda a confirmar con un asesor", () => {
    const instruccion = inventoryAgeInstruction(inventoryFreshness(haceHoras(24 * 7), AHORA));

    expect(instruccion).toMatch(/7 días/);
    expect(instruccion).toMatch(/asesor/i);
    expect(instruccion).toMatch(/no afirmes|no prometas/i);
  });

  it("sin fecha no hay antigüedad que avisar", () => {
    expect(inventoryAgeInstruction(inventoryFreshness(null, AHORA))).toBeNull();
  });
});
