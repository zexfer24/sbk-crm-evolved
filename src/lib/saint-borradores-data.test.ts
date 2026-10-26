import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enviarBorradorSaint, fetchUltimosBorradores } from "@/lib/saint-borradores-data";

// 25/10/2026, plan "Enviar a SAINT" (T2). El fake registra el nombre de la RPC
// y los argumentos EXACTOS: uno que ignorara los argumentos dejaría pasar un
// trim o una mayúscula olvidados.

interface LlamadaRpc {
  nombre: string;
  args: unknown;
}

function crearFake(resultado: { data?: unknown; error?: unknown } = {}) {
  const llamadas: LlamadaRpc[] = [];
  const supabase = {
    rpc(nombre: string, args: unknown) {
      llamadas.push({ nombre, args });
      return Promise.resolve({ data: resultado.data ?? null, error: resultado.error ?? null });
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, llamadas };
}

const FILA = {
  id: "b-1",
  origen: "presupuesto",
  origen_id: "p-1",
  creado_por: "a-1",
  cedula_tipo: "V",
  cedula_numero: "26075817",
  nombre: "Ana",
  apellido: "Pérez",
  telefono: "+584125551234",
  estado: "creado",
  numero_saint: "004036",
  codclie: "V26075817",
  cliente_creado: true,
  error: null,
  created_at: "2026-10-24T14:52:00.000Z",
  procesado_at: "2026-10-24T14:53:00.000Z",
};

describe("enviarBorradorSaint", () => {
  it("llama a la RPC con los textos recortados y el tipo en mayúscula, y devuelve el uuid", async () => {
    const fake = crearFake({ data: "uuid-nuevo" });
    const id = await enviarBorradorSaint(fake.supabase, {
      origen: "carrito",
      origenId: "c-7",
      datos: {
        cedulaTipo: "v" as never,
        cedulaNumero: " 26075817 ",
        nombre: "  Ana ",
        apellido: " Pérez  ",
        telefono: " +584125551234 ",
      },
    });
    expect(id).toBe("uuid-nuevo");
    expect(fake.llamadas).toEqual([
      {
        nombre: "enviar_borrador_saint",
        args: {
          p_origen: "carrito",
          p_origen_id: "c-7",
          p_cedula_tipo: "V",
          p_cedula_numero: "26075817",
          p_nombre: "Ana",
          p_apellido: "Pérez",
          p_telefono: "+584125551234",
        },
      },
    ]);
  });

  it("relanza el error de la base TAL CUAL (conserva code, message y details)", async () => {
    const error = { code: "22023", message: "saint_dato_invalido", details: "Falta algo." };
    const fake = crearFake({ error });
    await expect(
      enviarBorradorSaint(fake.supabase, {
        origen: "presupuesto",
        origenId: "p-1",
        datos: { cedulaTipo: "V", cedulaNumero: "12345", nombre: "A", apellido: "B", telefono: "1234567" },
      }),
    ).rejects.toBe(error);
  });
});

describe("fetchUltimosBorradores", () => {
  it("sin ids no llama a la base y devuelve un Map vacío", async () => {
    const fake = crearFake();
    const mapa = await fetchUltimosBorradores(fake.supabase, []);
    expect(mapa.size).toBe(0);
    expect(fake.llamadas).toEqual([]);
  });

  it("ids vacíos tampoco llaman", async () => {
    const fake = crearFake();
    const mapa = await fetchUltimosBorradores(fake.supabase, ["", ""]);
    expect(mapa.size).toBe(0);
    expect(fake.llamadas).toEqual([]);
  });

  it("deduplica los ids conservando el orden y pasa el arreglo exacto a la RPC", async () => {
    const fake = crearFake({ data: [FILA] });
    await fetchUltimosBorradores(fake.supabase, ["p-1", "p-2", "p-1", "p-2", "p-3"]);
    expect(fake.llamadas).toEqual([
      { nombre: "borradores_saint", args: { p_origen_ids: ["p-1", "p-2", "p-3"] } },
    ]);
  });

  it("mapea a camelCase y usa origenId como clave", async () => {
    const fake = crearFake({ data: [FILA, { ...FILA, id: "b-2", origen: "carrito", origen_id: "c-1", estado: "error", error: "Falló." }] });
    const mapa = await fetchUltimosBorradores(fake.supabase, ["p-1", "c-1"]);
    expect([...mapa.keys()]).toEqual(["p-1", "c-1"]);
    expect(mapa.get("p-1")).toMatchObject({
      id: "b-1",
      origen: "presupuesto",
      origenId: "p-1",
      cedulaTipo: "V",
      numeroSaint: "004036",
      clienteCreado: true,
      createdAt: "2026-10-24T14:52:00.000Z",
      procesadoAt: "2026-10-24T14:53:00.000Z",
    });
    expect(mapa.get("c-1")).toMatchObject({ estado: "error", error: "Falló." });
  });

  it("la base devuelve null: Map vacío", async () => {
    const fake = crearFake({ data: null });
    expect((await fetchUltimosBorradores(fake.supabase, ["p-1"])).size).toBe(0);
  });

  it("si la RPC falla, lanza el error", async () => {
    const error = { code: "42501", message: "saint_sin_permiso" };
    const fake = crearFake({ error });
    await expect(fetchUltimosBorradores(fake.supabase, ["p-1"])).rejects.toBe(error);
  });
});
