import { describe, expect, it } from "vitest";
import { catalogTermGroups, normalize, searchTerms, singular, type SearchSynonym } from "@/lib/ai/catalog-search";

/**
 * Estos dos casos vienen de correr el agente contra el catálogo real, no de
 * imaginarlos: "tienen bujía NGK?" recibió un "no tenemos" con toda
 * seguridad, teniendo la Bujía CR7HSA marca NGK en el estante.
 *
 * Es el error más caro de esta herramienta porque no se ve: no lanza, no
 * queda en la bitácora, y el cliente se va convencido de que no hay.
 */
describe("searchTerms", () => {
  it("parte la consulta en palabras, para que el nombre y la marca puedan calzar por separado", () => {
    expect(searchTerms("bujía NGK")).toEqual(["bujia", "ngk"]);
  });

  it("quita los acentos, porque por WhatsApp nadie los escribe", () => {
    expect(searchTerms("bujia")).toEqual(["bujia"]);
    expect(searchTerms("Bujía")).toEqual(["bujia"]);
  });

  it("descarta las palabras cortas, que calzan con casi todo", () => {
    expect(searchTerms("kit de arrastre")).toEqual(["kit", "arrastre"]);
  });

  it("no repite un término que el cliente escribió dos veces", () => {
    expect(searchTerms("freno freno delantero")).toEqual(["freno", "delantero"]);
  });

  /** Sin esto, "R6" se quedaría sin términos y la búsqueda traería el catálogo entero. */
  it("usa la consulta entera cuando ninguna palabra llega a tres letras", () => {
    expect(searchTerms("R6")).toEqual(["r6"]);
  });

  it("con una consulta vacía no devuelve términos", () => {
    expect(searchTerms("   ")).toEqual([]);
  });

  /**
   * T1, plan "La búsqueda encuentra lo que el cliente pide" (25-26/9/2026):
   * la búsqueda vieja descartaba "45"/"DT 200" por tener menos de tres
   * letras -- el cliente que escribe "maleta de 45 litros" o "disco freno
   * delantero dt200" se quedaba sin la medida ni el modelo como término.
   */
  it("conserva los números de dos o más dígitos, aunque tengan menos de tres letras", () => {
    expect(searchTerms("maleta 45")).toEqual(["maleta", "45"]);
    expect(searchTerms("cadena 150")).toEqual(["cadena", "150"]);
  });

  it("une un token corto de letras con el número que lo sigue (dt 200 -> dt200)", () => {
    expect(searchTerms("disco freno delantero dt 200")).toEqual(["disco", "freno", "delantero", "dt200"]);
  });

  /**
   * Corrección del orquestador sobre T1 (26/9/2026): "rin 17" daba
   * [["rin17","rin 17","rin"]] -- un solo grupo con "rin" como alternativa
   * SUELTA, así que la medida ("17") dejaba de ser requisito: cualquier rin
   * calzaba. Con letras de 1-2 caracteres (siglas de verdad, "dt", "cg") el
   * número no vale nada suelto y se queda unido nomás; con letras de 3-4
   * ("rin", "sbr") la palabra SÍ es un término completo por su cuenta y el
   * número también, así que quedan como DOS términos en plano: la sigla y
   * la unión -- nunca el número solo, para no duplicar lo que "rin17" ya
   * exige.
   */
  it("con letras de 1-2 y número, une en un solo término (dt200, cg150)", () => {
    expect(searchTerms("dt 200")).toEqual(["dt200"]);
    expect(searchTerms("cg 150")).toEqual(["cg150"]);
  });

  it("con letras de 3-4 y número, deja la sigla Y la unión como dos términos (rin17, sbr200)", () => {
    expect(searchTerms("rin 17")).toEqual(["rin", "rin17"]);
    expect(searchTerms("sbr 200")).toEqual(["sbr", "sbr200"]);
  });

  it("no repite un término cuando el cliente escribe el mismo número dos veces (caucho 90/90-18)", () => {
    expect(searchTerms("caucho 90/90-18")).toEqual(["caucho", "90", "18"]);
  });

  it("una palabra de relleno antes del número no se une con él (para 12 -> se queda solo '12')", () => {
    expect(searchTerms("para 12")).toEqual(["12"]);
  });

  it("singulariza cada palabra antes de devolverla, para que el plural del catálogo calce igual", () => {
    expect(searchTerms("intercomunicadores")).toEqual(["intercomunicador"]);
    expect(searchTerms("pastillas de freno")).toEqual(["pastilla", "freno"]);
  });

  it("quita las palabras de relleno DESPUÉS de singularizar (precios -> precio -> se quita)", () => {
    expect(searchTerms("precio de pastillas para bera")).toEqual(["pastilla", "bera"]);
  });
});

/**
 * T1, plan "La búsqueda encuentra lo que el cliente pide" (25-26/9/2026):
 * antes de esta ola, "pastillas"/"baterias"/"intercomunicadores" no
 * calzaban con el singular del catálogo ("pastilla", "batería"). La regla
 * es por INICIO de palabra en la base, así que el singular calza también
 * con el plural real -- no hace falta adivinar el plural, alcanza con
 * quitarle la "s"/"es" al término que escribió el cliente.
 */
describe("singular", () => {
  it("quita 'es' final en palabras de 5+ letras que terminan en consonante+es (r/l/n/d/j/y)", () => {
    expect(singular("intercomunicadores")).toBe("intercomunicador");
    expect(singular("rines")).toBe("rin");
    expect(singular("motores")).toBe("motor");
  });

  it("si no, quita la 's' final en palabras de 4+ letras", () => {
    expect(singular("baterias")).toBe("bateria");
    expect(singular("defensas")).toBe("defensa");
    expect(singular("pastillas")).toBe("pastilla");
    expect(singular("ejes")).toBe("eje");
    expect(singular("cascos")).toBe("casco");
  });

  it("no toca una palabra que contiene dígitos (dt200, 20w50)", () => {
    expect(singular("dt200")).toBe("dt200");
    expect(singular("20w50")).toBe("20w50");
  });

  /** NO_PLURAL: "tres" y "seis" perderían su significado si se les quitara la "s" ("tre", "sei"). */
  it("deja intactas las palabras de la lista de excepciones (gas, tres, jes)", () => {
    expect(singular("gas")).toBe("gas");
    expect(singular("tres")).toBe("tres");
    expect(singular("jes")).toBe("jes");
  });
});

/**
 * T1 (25-26/9/2026), desvío 1 del plan: los términos del catálogo viajan
 * como GRUPOS de alternativas -- un grupo calza si calza cualquiera de sus
 * alternativas. Hace falta para los sinónimos (que SUMAN una alternativa en
 * vez de reemplazar el término) y para las uniones letra+número ("dt200"/
 * "dt 200" tienen que ser el MISMO grupo, no dos términos obligatorios
 * distintos).
 */
describe("catalogTermGroups", () => {
  it("un término simple es un grupo de una sola alternativa", () => {
    expect(catalogTermGroups("bujia ngk")).toEqual([["bujia"], ["ngk"]]);
  });

  it("'dt 200' arma un grupo con las dos formas de escribirlo", () => {
    expect(catalogTermGroups("dt 200")).toEqual([["dt200", "dt 200"]]);
  });

  it("'cg 150' se comporta igual que 'dt 200' -- letras de 1-2, un solo grupo unido", () => {
    expect(catalogTermGroups("cg 150")).toEqual([["cg150", "cg 150"]]);
  });

  /**
   * Corrección del orquestador sobre T1 (26/9/2026): con letras de 3-4
   * caracteres ("rin", "sbr") la sigla sola YA NO vive dentro del mismo
   * grupo que el número -- si viviera ahí, "rin" solo (sin "17") bastaba
   * para calzar el grupo entero y la medida dejaba de ser requisito
   * ("rin 17" encontraba cualquier rin). Ahora son DOS grupos, los dos
   * obligatorios: la sigla por su lado y la unión (con el número suelto
   * como tercera alternativa) por el suyo.
   */
  it("'rin 17' arma DOS grupos obligatorios: la sigla y la unión con la medida", () => {
    expect(catalogTermGroups("rin 17")).toEqual([["rin"], ["rin17", "rin 17", "17"]]);
  });

  it("'sbr 200' arma DOS grupos obligatorios, igual que 'rin 17'", () => {
    expect(catalogTermGroups("sbr 200")).toEqual([["sbr"], ["sbr200", "sbr 200", "200"]]);
  });

  it("una palabra de relleno antes del número no se une: 'para 12' deja solo el grupo del número", () => {
    expect(catalogTermGroups("para 12")).toEqual([["12"]]);
  });

  /**
   * Corrección del orquestador sobre T1 (26/9/2026): "caucho 90/90-18"
   * partía en cuatro tokens (caucho, 90, 90, 18) y cada "90" armaba su
   * propio grupo -- dos grupos idénticos [["90"],["90"]], que no aportan
   * nada más que el primero y solo inflan `p_terminos`. Se deduplican los
   * grupos idénticos (misma lista de alternativas), conservando el orden
   * de la primera aparición.
   */
  it("deduplica grupos idénticos (caucho 90/90-18 no repite el grupo del 90)", () => {
    expect(catalogTermGroups("caucho 90/90-18")).toEqual([["caucho"], ["90"], ["18"]]);
  });

  it("aplica el relleno y el singular igual que searchTerms", () => {
    expect(catalogTermGroups("precio de pastillas para bera")).toEqual([["pastilla"], ["bera"]]);
  });

  it("un sinónimo agrega el término real como alternativa del mismo grupo, después de singularizar", () => {
    const sinonimos: SearchSynonym[] = [{ from: "litros", to: "lts" }];

    expect(catalogTermGroups("maleta 45 litros", sinonimos)).toEqual([["maleta"], ["45"], ["litro", "lts"]]);
  });

  it("un sinónimo inactivo no agrega ninguna alternativa", () => {
    const sinonimos: SearchSynonym[] = [{ from: "litros", to: "lts", isActive: false }];

    expect(catalogTermGroups("maleta 45 litros", sinonimos)).toEqual([["maleta"], ["45"], ["litro"]]);
  });

  it("sin sinónimos, cada grupo trae solo su propia alternativa", () => {
    expect(catalogTermGroups("bujia ngk", [])).toEqual([["bujia"], ["ngk"]]);
  });
});

describe("normalize", () => {
  it("deja el texto en minúsculas y sin diacríticos", () => {
    expect(normalize("Bujía CR7HSA Ñ")).toBe("bujia cr7hsa n");
  });
});

// `expandTerms` (el término plano + sinónimo aparte, para el viejo `.or()`
// de `products`) se retiró en T2, plan "La búsqueda encuentra lo que el
// cliente pide" (25-26/9/2026): `catalogTermGroups` ya suma el sinónimo como
// alternativa del mismo grupo (ver el describe de arriba, "un sinónimo
// agrega el término real como alternativa del mismo grupo") — su cobertura
// queda cubierta ahí, no hace falta duplicarla.
