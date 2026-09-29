import { describe, expect, it } from "vitest";
import { afirmaPromesaDeAsesor } from "@/lib/ai/promise-guard";
import { TEXTO_CONFIRMAR_INVENTARIO, TEXTO_NO_IDENTIFICADO, TEXTO_PRECIO_A_CONFIRMAR, TEXTO_SIN_STOCK } from "@/lib/ai/seba";

// T3b, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026). Frases reales del estudio del VPS: "Un asesor ya
// tiene tu caso" dicho sin que ese turno hubiera llamado a escalar — el
// cliente esperaba a alguien que nadie sabía que lo esperaba. La guarda de
// `agent.ts` escala con `seguimiento` cuando el texto afirma eso y no hubo
// escalada ni hay asesor; este módulo solo decide si el texto lo AFIRMA.

// Copia literal de `DESPEDIDA_SIN_ASESOR` (agent.ts): importarla arrastraría el grafo entero del turno a un test puro.
const DESPEDIDA_SIN_ASESOR =
  "Listo, dejé tu caso registrado para que un asesor lo revise. En cuanto haya alguien disponible te escribe por acá; gracias por la paciencia.";

describe("afirmaPromesaDeAsesor — afirma que una persona ya tiene o va a atender el caso", () => {
  const afirmaciones = [
    "Un asesor ya tiene tu caso y te escribe en un momento.",
    "Ya te paso con un asesor.",
    "Te paso con un asesor para que te confirme.",
    "Tu caso ya está con un asesor.",
    "Un asesor te va a atender apenas abramos.",
    "Un asesor revisa tu pedido en unos minutos.",
    "Ya le avisé a un asesor, te va a escribir por acá.",
    "Listo, ya escalé tu caso.",
    "Te pasaré con una asesora que te confirma el precio.",
    "El asesor te escribirá por acá.",
    "Nuestro equipo ya está revisando tu caso.",
    "Un ASESOR te contactará mañana a primera hora",
    "¡Claro!\nUn asesor lo revisa y te responde.",
  ];

  it.each(afirmaciones)("detecta: %s", (texto) => {
    expect(afirmaPromesaDeAsesor(texto)).not.toBeNull();
  });

  it("los textos fijos de Seba (los que salen con una escalada) también son afirmaciones", () => {
    // Por eso la guarda solo actúa cuando NO hubo escalada: con ella, la promesa es verdad.
    for (const texto of [TEXTO_CONFIRMAR_INVENTARIO, TEXTO_SIN_STOCK, TEXTO_NO_IDENTIFICADO, TEXTO_PRECIO_A_CONFIRMAR, DESPEDIDA_SIN_ASESOR]) {
      expect(afirmaPromesaDeAsesor(texto)).not.toBeNull();
    }
  });

  it("devuelve la frase que calzó, para dejarla en el registro", () => {
    expect(afirmaPromesaDeAsesor("Claro, tenemos el aceite. Ya te paso con un asesor. Gracias")).toBe(
      "Ya te paso con un asesor"
    );
  });
});

describe("afirmaPromesaDeAsesor — lo condicional, informativo o una pregunta NO es una promesa", () => {
  const noAfirman = [
    "Si quieres, te paso con un asesor.",
    "Si prefieres, un asesor te escribe.",
    "¿Quieres que te pase con un asesor?",
    "¿Te paso con un asesor?",
    "Puedo pasarte con un asesor si lo necesitas.",
    "Podría pasarte con un asesor para eso.",
    "Si necesitas más ayuda, un asesor te atiende.",
    "Los asesores atienden de lunes a viernes de 8 a 6.",
    "Un asesor puede confirmarte eso en la tienda.",
    "En caso de dudas, un asesor te ayuda.",
    "",
    "   ",
    "Tenemos el aceite Inca 20W50 disponible, ¿lo quieres?",
    "Ya reviso tu caso, dame un segundo.",
    "Las pastillas de freno para tu moto están disponibles.",
  ];

  it.each(noAfirman)("no detecta: %s", (texto) => {
    expect(afirmaPromesaDeAsesor(texto)).toBeNull();
  });

  it("una promesa en una frase y un condicional en otra: gana la promesa", () => {
    expect(afirmaPromesaDeAsesor("Si quieres, te muestro más. Ya te paso con un asesor.")).not.toBeNull();
  });
});
