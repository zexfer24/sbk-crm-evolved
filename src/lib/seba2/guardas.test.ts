import { describe, expect, it } from "vitest";
import {
  GUARDAS,
  instruccionDeReescritura,
  revisarSalida,
  type ContextoDeSalida,
  type Guarda,
} from "@/lib/seba2/guardas";

// Entrega 3 de Seba v2 (17/11/2026), tarea S7. Las guardas de salida deciden si
// un texto redactado por el MODELO puede llegarle al cliente o lleva un dato
// que solo puede dar el código (cifras, enlaces) o un asesor (pagos, Cashea,
// nombres). Los datos de estos tests son inventados: el repo es público.

function ctx(parcial: Partial<ContextoDeSalida> = {}): ContextoDeSalida {
  return {
    fuentes: [],
    pasoEnEsteTurno: false,
    nombresDeAsesores: [],
    rafaga: [],
    ...parcial,
  };
}

/** La guarda que frena `texto`, o `null` si pasa. */
function guardaDe(texto: string, parcial: Partial<ContextoDeSalida> = {}): Guarda | null {
  const veredicto = revisarSalida(texto, ctx(parcial));
  return veredicto.ok ? null : veredicto.guarda;
}

describe("GUARDAS — el orden de la lista es el orden de evaluación", () => {
  it("lista las nueve guardas en el orden del brief", () => {
    expect([...GUARDAS]).toEqual([
      "identidad",
      "nombre_propio",
      "cifra_sin_fuente",
      "promesa_sin_pase",
      "estado_interno",
      "nombre_interno",
      "pago_confirmado",
      "dato_de_pago",
      "cashea_calculada",
    ]);
  });

  it("un texto que viola dos reglas devuelve la PRIMERA de la lista", () => {
    expect(guardaDe("Soy Seba, tu pago fue confirmado")).toBe("nombre_propio");
    expect(guardaDe("Soy un bot y el sistema está apagado")).toBe("identidad");
    expect(guardaDe("El catálogo está apagado, te escribe el asesor 3")).toBe("estado_interno");
  });

  it("un texto limpio devuelve ok", () => {
    expect(revisarSalida("Quedan pocas, te recomiendo apartarla hoy", ctx())).toEqual({ ok: true });
  });

  it("el fragmento se recorta a 120 caracteres", () => {
    const largo = "x".repeat(200);
    const veredicto = revisarSalida(`Mira ${largo} https://ejemplo.test/${largo}`, ctx());
    expect(veredicto.ok).toBe(false);
    if (!veredicto.ok) expect(veredicto.fragmento.length).toBeLessThanOrEqual(120);
  });
});

describe("identidad", () => {
  it("frena que el modelo se describa como automatizado", () => {
    expect(guardaDe("Soy el asistente automatizado de la tienda")).toBe("identidad");
    expect(guardaDe("Soy un bot, pero te ayudo igual")).toBe("identidad");
  });

  it("frena que afirme ser una persona concreta", () => {
    expect(guardaDe("Soy una asesora de ventas")).toBe("identidad");
  });

  it("devuelve el fragmento de revealsIdentity", () => {
    const veredicto = revisarSalida("Hola, soy un bot", ctx());
    expect(veredicto).toEqual({ ok: false, guarda: "identidad", fragmento: "soy un bot" });
  });
});

describe("nombre_propio (D7: «Seba» es un nombre interno)", () => {
  it("frena que el modelo se presente por su nombre", () => {
    expect(guardaDe("Soy Seba")).toBe("nombre_propio");
    expect(guardaDe("te habla Seba.")).toBe("nombre_propio");
    expect(guardaDe("SEBA a tu orden")).toBe("nombre_propio");
    expect(guardaDe("hola!seba aquí")).toBe("nombre_propio");
  });

  it("no se dispara con nombres de cliente o palabras que solo se le parecen", () => {
    expect(guardaDe("Hola Sebastián, ¿qué buscas para tu moto?")).toBeNull();
    expect(guardaDe("Tenemos cebada para tu caballo")).toBeNull();
    expect(guardaDe("Sebas, dime qué buscas")).toBeNull();
  });

  it("el fragmento es la palabra tal como venía escrita", () => {
    expect(revisarSalida("te habla SEBA.", ctx())).toEqual({
      ok: false,
      guarda: "nombre_propio",
      fragmento: "SEBA",
    });
  });
});

describe("cifra_sin_fuente", () => {
  it("frena una cifra de dinero que no vino de ninguna herramienta", () => {
    expect(guardaDe("El intercomunicador sale en 108$ BCV")).toBe("cifra_sin_fuente");
  });

  it("el fragmento es la cifra sin fuente", () => {
    expect(revisarSalida("Sale en $44", ctx())).toEqual({
      ok: false,
      guarda: "cifra_sin_fuente",
      fragmento: "44",
    });
  });

  it("deja pasar el precio que devolvió la herramienta en este turno", () => {
    const fuentes = ["Casco LS2 — $12,50 BCV (Bs. 9.850,00)"];
    expect(guardaDe("Te sale en $12,50 BCV (Bs. 9.850,00)", { fuentes })).toBeNull();
  });

  it("deja pasar una cifra que el propio cliente escribió en la ráfaga", () => {
    expect(guardaDe("Sí, por 44$ lo tenemos", { rafaga: ["tienen alguno de 44$?"] })).toBeNull();
  });

  it("deja pasar una cifra de una lección o herramienta de este turno", () => {
    expect(
      guardaDe("El envío es gratis con Cashea, compra mínima de 25 $", { fuentes: ["compra mínima 25 $"] })
    ).toBeNull();
  });

  it("no cuenta números sin moneda: medidas, cantidades", () => {
    expect(guardaDe("Tenemos la medida 90/90-18, quedan 5")).toBeNull();
  });
});

describe("promesa_sin_pase", () => {
  const frase = "Ya pasé tu caso a un asesor";

  it("frena la promesa cuando este turno NO le pasó el caso a nadie", () => {
    expect(guardaDe(frase, { pasoEnEsteTurno: false })).toBe("promesa_sin_pase");
  });

  it("deja pasar la misma frase si el turno sí hizo el pase", () => {
    expect(guardaDe(frase, { pasoEnEsteTurno: true })).toBeNull();
  });

  it("frena otras formas de la promesa", () => {
    expect(guardaDe("Un asesor ya tiene tu caso")).toBe("promesa_sin_pase");
    expect(guardaDe("Te paso con un asesor ahora mismo")).toBe("promesa_sin_pase");
  });

  it("no frena el ofrecimiento condicional", () => {
    expect(guardaDe("Si quieres, te paso con un asesor")).toBeNull();
  });

  it("el fragmento es la frase que prometía", () => {
    const veredicto = revisarSalida(frase, ctx({ pasoEnEsteTurno: false }));
    expect(veredicto).toEqual({ ok: false, guarda: "promesa_sin_pase", fragmento: frase });
  });
});

describe("estado_interno", () => {
  it("frena el caso real de la búsqueda apagada", () => {
    expect(guardaDe("La búsqueda de catálogo está temporalmente apagada")).toBe("estado_interno");
  });

  it("frena el catálogo cuando va con un verbo de estado o falla", () => {
    expect(guardaDe("El catálogo está apagado")).toBe("estado_interno");
    expect(guardaDe("No me carga el catálogo ahorita")).toBe("estado_interno");
    expect(guardaDe("El catálogo no responde")).toBe("estado_interno");
    expect(guardaDe("EL CATÁLOGO NO RESPONDE")).toBe("estado_interno");
  });

  it("deja pasar el catálogo cuando solo se menciona o se envía", () => {
    expect(guardaDe("Te envío el catálogo")).toBeNull();
    expect(guardaDe("En el catálogo aparece con otro nombre")).toBeNull();
    expect(guardaDe("Aquí tienes el catálogo de cascos")).toBeNull();
  });

  it("frena las demás frases que delatan la maquinaria", () => {
    expect(guardaDe("El sistema no me muestra eso")).toBe("estado_interno");
    expect(guardaDe("Estoy usando la herramienta de inventario")).toBe("estado_interno");
    expect(guardaDe("Lo busqué en la base de datos")).toBe("estado_interno");
    expect(guardaDe("Esa función está fuera de servicio")).toBe("estado_interno");
    expect(guardaDe("No tengo información disponible sobre eso")).toBe("estado_interno");
    expect(guardaDe("No tengo registrado ese modelo")).toBe("estado_interno");
    expect(guardaDe("Ahorita está apagada la consulta")).toBe("estado_interno");
    expect(guardaDe("Hice la búsqueda y no salió")).toBe("estado_interno");
  });

  it("ignora tildes y mayúsculas, y devuelve el fragmento como venía escrito", () => {
    const veredicto = revisarSalida("Está FUERA DE SERVICIO por ahora", ctx());
    expect(veredicto).toEqual({ ok: false, guarda: "estado_interno", fragmento: "FUERA DE SERVICIO" });
    expect(guardaDe("La búsqueda no sirve")).toBe("estado_interno");
    expect(guardaDe("La busqueda no sirve")).toBe("estado_interno");
  });

  it("«el sistema de frenos» es un repuesto, no el sistema interno", () => {
    expect(guardaDe("Revisa el sistema de frenos de la moto")).toBeNull();
  });
});

describe("nombre_interno", () => {
  it("frena el caso real «Asesor 2», con o sin espacio", () => {
    expect(guardaDe("Te va a atender el Asesor 2", { pasoEnEsteTurno: true })).toBe("nombre_interno");
    expect(guardaDe("Escríbele a la asesora3")).toBe("nombre_interno");
  });

  it("frena el nombre de un asesor real, sin distinguir tildes ni mayúsculas", () => {
    const nombresDeAsesores = ["María José", "ASESOR 2", "", "Al"];
    expect(guardaDe("te escribe María José", { nombresDeAsesores })).toBe("nombre_interno");
    expect(guardaDe("te escribe maria jose", { nombresDeAsesores })).toBe("nombre_interno");
    expect(guardaDe("te atiende el asesor 2", { nombresDeAsesores })).toBe("nombre_interno");
  });

  it("ignora los nombres de menos de 3 letras y los vacíos", () => {
    const nombresDeAsesores = ["María José", "ASESOR 2", "", "Al"];
    expect(guardaDe("Al llegar a la tienda te atendemos", { nombresDeAsesores })).toBeNull();
  });

  it("exige palabra completa: «Luis» no calza dentro de «Luisana»", () => {
    const nombresDeAsesores = ["Luis"];
    expect(guardaDe("Hola Luisana, ¿qué buscas?", { nombresDeAsesores })).toBeNull();
    expect(guardaDe("Te escribe Luis, de la tienda", { nombresDeAsesores })).toBe("nombre_interno");
  });

  it("no se dispara con «asesor» a secas", () => {
    expect(guardaDe("Un asesor lo confirma", { pasoEnEsteTurno: true })).toBeNull();
  });
});

describe("pago_confirmado", () => {
  it("frena el caso real «gracias por tu compra»", () => {
    expect(guardaDe("¡Gracias por tu compra! Ya estamos procesando tu pedido")).toBe("pago_confirmado");
    expect(guardaDe("Gracias por su compra")).toBe("pago_confirmado");
  });

  it("frena las demás confirmaciones de pago o compra", () => {
    expect(guardaDe("Pago verificado")).toBe("pago_confirmado");
    expect(guardaDe("Tu pago está confirmado")).toBe("pago_confirmado");
    expect(guardaDe("Pago recibido con éxito")).toBe("pago_confirmado");
    expect(guardaDe("Compra aprobada")).toBe("pago_confirmado");
    expect(guardaDe("Tu compra fue confirmada")).toBe("pago_confirmado");
    expect(guardaDe("Tu pago fue aprobado")).toBe("pago_confirmado");
    expect(guardaDe("Su pago ha sido verificado")).toBe("pago_confirmado");
    expect(guardaDe("Tu pago quedó confirmado")).toBe("pago_confirmado");
  });

  it("recibir el comprobante no es confirmar el pago", () => {
    expect(
      guardaDe("Recibimos tu comprobante ✅ Un asesor lo verifica", { pasoEnEsteTurno: true })
    ).toBeNull();
  });
});

describe("dato_de_pago", () => {
  it("frena un número de cuenta inventado (7 o más dígitos seguidos)", () => {
    expect(guardaDe("Transfiere a la cuenta 01020000123456789012")).toBe("dato_de_pago");
    expect(guardaDe("Mi teléfono es 04140000000")).toBe("dato_de_pago");
  });

  it("los separadores cortan la secuencia: no dispara por esta regla", () => {
    expect(guardaDe("Llámanos al 0414-000-0000")).toBeNull();
  });

  it("frena un correo que no está en la ráfaga ni en las fuentes", () => {
    expect(guardaDe("Escríbenos a pagos@ejemplo.test")).toBe("dato_de_pago");
  });

  it("frena una URL inventada", () => {
    expect(guardaDe("Paga aquí: https://ejemplo.test/pagar")).toBe("dato_de_pago");
    expect(guardaDe("Entra a www.ejemplo.test/pagar")).toBe("dato_de_pago");
  });

  it("deja pasar el dato que el cliente mismo escribió en la ráfaga", () => {
    expect(
      guardaDe("Anoté el 04140000000", { rafaga: ["mi número es 04140000000"] })
    ).toBeNull();
  });

  it("deja pasar un enlace que trajo la biblioteca en este turno", () => {
    const fuentes = ["Catálogo de cascos: https://ejemplo.test/catalogo"];
    expect(guardaDe("Te envío el catálogo por aquí: https://ejemplo.test/catalogo", { fuentes })).toBeNull();
    // La puntuación pegada al enlace no lo vuelve otro enlace.
    expect(guardaDe("Te lo envío por aquí: https://ejemplo.test/catalogo.", { fuentes })).toBeNull();
    expect(guardaDe("Mira *https://ejemplo.test/catalogo*", { fuentes })).toBeNull();
  });

  it("deja pasar un número largo que viene de una fuente", () => {
    expect(guardaDe("Tu referencia es 1234567", { fuentes: ["referencia 1234567"] })).toBeNull();
  });
});

describe("cashea_calculada (D4: la inicial y las cuotas las da un asesor)", () => {
  // Las cifras llevan fuente a propósito: esta guarda frena aun así la CUENTA
  // de Cashea, que no es un dato de herramienta sino un cálculo del modelo.
  const fuentes = ["36,60 14,23 100"];

  it("frena el caso real: «inicial $36,60 y 6 cuotas de $14,23»", () => {
    expect(guardaDe("Con Cashea sería inicial de $36,60 y 6 cuotas de $14,23", { fuentes })).toBe(
      "cashea_calculada"
    );
  });

  it("frena «cuotas de» con un monto en bolívares, en dólares o con decimales", () => {
    expect(guardaDe("Son cuotas de Bs 14,23", { fuentes })).toBe("cashea_calculada");
    expect(guardaDe("Serían cuotas de 14,23 dólares", { fuentes })).toBe("cashea_calculada");
    expect(guardaDe("La cuota de 14,23 va cada quincena", { fuentes })).toBe("cashea_calculada");
    expect(guardaDe("Una inicial de 36,60", { fuentes })).toBe("cashea_calculada");
  });

  it("frena el porcentaje junto a inicial, nivel o cuota", () => {
    expect(guardaDe("En el nivel 3 la inicial es del 20%")).toBe("cashea_calculada");
    expect(guardaDe("Pagas 30 % de inicial y el resto en cuotas")).toBe("cashea_calculada");
    expect(guardaDe("Tu nivel te da 10% menos")).toBe("cashea_calculada");
  });

  it("un porcentaje lejos de esas palabras no es de Cashea", () => {
    // «cuotas» aparece, pero a más de 40 caracteres del porcentaje.
    expect(
      guardaDe(
        "Las pastillas rinden 50% más que las normales, te lo aseguro y duran un montón. Si quieres pagar en cuotas, dime."
      )
    ).toBeNull();
  });

  it("«seis cuotas desde 100 $» lo dice el sistema: pasa con ese dato en las fuentes", () => {
    expect(guardaDe("Con Cashea tienes seis cuotas desde 100 $", { fuentes: ["100 $"] })).toBeNull();
  });

  it("nombrar Cashea o las cuotas sin calcular nada pasa", () => {
    expect(guardaDe("Aceptamos Cashea, un asesor te dice los detalles", { pasoEnEsteTurno: true })).toBeNull();
  });
});

describe("falsos positivos que NO se permiten (frases reales de un vendedor)", () => {
  const limpios = [
    "Quedan pocas, te recomiendo apartarla hoy",
    "La medida es 90/90-18",
    "Hola Sebastián, ¿qué buscas para tu moto?",
    "¿Para qué moto es? Así te confirmo si te sirve.",
    "Sí lo tenemos, quedan 3 disponibles",
    "Atendemos de lunes a viernes de 8 a 6",
    "Te lo apartamos hasta mañana",
  ];
  for (const texto of limpios) {
    it(`deja pasar: ${texto}`, () => {
      expect(guardaDe(texto)).toBeNull();
    });
  }
});

describe("instruccionDeReescritura", () => {
  const fragmentos: Array<{ guarda: Guarda; fragmento: string }> = [
    { guarda: "identidad", fragmento: "soy un bot" },
    { guarda: "nombre_propio", fragmento: "Seba" },
    { guarda: "cifra_sin_fuente", fragmento: "108" },
    { guarda: "promesa_sin_pase", fragmento: "Ya pasé tu caso a un asesor" },
    { guarda: "estado_interno", fragmento: "apagada" },
    { guarda: "nombre_interno", fragmento: "Asesor 2" },
    { guarda: "pago_confirmado", fragmento: "gracias por tu compra" },
    { guarda: "dato_de_pago", fragmento: "04140000000" },
    { guarda: "cashea_calculada", fragmento: "cuotas de $14,23" },
  ];

  for (const veredicto of fragmentos) {
    it(`${veredicto.guarda}: nunca nombra a Seba`, () => {
      expect(instruccionDeReescritura(veredicto)).not.toMatch(/seba/i);
    });
  }

  for (const veredicto of fragmentos.filter((v) => v.guarda !== "nombre_propio")) {
    it(`${veredicto.guarda}: cita el fragmento señalado`, () => {
      expect(instruccionDeReescritura(veredicto)).toContain(veredicto.fragmento);
    });
  }

  it("nombre_propio no puede citar el fragmento (sería nombrarse); pide no usar ningún nombre", () => {
    expect(instruccionDeReescritura({ guarda: "nombre_propio", fragmento: "Seba" })).toMatch(/nombre/i);
  });

  it("si un fragmento trae la palabra «Seba» (p. ej. dentro de una URL) la instrucción la tapa", () => {
    const texto = instruccionDeReescritura({
      guarda: "dato_de_pago",
      fragmento: "https://seba.ejemplo.test/pagar",
    });
    expect(texto).not.toMatch(/\bseba\b/i);
  });

  it("cada guarda tiene su propia frase", () => {
    const frases = new Set(
      fragmentos.map((v) => instruccionDeReescritura(v).replace(v.fragmento, "<x>"))
    );
    expect(frases.size).toBe(GUARDAS.length);
  });
});
