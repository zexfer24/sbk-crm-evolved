import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INICIO_PANELES } from "./periodos";

/**
 * Paridad TypeScript <-> SQL del piso de datos de los paneles (plan "Los
 * paneles cuentan desde el lunes 16/11/2026", 21/11/2026).
 *
 * Las RPC `panel_*` recortan en SQL lo que el CRM recorta en TypeScript, y los
 * dos tienen que hablar del MISMO instante: si divergieran, un panel contaría
 * desde un lado y la RPC desde otro. `INICIO_PANELES` (periodos.ts) se ata aquí
 * al literal de `public.paneles_inicio()` en la migración. Mismo patrón que
 * `precio-venta-paridad.test.ts`.
 */

const MIGRACION = path.resolve(__dirname, "../../../supabase/migrations/20261121020000_paneles_inicio.sql");

describe("INICIO_PANELES", () => {
  it("es la medianoche de Caracas del lunes 16/11/2026, fijada literal", () => {
    expect(INICIO_PANELES.toISOString()).toBe("2026-11-16T04:00:00.000Z");
  });

  it("coincide con el literal de public.paneles_inicio() en la migración", () => {
    expect(existsSync(MIGRACION)).toBe(true);
    const sql = readFileSync(MIGRACION, "utf8");
    // Solo el cuerpo de la función: la migración trae otros literales con -04
    // (los años 2100 de los rangos de prueba de su autoverificación).
    const funcion = sql.match(/create or replace function public\.paneles_inicio\(\)[\s\S]*?\$\$;/);
    expect(funcion).not.toBeNull();
    const literales = [...funcion![0].matchAll(/timestamptz '(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}-04)'/g)];
    // Exactamente una vez: dos literales (o ninguno) dejarían ambiguo cuál es el piso.
    expect(literales).toHaveLength(1);
    const instante = new Date(`${literales[0][1]}:00`.replace(" ", "T"));
    expect(instante.getTime()).toBe(INICIO_PANELES.getTime());
  });
});
