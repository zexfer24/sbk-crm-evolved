/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMPOS_COPIA,
  COPIA_STORAGE_PREFIX,
  guardarOpcionesCopia,
  leerOpcionesCopia,
  OPCIONES_COPIA_INICIALES,
  type OpcionesCopia,
} from "@/lib/copia-carrito";

// 21/10/2026, "Presupuestos y mensajes rápidos": las casillas de «qué incluir
// al copiar» se recuerdan por asesor en localStorage.

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OPCIONES_COPIA_INICIALES y CAMPOS_COPIA", () => {
  it("arranca con todas las casillas encendidas", () => {
    expect(Object.values(OPCIONES_COPIA_INICIALES).every((v) => v === true)).toBe(true);
    expect(Object.keys(OPCIONES_COPIA_INICIALES)).toHaveLength(7);
  });

  it("lista los campos en el orden y con las etiquetas pedidas; solo Cashea es del Inventario", () => {
    expect(CAMPOS_COPIA.map((c) => [c.clave, c.etiqueta])).toEqual([
      ["codigo", "Código"],
      ["cantidad", "Cantidad"],
      ["precioUnitario", "Precio unitario"],
      ["subtotal", "Subtotal"],
      ["totalUsd", "Total $"],
      ["totalBs", "Total Bs"],
      ["planCashea", "Plan Cashea"],
    ]);
    expect(CAMPOS_COPIA.filter((c) => c.soloInventario).map((c) => c.clave)).toEqual(["planCashea"]);
  });
});

describe("leerOpcionesCopia", () => {
  it("sin nada guardado devuelve las iniciales (una copia, no el objeto compartido)", () => {
    const opciones = leerOpcionesCopia("agente-1");
    expect(opciones).toEqual(OPCIONES_COPIA_INICIALES);
    expect(opciones).not.toBe(OPCIONES_COPIA_INICIALES);
  });

  it("un JSON roto cae a las iniciales", () => {
    window.localStorage.setItem(`${COPIA_STORAGE_PREFIX}agente-1`, "{no es json");
    expect(leerOpcionesCopia("agente-1")).toEqual(OPCIONES_COPIA_INICIALES);
  });

  it("un valor que no es objeto (arreglo, texto, null) cae a las iniciales", () => {
    for (const raw of ["[1,2]", '"hola"', "null", "7"]) {
      window.localStorage.setItem(`${COPIA_STORAGE_PREFIX}agente-1`, raw);
      expect(leerOpcionesCopia("agente-1")).toEqual(OPCIONES_COPIA_INICIALES);
    }
  });

  it("completa con las iniciales las claves que faltan", () => {
    window.localStorage.setItem(`${COPIA_STORAGE_PREFIX}agente-1`, JSON.stringify({ codigo: false }));
    expect(leerOpcionesCopia("agente-1")).toEqual({ ...OPCIONES_COPIA_INICIALES, codigo: false });
  });

  it("ignora los valores que no son booleanos y las claves desconocidas", () => {
    window.localStorage.setItem(
      `${COPIA_STORAGE_PREFIX}agente-1`,
      JSON.stringify({ codigo: "no", cantidad: 0, subtotal: false, inventada: false }),
    );
    const opciones = leerOpcionesCopia("agente-1");
    expect(opciones).toEqual({ ...OPCIONES_COPIA_INICIALES, subtotal: false });
    expect(opciones).not.toHaveProperty("inventada");
  });

  it("cada asesor tiene su clave; sin agentId se usa el sufijo anon", () => {
    const apagado: OpcionesCopia = { ...OPCIONES_COPIA_INICIALES, totalBs: false };
    window.localStorage.setItem(`${COPIA_STORAGE_PREFIX}agente-1`, JSON.stringify(apagado));
    expect(leerOpcionesCopia("agente-1").totalBs).toBe(false);
    expect(leerOpcionesCopia("agente-2").totalBs).toBe(true);

    window.localStorage.setItem(`${COPIA_STORAGE_PREFIX}anon`, JSON.stringify({ codigo: false }));
    expect(leerOpcionesCopia(null).codigo).toBe(false);
  });

  it("si localStorage lanza al leer, devuelve las iniciales sin romper", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(leerOpcionesCopia("agente-1")).toEqual(OPCIONES_COPIA_INICIALES);
  });
});

describe("guardarOpcionesCopia", () => {
  it("ida y vuelta: lo guardado es lo que se lee", () => {
    const opciones: OpcionesCopia = { ...OPCIONES_COPIA_INICIALES, codigo: false, planCashea: false };
    guardarOpcionesCopia("agente-1", opciones);
    expect(window.localStorage.getItem(`${COPIA_STORAGE_PREFIX}agente-1`)).not.toBeNull();
    expect(leerOpcionesCopia("agente-1")).toEqual(opciones);
  });

  it("sin agentId guarda bajo el sufijo anon", () => {
    guardarOpcionesCopia(null, { ...OPCIONES_COPIA_INICIALES, cantidad: false });
    expect(window.localStorage.getItem("sbk:copia-carrito:v1:anon")).not.toBeNull();
  });

  it("si localStorage lanza al escribir, no rompe", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("lleno");
    });
    expect(() => guardarOpcionesCopia("agente-1", OPCIONES_COPIA_INICIALES)).not.toThrow();
  });

  it("el prefijo es el acordado", () => {
    expect(COPIA_STORAGE_PREFIX).toBe("sbk:copia-carrito:v1:");
  });
});
