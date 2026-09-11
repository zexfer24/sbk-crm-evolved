/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

/**
 * Resguardo del entorno de pruebas (10/9/2026). El CI estuvo rojo desde el
 * 6/9 sin que nadie lo viera: esta máquina corre Node 26, que deja
 * `localStorage` en `undefined` dentro de jsdom, y el CI corre Node 22, donde
 * jsdom trae uno real y lo que guarda un test lo hereda el siguiente. Estos
 * dos tests fijan las dos mitades del arreglo: que el almacenamiento exista
 * en cualquier Node (`execArgv` en vitest.config.ts) y que cada test arranque
 * con él vacío (`beforeEach` en vitest.setup.ts). El segundo depende de que
 * el primero corra antes —vitest corre en orden los tests de un archivo—, y
 * es a propósito: es exactamente el contagio que no puede volver a pasar.
 */
describe("entorno de pruebas: el localStorage de jsdom", () => {
  it("existe, igual que en el Node 22 del CI", () => {
    expect(typeof globalThis.localStorage?.setItem).toBe("function");
    globalThis.localStorage.setItem("sbk:resguardo", "lo-escribió-el-test-anterior");
  });

  it("cada test arranca con el almacenamiento vacío", () => {
    expect(globalThis.localStorage.getItem("sbk:resguardo")).toBeNull();
    expect(globalThis.localStorage.length).toBe(0);
  });
});
