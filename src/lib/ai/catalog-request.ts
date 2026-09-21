import { normalize } from "@/lib/ai/catalog-search";

// ---------------------------------------------------------------------------
// Tarea 2, plan "El catálogo configurado sale siempre" (21/9/2026).
//
// Reporte de solo lectura de producción (VPS, 21/9/2026): "CATALOGO CASCOS" y
// "Catálogo general" son, juntos, el 30 % de las respuestas de escenario en
// 15 días. El plan cede un escenario calzado al inventario cuando la
// intención es `consulta_disponibilidad`, pero eso NO puede aplicarse cuando
// el cliente pidió el catálogo COMO DOCUMENTO ("me envías el PDF", "tienen
// lista de precios"): el inventario responde con texto sobre productos
// puntuales, no con el archivo que el cliente quiere. `pideCatalogo` es la
// condición 3 de esa regla (ver el plan, `docs/planes/2026-09-21-…`): si
// devuelve `true`, el escenario NO se cede, sale tal cual (con su enlace).
//
// Pura, sin `server-only` ni SDK — mismo estilo que `saludo.ts`: una función
// sobre la FORMA del texto que escribió el cliente, sin tocar Supabase ni el
// modelo. Recibe la RÁFAGA (`customerBurst` de `history-line.ts`, que este
// módulo NO importa a propósito — solo respeta su forma: un arreglo de
// líneas de texto del cliente, la más vieja primero) porque un cliente puede
// nombrar el catálogo en una línea y saludar o preguntar otra cosa en la
// siguiente ("Me pasas el catálogo" + "Buenas tardes"): CUALQUIER línea que
// lo pida alcanza — por eso `.some`, no `.every`.
//
// Reusa el normalizador de `catalog-search.ts` (minúsculas + sin acentos, ya
// probado contra "bujía"/"bujia") en vez de escribir uno nuevo: es la misma
// operación que necesita "catálogo" === "catalogo" === "CATÁLOGO".
//
// Qué cuenta como pedir el catálogo, con los errores de tipeo reales del
// reporte del VPS (no se inventan más: "catlogo" no aparece en ningún
// mensaje real, así que no entra):
//   - "catalogo"/"catalogos", y el typo "catalago"/"catalagos".
//   - "pdf".
//   - "lista de precios"/"listas de precios"/"lista de precio".
// Con límites de palabra (`\b`) en los dos extremos: "pdf" no calza dentro de
// otra palabra, y una futura "catalogación" (que hoy no existe en el
// catálogo del negocio) tampoco calzaría por accidente.
//
// Qué NO cuenta, a propósito: "precios de los cascos" sin la palabra
// catálogo (esa decisión es del escenario marcado, no de esta función),
// preguntas de disponibilidad sueltas ("¿tienen pastillas de freno?"), y un
// marcador de media entre corchetes ("[El cliente envió una foto…]") — no
// hace falta descartarlo aparte: ninguno de esos textos contiene ninguna de
// las palabras de arriba.
//
// Decisión documentada del plan: una frase NEGATIVA sobre el catálogo ("No
// están en el catálogo", "el catálogo no me abre") TAMBIÉN devuelve `true`.
// No es un descuido — esta función no decide qué escenario sale, solo si un
// escenario YA CALZADO por la fase 0 se puede ceder al inventario. Para una
// queja sobre el catálogo, fase 0 calza "Error de comentario" (que escala a
// un asesor); ceder ESE escenario al inventario respondería con productos
// sueltos a alguien que está reportando que el enlace no le sirve, que es
// peor que dejarlo escalar como siempre.
// ---------------------------------------------------------------------------

const PATRON_CATALOGO = /\b(catal[oa]gos?|pdf|listas?\s+de\s+precios?)\b/;

/**
 * `true` si ALGUNA línea de la ráfaga del cliente pide el catálogo como
 * documento (ver el comentario de cabecera para la lista exacta y las
 * exclusiones).
 */
export function pideCatalogo(lineas: readonly string[]): boolean {
  return lineas.some((linea) => PATRON_CATALOGO.test(normalize(linea)));
}
