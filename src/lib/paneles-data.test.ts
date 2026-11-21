import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  bloqueAntesDelInicio,
  bloqueConTopeAntesDelInicio,
  fetchMetasVenta,
  fetchPanelAsesores,
  fetchPanelCola,
  fetchPanelConversaciones,
  fetchPanelVentas,
  fetchPanelVentasActivas,
} from "./paneles-data";

/**
 * Plan "Paneles" (13/11/2026). Cada lectura devuelve un `Bloque`: un panel con
 * varios bloques degrada SOLO el que falla y nunca se cae entero. Lo único que
 * se relanza es el 42501 (el layout ya filtra el rol: si llega, es un bug).
 */

const DESDE = new Date("2026-11-01T04:00:00Z");
const HASTA = new Date("2026-11-13T18:00:00Z");

const canalVacio = { ingresos: 0, envios: 0, unidades: 0, ticket: null, estimados: 0, sin_monto: 0 };
const ventasOk = {
  granularidad: "dia",
  canales: { online: canalVacio, tienda: canalVacio },
  serie: [],
  perfil_horario: [],
  personas: [],
  top_repuestos: [],
  tipo_precio: { online: { promocion: 0, estandar: 0 }, tienda: { promocion: 0, estandar: 0 } },
  estado: { transito: { envios: 0, monto: null }, error: { envios: 0 }, sin_foto: 0, duplicados: 0 },
  recurrentes: { online: { compradores: 0, regresan: 0 }, tienda: { compradores: 0, regresan: 0 }, genericos_excluidos: 0 },
};

type Respuesta = { data: unknown; error: { code?: string; message?: string } | null };

function fakeRpc(respuesta: Respuesta | (() => never)) {
  const rpc = vi.fn(async (..._args: unknown[]) => {
    if (typeof respuesta === "function") return respuesta();
    return respuesta;
  });
  return { sb: { rpc } as unknown as SupabaseClient, rpc };
}

describe("lecturas de los paneles", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("fetchPanelVentas devuelve el dato parseado y pasa el rango en ISO", async () => {
    const { sb, rpc } = fakeRpc({ data: ventasOk, error: null });

    const r = await fetchPanelVentas(sb, DESDE, HASTA);

    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("panel_ventas", { p_desde: DESDE.toISOString(), p_hasta: HASTA.toISOString() });
    if (r.ok) expect(r.dato.granularidad).toBe("dia");
  });

  it("un 42501 se RELANZA: el layout ya filtra el rol, que llegue es un bug", async () => {
    const { sb } = fakeRpc({ data: null, error: { code: "42501", message: "no autorizado" } });

    await expect(fetchPanelVentas(sb, DESDE, HASTA)).rejects.toMatchObject({ code: "42501" });
    await expect(fetchPanelCola(sb)).rejects.toMatchObject({ code: "42501" });
  });

  it.each(["PGRST202", "42883"])("%s (función inexistente: migración sin aplicar) es no_disponible", async (code) => {
    const { sb } = fakeRpc({ data: null, error: { code, message: "function does not exist" } });

    const r = await fetchPanelVentasActivas(sb);

    expect(r).toMatchObject({ ok: false, motivo: "no_disponible" });
    if (!r.ok) expect(r.detalle).toMatch(/migraci/i);
  });

  it("cualquier otro error de la base es motivo 'error' con un texto corto en español", async () => {
    const { sb } = fakeRpc({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });

    const r = await fetchPanelCola(sb);

    expect(r).toMatchObject({ ok: false, motivo: "error" });
    if (!r.ok) {
      expect(r.detalle).toMatch(/no se pudo/i);
      expect(r.detalle).not.toMatch(/statement timeout/i);
    }
    expect(errorSpy).toHaveBeenCalled();
  });

  it("una excepción de red también degrada el bloque (no tumba el panel)", async () => {
    const { sb } = fakeRpc(() => {
      throw new TypeError("fetch failed");
    });

    const r = await fetchPanelVentas(sb, DESDE, HASTA);

    expect(r).toMatchObject({ ok: false, motivo: "error" });
  });

  it("un jsonb que no parsea es motivo 'error'", async () => {
    const { sb } = fakeRpc({ data: { granularidad: "semana" }, error: null });

    const r = await fetchPanelVentas(sb, DESDE, HASTA);

    expect(r).toMatchObject({ ok: false, motivo: "error" });
    if (!r.ok) expect(r.detalle).toMatch(/formato/i);
  });

  it("conversaciones y asesores recortan el rango a 92 días antes de llamar a la RPC", async () => {
    const hasta = new Date("2026-11-13T18:00:00Z");
    const desdeLargo = new Date("2026-01-01T04:00:00Z");
    const esperado = new Date(hasta.getTime() - 92 * 24 * 60 * 60 * 1000).toISOString();

    for (const [nombre, leer] of [
      ["panel_conversaciones", fetchPanelConversaciones],
      ["panel_asesores", fetchPanelAsesores],
    ] as const) {
      const { sb, rpc } = fakeRpc({ data: null, error: { code: "PGRST202" } });
      await leer(sb, desdeLargo, hasta);
      expect(rpc).toHaveBeenCalledWith(nombre, { p_desde: esperado, p_hasta: hasta.toISOString() });
    }
  });

  it("un rango de menos de 92 días no se toca", async () => {
    const { sb, rpc } = fakeRpc({ data: null, error: { code: "PGRST202" } });

    await fetchPanelAsesores(sb, DESDE, HASTA);

    expect(rpc).toHaveBeenCalledWith("panel_asesores", { p_desde: DESDE.toISOString(), p_hasta: HASTA.toISOString() });
  });

  it("el bloque dice si se recortó el rango (para avisar 'mostrando los últimos 92 días')", async () => {
    const { sb } = fakeRpc({ data: null, error: { code: "PGRST202" } });
    const largo = await fetchPanelConversaciones(sb, new Date("2026-01-01T04:00:00Z"), HASTA);
    const corto = await fetchPanelConversaciones(sb, DESDE, HASTA);

    expect(largo.recortado).toBe(true);
    expect(corto.recortado).toBe(false);
  });

  it("fetchPanelCola y fetchPanelVentasActivas llaman sin parámetros", async () => {
    const { sb, rpc } = fakeRpc({ data: null, error: { code: "PGRST202" } });

    await fetchPanelCola(sb);
    await fetchPanelVentasActivas(sb);

    expect(rpc).toHaveBeenCalledWith("panel_cola");
    expect(rpc).toHaveBeenCalledWith("panel_ventas_activas");
  });
});

describe("fetchMetasVenta", () => {
  function fakeTabla(respuesta: Respuesta) {
    const order = vi.fn(async () => respuesta);
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    return { sb: { from } as unknown as SupabaseClient, from, select };
  }

  it("lee metas_venta y parsea las filas", async () => {
    const { sb, from } = fakeTabla({
      data: [{ canal: "online", vigente_desde: "2026-11-01", monto_usd: "2600.00" }],
      error: null,
    });

    const r = await fetchMetasVenta(sb);

    expect(from).toHaveBeenCalledWith("metas_venta");
    expect(r).toEqual({ ok: true, dato: [{ canal: "online", vigente_desde: "2026-11-01", monto_usd: 2600 }] });
  });

  it("tabla inexistente (42P01 / PGRST205) es no_disponible; 42501 se relanza", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      const { sb } = fakeTabla({ data: null, error: { code } });
      expect(await fetchMetasVenta(sb)).toMatchObject({ ok: false, motivo: "no_disponible" });
    }
    const { sb } = fakeTabla({ data: null, error: { code: "42501" } });
    await expect(fetchMetasVenta(sb)).rejects.toMatchObject({ code: "42501" });
  });

  it("cualquier otro error es motivo 'error'", async () => {
    const { sb } = fakeTabla({ data: null, error: { code: "08006", message: "connection failure" } });
    expect(await fetchMetasVenta(sb)).toMatchObject({ ok: false, motivo: "error" });
  });
});

describe("bloques para un rango anterior al piso de datos (21/11/2026)", () => {
  it("bloqueAntesDelInicio es un no_disponible con el texto del piso, sin tocar la base", () => {
    expect(bloqueAntesDelInicio()).toEqual({
      ok: false,
      motivo: "no_disponible",
      detalle: "Los paneles cuentan desde el lunes 16/11/2026",
    });
  });

  it("bloqueConTopeAntesDelInicio suma recortado: false para las lecturas con tope de 92 días", () => {
    expect(bloqueConTopeAntesDelInicio()).toEqual({
      ok: false,
      motivo: "no_disponible",
      detalle: "Los paneles cuentan desde el lunes 16/11/2026",
      recortado: false,
    });
  });
});
