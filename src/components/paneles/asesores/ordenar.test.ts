import { describe, expect, it } from "vitest";
import type { PersonaAsesores } from "@/lib/paneles/parse";
import { cruzarConversion, direccionInicial, ordenarFilas, type FilaPersona } from "./ordenar";

/** Plan "Paneles" (13/11/2026), C6: orden de la tabla por persona y cruce con la conversión. */

function persona(extra: Partial<PersonaAsesores> & { nombre: string }): PersonaAsesores {
  return {
    agent_id: extra.nombre,
    rol: "agent",
    en_reparto: true,
    conversaciones: 0,
    mensajes: 0,
    contactos: 0,
    episodios: 0,
    primera_resp_mediana_min: null,
    primera_resp_p90_min: null,
    en_5min: null,
    envios: 0,
    monto: null,
    unidades: 0,
    envios_online: 0,
    envios_tienda: 0,
    reasignadas_desde: 0,
    ultimo_mensaje: null,
    actividad_hora: Array.from({ length: 24 }, () => 0),
    ...extra,
  };
}

const fila = (p: PersonaAsesores, conversion: number | null = null): FilaPersona => ({
  persona: p,
  atendidas: null,
  compraron: null,
  conversion,
});

describe("cruzarConversion", () => {
  it("cruza por agent_id y calcula compraron / atendidas", () => {
    const filas = cruzarConversion(
      [persona({ nombre: "Ana", agent_id: "a1" }), persona({ nombre: "Beto", agent_id: "b1" })],
      [{ agent_id: "a1", nombre: "Ana", rol: "agent", atendidas: 40, compraron: 10 }]
    );
    expect(filas[0].conversion).toBe(0.25);
    expect(filas[0].atendidas).toBe(40);
    expect(filas[1].conversion).toBeNull();
  });
  it("sin lista de conversión (bloque caído) todo es null", () => {
    const filas = cruzarConversion([persona({ nombre: "Ana", agent_id: "a1" })], null);
    expect(filas[0].conversion).toBeNull();
  });
  it("0 atendidas no divide: queda null", () => {
    const filas = cruzarConversion(
      [persona({ nombre: "Ana", agent_id: "a1" })],
      [{ agent_id: "a1", nombre: "Ana", rol: "agent", atendidas: 0, compraron: 0 }]
    );
    expect(filas[0].conversion).toBeNull();
  });
});

describe("ordenarFilas", () => {
  const a = fila(persona({ nombre: "Ana", mensajes: 10, primera_resp_mediana_min: 4, ultimo_mensaje: "2026-11-13T10:00:00Z" }), 0.1);
  const b = fila(persona({ nombre: "Beto", mensajes: 30, primera_resp_mediana_min: null, ultimo_mensaje: "2026-11-12T10:00:00Z" }), 0.3);
  const c = fila(persona({ nombre: "Carla", mensajes: 20, primera_resp_mediana_min: 2, ultimo_mensaje: null }), null);

  it("numérico descendente", () => {
    expect(ordenarFilas([a, b, c], "mensajes", "desc").map((f) => f.persona.nombre)).toEqual(["Beto", "Carla", "Ana"]);
  });
  it("los null van siempre al final, en cualquier dirección", () => {
    expect(ordenarFilas([a, b, c], "primera", "asc").map((f) => f.persona.nombre)).toEqual(["Carla", "Ana", "Beto"]);
    expect(ordenarFilas([a, b, c], "primera", "desc").map((f) => f.persona.nombre)).toEqual(["Ana", "Carla", "Beto"]);
    expect(ordenarFilas([a, b, c], "conversion", "asc").map((f) => f.persona.nombre)).toEqual(["Ana", "Beto", "Carla"]);
  });
  it("por fecha del último mensaje", () => {
    expect(ordenarFilas([a, b, c], "ultimo", "desc").map((f) => f.persona.nombre)).toEqual(["Ana", "Beto", "Carla"]);
  });
  it("por nombre, sin distinguir mayúsculas ni acentos", () => {
    const x = fila(persona({ nombre: "Álvaro" }));
    const y = fila(persona({ nombre: "beto" }));
    expect(ordenarFilas([y, x], "nombre", "asc").map((f) => f.persona.nombre)).toEqual(["Álvaro", "beto"]);
  });
  it("no muta el arreglo original", () => {
    const original = [a, b, c];
    ordenarFilas(original, "mensajes", "desc");
    expect(original.map((f) => f.persona.nombre)).toEqual(["Ana", "Beto", "Carla"]);
  });
  it("el empate se desempata por nombre", () => {
    const d1 = fila(persona({ nombre: "Zoe", mensajes: 5 }));
    const d2 = fila(persona({ nombre: "Abel", mensajes: 5 }));
    expect(ordenarFilas([d1, d2], "mensajes", "desc").map((f) => f.persona.nombre)).toEqual(["Abel", "Zoe"]);
  });
});

describe("direccionInicial", () => {
  it("nombre y primera respuesta empiezan ascendentes (menos es mejor); el resto, descendentes", () => {
    expect(direccionInicial("nombre")).toBe("asc");
    expect(direccionInicial("primera")).toBe("asc");
    expect(direccionInicial("monto")).toBe("desc");
    expect(direccionInicial("en5")).toBe("desc");
  });
});
