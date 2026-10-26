import { describe, expect, it } from "vitest";
import {
  borradorDesdeFila,
  decidirEnvio,
  esCedulaSaintValida,
  esTelefonoSaintValido,
  estaSinRespuesta,
  etiquetaEstado,
  mensajeErrorEnvio,
  renglonesBloqueados,
  SAINT_SIN_RESPUESTA_MS,
  textoBloqueo,
  textoConfirmacionReenvio,
  validarClienteSaint,
  type BorradorSaint,
} from "@/lib/saint-borradores";

// 25/10/2026, plan "Enviar a SAINT" (T2). Reglas puras: sin React ni Supabase.
// Las fechas son fijas: nada depende del reloj real.

function borrador(parcial: Partial<BorradorSaint> = {}): BorradorSaint {
  return {
    id: "b-1",
    origen: "presupuesto",
    origenId: "p-1",
    creadoPor: "a-1",
    cedulaTipo: "V",
    cedulaNumero: "26075817",
    nombre: "Ana",
    apellido: "Pérez",
    telefono: "+584125551234",
    estado: "pendiente",
    numeroSaint: null,
    codclie: null,
    clienteCreado: null,
    error: null,
    createdAt: "2026-10-24T14:52:00.000Z",
    procesadoAt: null,
    ...parcial,
  };
}

describe("borradorDesdeFila", () => {
  it("pasa de snake_case a camelCase sin perder campos", () => {
    const b = borradorDesdeFila({
      id: "b-9",
      origen: "carrito",
      origen_id: "c-1",
      creado_por: null,
      cedula_tipo: "E",
      cedula_numero: "12345",
      nombre: "Luis",
      apellido: "Gómez",
      telefono: "04125551234",
      estado: "creado",
      numero_saint: "004036",
      codclie: "V26075817",
      cliente_creado: true,
      error: null,
      created_at: "2026-10-24T14:52:00.000Z",
      procesado_at: "2026-10-24T14:53:00.000Z",
    });
    expect(b).toEqual({
      id: "b-9",
      origen: "carrito",
      origenId: "c-1",
      creadoPor: null,
      cedulaTipo: "E",
      cedulaNumero: "12345",
      nombre: "Luis",
      apellido: "Gómez",
      telefono: "04125551234",
      estado: "creado",
      numeroSaint: "004036",
      codclie: "V26075817",
      clienteCreado: true,
      error: null,
      createdAt: "2026-10-24T14:52:00.000Z",
      procesadoAt: "2026-10-24T14:53:00.000Z",
    });
  });
});

describe("esCedulaSaintValida", () => {
  it("acepta 5 a 10 dígitos", () => {
    expect(esCedulaSaintValida("12345")).toBe(true);
    expect(esCedulaSaintValida("1234567890")).toBe(true);
    expect(esCedulaSaintValida("  26075817  ")).toBe(true);
  });
  it("rechaza menos de 5, más de 10, letras y guiones", () => {
    expect(esCedulaSaintValida("1234")).toBe(false);
    expect(esCedulaSaintValida("12345678901")).toBe(false);
    expect(esCedulaSaintValida("12.345.678")).toBe(false);
    expect(esCedulaSaintValida("V1234567")).toBe(false);
    expect(esCedulaSaintValida("")).toBe(false);
  });
  it("rechaza 'todo ceros' aunque tenga el largo correcto (SAINT lo rechaza)", () => {
    expect(esCedulaSaintValida("00000")).toBe(false);
    expect(esCedulaSaintValida("0000000000")).toBe(false);
    expect(esCedulaSaintValida("00001")).toBe(true);
  });
});

describe("esTelefonoSaintValido", () => {
  it("acepta dígitos con + inicial opcional, de 7 a 19", () => {
    expect(esTelefonoSaintValido("+584125551234")).toBe(true);
    expect(esTelefonoSaintValido("04125551234")).toBe(true);
    expect(esTelefonoSaintValido("  04125551234 ")).toBe(true);
    expect(esTelefonoSaintValido("1234567")).toBe(true);
    expect(esTelefonoSaintValido("1234567890123456789")).toBe(true);
  });
  it("rechaza guiones, letras, muy corto y muy largo", () => {
    expect(esTelefonoSaintValido("0412-555")).toBe(false);
    expect(esTelefonoSaintValido("abc")).toBe(false);
    expect(esTelefonoSaintValido("123456")).toBe(false);
    expect(esTelefonoSaintValido("123456789012345678901")).toBe(false); // 21
    expect(esTelefonoSaintValido("12345678901234567890")).toBe(false); // 20
    expect(esTelefonoSaintValido("")).toBe(false);
  });
});

describe("validarClienteSaint", () => {
  const bueno = { cedulaTipo: "V" as const, cedulaNumero: "26075817", nombre: "Ana", apellido: "Pérez", telefono: "+584125551234" };

  it("datos buenos no devuelven errores", () => {
    expect(validarClienteSaint(bueno)).toEqual({});
  });
  it("sin tipo de cédula pide elegir V o E", () => {
    expect(validarClienteSaint({ ...bueno, cedulaTipo: "" }).cedula).toBe("Elige si la cédula es V o E.");
  });
  it("número de cédula inválido (incluido todo ceros)", () => {
    const msg = "La cédula debe tener entre 5 y 10 dígitos, sin letras ni guiones.";
    expect(validarClienteSaint({ ...bueno, cedulaNumero: "12" }).cedula).toBe(msg);
    expect(validarClienteSaint({ ...bueno, cedulaNumero: "00000" }).cedula).toBe(msg);
  });
  it("nombre y apellido vacíos tras trim", () => {
    const e = validarClienteSaint({ ...bueno, nombre: "   ", apellido: "" });
    expect(e.nombre).toBe("Falta el nombre.");
    expect(e.apellido).toBe("Falta el apellido.");
  });
  it("teléfono inválido", () => {
    expect(validarClienteSaint({ ...bueno, telefono: "0412-555" }).telefono).toBe(
      "Teléfono inválido: solo dígitos, con + inicial opcional.",
    );
  });
  it("devuelve solo los campos que fallan", () => {
    expect(Object.keys(validarClienteSaint({ ...bueno, nombre: "" }))).toEqual(["nombre"]);
  });
});

describe("estaSinRespuesta", () => {
  it("el tope es 2 minutos (literal)", () => {
    expect(SAINT_SIN_RESPUESTA_MS).toBe(120000);
  });
  it("a 1:59 todavía no, a 2:01 sí (solo pendiente)", () => {
    const b = borrador({ createdAt: "2026-10-25T12:00:00.000Z" });
    expect(estaSinRespuesta(b, new Date("2026-10-25T12:01:59.000Z"))).toBe(false);
    expect(estaSinRespuesta(b, new Date("2026-10-25T12:02:01.000Z"))).toBe(true);
  });
  it("procesando, creado y error nunca están 'sin respuesta'", () => {
    const ahora = new Date("2026-10-25T13:00:00.000Z");
    for (const estado of ["procesando", "creado", "error"] as const) {
      expect(estaSinRespuesta(borrador({ estado, createdAt: "2026-10-25T12:00:00.000Z" }), ahora)).toBe(false);
    }
  });
});

describe("decidirEnvio", () => {
  it("sin envío previo o con error: libre", () => {
    expect(decidirEnvio(null)).toEqual({ tipo: "libre" });
    expect(decidirEnvio(borrador({ estado: "error", error: "x" }))).toEqual({ tipo: "libre" });
  });
  it("pendiente y procesando: en curso", () => {
    expect(decidirEnvio(borrador({ estado: "pendiente" }))).toEqual({ tipo: "en_curso" });
    expect(decidirEnvio(borrador({ estado: "procesando" }))).toEqual({ tipo: "en_curso" });
  });
  it("creado: confirmar con número y fecha", () => {
    expect(decidirEnvio(borrador({ estado: "creado", numeroSaint: "004036" }))).toEqual({
      tipo: "confirmar",
      numeroSaint: "004036",
      createdAt: "2026-10-24T14:52:00.000Z",
    });
    expect(decidirEnvio(borrador({ estado: "creado", numeroSaint: null }))).toEqual({
      tipo: "confirmar",
      numeroSaint: null,
      createdAt: "2026-10-24T14:52:00.000Z",
    });
  });
});

describe("textoConfirmacionReenvio", () => {
  it("presupuesto con número", () => {
    expect(textoConfirmacionReenvio("presupuesto", "004036", "2026-10-24T14:52:00.000Z")).toBe(
      "Este presupuesto ya se envió a SAINT como 004036 el 24/10 10:52. ¿Enviar de nuevo?",
    );
  });
  it("carrito con número", () => {
    expect(textoConfirmacionReenvio("carrito", "004036", "2026-10-24T14:52:00.000Z")).toBe(
      "Este carrito ya se envió a SAINT como 004036 el 24/10 10:52. ¿Enviar de nuevo?",
    );
  });
  it("sin número", () => {
    expect(textoConfirmacionReenvio("presupuesto", null, "2026-10-24T14:52:00.000Z")).toBe(
      "Este presupuesto ya se envió a SAINT el 24/10 10:52. ¿Enviar de nuevo?",
    );
  });
  it("la fecha se lee en Caracas, no en UTC: 02:30Z del 25 es 22:30 del 24", () => {
    expect(textoConfirmacionReenvio("carrito", null, "2026-10-25T02:30:00.000Z")).toBe(
      "Este carrito ya se envió a SAINT el 24/10 22:30. ¿Enviar de nuevo?",
    );
  });
  it("usa 24 horas y la medianoche es 00, no 24", () => {
    // 04:00Z = 00:00 en Caracas (UTC-4).
    expect(textoConfirmacionReenvio("carrito", null, "2026-10-25T04:00:00.000Z")).toContain("el 25/10 00:00.");
    expect(textoConfirmacionReenvio("carrito", null, "2026-10-25T17:05:00.000Z")).toContain("el 25/10 13:05.");
  });
});

describe("etiquetaEstado", () => {
  const ahora = new Date("2026-10-25T12:01:00.000Z");
  const reciente = "2026-10-25T12:00:00.000Z";

  it("pendiente reciente: enviando", () => {
    expect(etiquetaEstado(borrador({ createdAt: reciente }), ahora)).toEqual({
      texto: "Enviando a SAINT…",
      detalle: null,
      tono: "progreso",
    });
  });
  it("pendiente sin respuesta: alerta con detalle", () => {
    expect(etiquetaEstado(borrador({ createdAt: "2026-10-25T11:00:00.000Z" }), ahora)).toEqual({
      texto: "SAINT no responde: el agente podría estar apagado.",
      detalle: "Se creará cuando vuelva.",
      tono: "alerta",
    });
  });
  it("procesando", () => {
    expect(etiquetaEstado(borrador({ estado: "procesando" }), ahora)).toEqual({
      texto: "Creando en SAINT…",
      detalle: null,
      tono: "progreso",
    });
  });
  it("creado con número y cliente existente", () => {
    expect(
      etiquetaEstado(borrador({ estado: "creado", numeroSaint: "004036", codclie: "V26075817", clienteCreado: false }), ahora),
    ).toEqual({ texto: "En SAINT como 004036", detalle: "Cliente V26075817", tono: "ok" });
  });
  it("creado con cliente nuevo registrado", () => {
    expect(
      etiquetaEstado(borrador({ estado: "creado", numeroSaint: "004036", codclie: "V26075817", clienteCreado: true }), ahora),
    ).toEqual({ texto: "En SAINT como 004036", detalle: "Cliente V26075817 · cliente nuevo registrado", tono: "ok" });
  });
  it("creado sin número ni codclie", () => {
    expect(etiquetaEstado(borrador({ estado: "creado" }), ahora)).toEqual({
      texto: "Creado en SAINT",
      detalle: null,
      tono: "ok",
    });
  });
  it("error con texto del agente y sin él", () => {
    expect(etiquetaEstado(borrador({ estado: "error", error: "El producto X no existe en SAINT." }), ahora)).toEqual({
      texto: "El producto X no existe en SAINT.",
      detalle: null,
      tono: "error",
    });
    expect(etiquetaEstado(borrador({ estado: "error", error: null }), ahora)).toEqual({
      texto: "No se pudo crear en SAINT.",
      detalle: null,
      tono: "error",
    });
  });
});

describe("mensajeErrorEnvio", () => {
  it("23505: ya hay un envío en curso", () => {
    expect(mensajeErrorEnvio({ code: "23505", message: "duplicate key" })).toBe("Ya hay un envío en curso.");
  });
  it("22023 saint_dato_invalido: usa details tal cual", () => {
    expect(
      mensajeErrorEnvio({ code: "22023", message: "saint_dato_invalido", details: "El producto «X» no tiene código SAINT." }),
    ).toBe("El producto «X» no tiene código SAINT.");
  });
  it("22023 con details vacío o ausente: genérico", () => {
    const generico = "No se pudo enviar a SAINT. Intenta de nuevo.";
    expect(mensajeErrorEnvio({ code: "22023", message: "saint_dato_invalido", details: "" })).toBe(generico);
    expect(mensajeErrorEnvio({ code: "22023", message: "saint_dato_invalido", details: "   " })).toBe(generico);
    expect(mensajeErrorEnvio({ code: "22023", message: "saint_dato_invalido" })).toBe(generico);
  });
  it("22023 con otro message: genérico", () => {
    expect(mensajeErrorEnvio({ code: "22023", message: "otra cosa", details: "x" })).toBe(
      "No se pudo enviar a SAINT. Intenta de nuevo.",
    );
  });
  it("42501: sin permiso", () => {
    expect(mensajeErrorEnvio({ code: "42501", message: "saint_sin_permiso" })).toBe(
      "No tienes permiso para enviar esto a SAINT.",
    );
  });
  it("cualquier otra cosa: genérico", () => {
    const generico = "No se pudo enviar a SAINT. Intenta de nuevo.";
    expect(mensajeErrorEnvio(new Error("fetch failed"))).toBe(generico);
    expect(mensajeErrorEnvio(null)).toBe(generico);
    expect(mensajeErrorEnvio("boom")).toBe(generico);
    expect(mensajeErrorEnvio({ code: "XX000", message: "x" })).toBe(generico);
  });
});

describe("renglonesBloqueados", () => {
  it("separa sin código de inactivos, en orden y sin repetir", () => {
    const r = renglonesBloqueados([
      { name: "A", saintCode: null, isActive: true },
      { name: "B", saintCode: "  ", isActive: true },
      { name: "C", saintCode: "S-1", isActive: false },
      { name: "A", saintCode: "", isActive: true },
      { name: "C", saintCode: "S-1", isActive: false },
      { name: "D", saintCode: "S-2", isActive: true },
    ]);
    expect(r).toEqual({ sinCodigo: ["A", "B"], inactivos: ["C"] });
  });
  it("un producto sin código e inactivo va solo en sinCodigo", () => {
    expect(renglonesBloqueados([{ name: "E", saintCode: null, isActive: false }])).toEqual({
      sinCodigo: ["E"],
      inactivos: [],
    });
  });
  it("todo en regla: ambos vacíos", () => {
    expect(renglonesBloqueados([{ name: "F", saintCode: "S-9", isActive: true }])).toEqual({ sinCodigo: [], inactivos: [] });
  });
});

describe("textoBloqueo", () => {
  it("null si no hay nada", () => {
    expect(textoBloqueo({ sinCodigo: [], inactivos: [] })).toBeNull();
  });
  it("solo sin código", () => {
    expect(textoBloqueo({ sinCodigo: ["A", "B"], inactivos: [] })).toBe("Sin código SAINT: A, B.");
  });
  it("solo inactivos", () => {
    expect(textoBloqueo({ sinCodigo: [], inactivos: ["C"] })).toBe("Dados de baja en el inventario: C.");
  });
  it("ambos, unidos por un espacio", () => {
    expect(textoBloqueo({ sinCodigo: ["A"], inactivos: ["C", "D"] })).toBe(
      "Sin código SAINT: A. Dados de baja en el inventario: C, D.",
    );
  });
});
