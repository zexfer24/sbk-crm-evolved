import { describe, expect, it } from "vitest";
import {
  catalogQuery,
  catalogTermGroups,
  DESCRIPTIVAS,
  MOTOS_CONOCIDAS,
  normalize,
  searchTerms,
  singular,
  type SearchSynonym,
} from "@/lib/ai/catalog-search";

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

// ---------------------------------------------------------------------------
// T1, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): `catalogQuery` separa la consulta en cuatro
// conjuntos que `buscar_productos` (migración 20260928010000) trata distinto:
// obligatorios (definen el puntaje), opcionales (solo desempatan), moto con
// nombre y cilindrada (solo ordenan). Casos reales del estudio del VPS.
// ---------------------------------------------------------------------------

describe("DESCRIPTIVAS", () => {
  /**
   * La lista es CERRADA a propósito (pedido del operador): una palabra que
   * se cuela acá deja de exigirse en el nombre del producto. Fijarla con su
   * literal obliga a que sumar o quitar una palabra pase por un test.
   */
  it("es exactamente la lista cerrada del pedido, ya normalizada y singularizada", () => {
    expect([...DESCRIPTIVAS].sort()).toEqual(
      [
        // colores
        "amarilla", "amarillo", "azul", "beige", "blanca", "blanco", "celeste", "color", "dorada", "dorado",
        "gris", "marron", "morada", "morado", "naranja", "negra", "negro", "plateada", "plateado", "roja",
        "rojo", "rosada", "rosado", "verde",
        // acabado y posición
        "brillante", "mate", "delantera", "delantero", "trasera", "trasero", "izquierda", "izquierdo",
        "derecha", "derecho", "cromada", "cromado",
        // calidad y tipo
        "semi", "sintetico", "mineral", "original", "generico", "universal", "economico", "buena", "bueno",
        "integral", "adaptable",
        // otras
        "moto", "talla", "4t", "2t", "edge", "juego", "par",
      ].sort()
    );
  });
});

describe("MOTOS_CONOCIDAS", () => {
  it("es exactamente la lista fijada (marcas y modelos que por sí solos nunca son un repuesto)", () => {
    expect([...MOTOS_CONOCIDAS].sort()).toEqual(
      [
        "ava", "bajaj", "bera", "beta", "boxer", "brz", "cbf", "deer", "discover", "dsr", "ek", "empire", "gr",
        "gs", "gxs", "haojue", "honda", "horse", "jaguar", "kavak", "kawasaki", "keeway", "klr", "ktm",
        "lechuza", "md", "mustang", "nxr", "owen", "pulsar", "rk", "sbr", "socialista", "suzuki",
        "tigrito", "tvs", "tx", "xpress", "xtz", "yamaha", "ybr",
      ].sort()
    );
  });
});

describe("catalogQuery", () => {
  const vacio = { grupos: [], opcionales: [], moto: [], cilindrada: [] };

  it("una consulta vacía no devuelve nada", () => {
    expect(catalogQuery("   ")).toEqual(vacio);
  });

  it("las palabras descriptivas van a opcionales, el producto y la marca quedan obligatorios", () => {
    expect(catalogQuery("aceite 20w50 semi sintetico inca")).toEqual({
      ...vacio,
      grupos: [["aceite"], ["20w50"], ["inca"]],
      opcionales: [["semi"], ["sintetico"]],
    });
    expect(catalogQuery("aceite motul 5100 15w50 semi sintetico")).toEqual({
      ...vacio,
      grupos: [["aceite"], ["motul"], ["5100"], ["15w50"]],
      opcionales: [["semi"], ["sintetico"]],
    });
  });

  it("'casco bonnie edge' y los colores/acabados son opcionales; 'original' tampoco cambia el conjunto obligatorio", () => {
    expect(catalogQuery("casco bonnie edge")).toEqual({ ...vacio, grupos: [["casco"], ["bonnie"]], opcionales: [["edge"]] });
    expect(catalogQuery("casco sirius electron integral gris mate")).toEqual({
      ...vacio,
      // `singular` le quita la "s" a "sirius" ("siriu"): calza igual por
      // inicio de palabra en la base (\msiriu), así que no se toca acá.
      grupos: [["casco"], ["siriu"], ["electron"]],
      opcionales: [["integral"], ["gris"], ["mate"]],
    });
    expect(catalogQuery("aceite inca original")).toEqual({
      ...vacio,
      grupos: [["aceite"], ["inca"]],
      opcionales: [["original"]],
    });
  });

  it("el plural y el femenino de una descriptiva también son opcionales (cascos azules, verdes, grises)", () => {
    expect(catalogQuery("cascos negros")).toEqual({ ...vacio, grupos: [["casco"]], opcionales: [["negro"]] });
    expect(catalogQuery("cascos azules")).toEqual({ ...vacio, grupos: [["casco"]], opcionales: [["azul"]] });
    expect(catalogQuery("cascos verdes")).toEqual({ ...vacio, grupos: [["casco"]], opcionales: [["verde"]] });
    expect(catalogQuery("cascos grises")).toEqual({ ...vacio, grupos: [["casco"]], opcionales: [["gris"]] });
    expect(catalogQuery("guantes originales")).toEqual({ ...vacio, grupos: [["guante"]], opcionales: [["original"]] });
  });

  it("'4 tiempos' y '2 tiempos' se convierten en el opcional 4t/2t (y '4t' escrito también)", () => {
    expect(catalogQuery("oilstone 4 tiempos")).toEqual({ ...vacio, grupos: [["oilstone"]], opcionales: [["4t"]] });
    expect(catalogQuery("aceite 2 tiempos")).toEqual({ ...vacio, grupos: [["aceite"]], opcionales: [["2t"]] });
    expect(catalogQuery("oilstone 4t")).toEqual({ ...vacio, grupos: [["oilstone"]], opcionales: [["4t"]] });
  });

  describe("viscosidad", () => {
    it("(0|5|10|15|20|25)/(20|30|40|50|60) produce UN solo grupo NNwNN", () => {
      expect(catalogQuery("aceite iphone 20/50").grupos).toEqual([["aceite"], ["iphone"], ["20w50"]]);
      expect(catalogQuery("aceite 10 40").grupos).toEqual([["aceite"], ["10w40"]]);
      expect(catalogQuery("aceite 20-50").grupos).toEqual([["aceite"], ["20w50"]]);
      expect(catalogQuery("aceite 15w-40").grupos).toEqual([["aceite"], ["15w40"]]);
      expect(catalogQuery("aceite 20w50").grupos).toEqual([["aceite"], ["20w50"]]);
    });

    /** Una medida de caucho NO es un aceite: por eso los valores están restringidos. */
    it("'90/90-18' (medida de caucho) NO se lee como viscosidad", () => {
      expect(catalogQuery("caucho 90/90-18").grupos).toEqual([["caucho"], ["90"], ["18"]]);
    });

    /**
     * Decisión del implementador (28/9/2026): un ancho de tres dígitos entre
     * 50 y 400 pegado a una barra ("100/90-17", "80/100-14") es la medida del
     * caucho, no la cilindrada de una moto — sin esto "caucho 100/90-17"
     * perdía el 100 como requisito.
     */
    it("los números de una medida de caucho (110/90-17, 80/100-14) siguen siendo obligatorios, no cilindrada", () => {
      expect(catalogQuery("caucho 110/90-17")).toEqual({ ...vacio, grupos: [["caucho"], ["110"], ["90"], ["17"]] });
      expect(catalogQuery("caucho 80/100-14")).toEqual({ ...vacio, grupos: [["caucho"], ["80"], ["100"], ["14"]] });
      // Pero una cilindrada suelta en la misma frase sigue siéndolo.
      expect(catalogQuery("caucho 110/90-17 250").cilindrada).toEqual([["250"]]);
    });
  });

  describe("moto con nombre y cilindrada", () => {
    it("una moto conocida va a `moto`; el 250 suelto es cilindrada, no un término", () => {
      expect(catalogQuery("defensa gxs 250")).toEqual({
        ...vacio,
        grupos: [["defensa"]],
        moto: [["gxs"]],
        cilindrada: [["250"]],
      });
      expect(catalogQuery("defensa ava mustang 250")).toEqual({
        ...vacio,
        grupos: [["defensa"]],
        moto: [["ava"], ["mustang"]],
        cilindrada: [["250"]],
      });
    });

    it("'200cc' y '200 cc' son cilindrada sin la 'cc'", () => {
      expect(catalogQuery("leva racing 200cc")).toEqual({ ...vacio, grupos: [["leva"], ["racing"]], cilindrada: [["200"]] });
      expect(catalogQuery("leva racing 200 cc")).toEqual({ ...vacio, grupos: [["leva"], ["racing"]], cilindrada: [["200"]] });
      expect(catalogQuery("aceite 50cc").cilindrada).toEqual([["50"]]);
    });

    it("un número suelto de 3 dígitos entre 50 y 400 es cilindrada; fuera de rango o de 2 dígitos es término", () => {
      expect(catalogQuery("bujia 125")).toEqual({ ...vacio, grupos: [["bujia"]], cilindrada: [["125"]] });
      expect(catalogQuery("cadena 400").cilindrada).toEqual([["400"]]);
      expect(catalogQuery("cadena 428")).toEqual({ ...vacio, grupos: [["cadena"], ["428"]] });
      expect(catalogQuery("maleta 45")).toEqual({ ...vacio, grupos: [["maleta"], ["45"]] });
      expect(catalogQuery("cadena 520").grupos).toEqual([["cadena"], ["520"]]);
    });

    it("'sbr 200' es moto + cilindrada (la moto ya no se une con su número); 'ek' de 2 letras también es moto", () => {
      expect(catalogQuery("sbr 200")).toEqual({ ...vacio, moto: [["sbr"]], cilindrada: [["200"]] });
      expect(catalogQuery("bujia ek")).toEqual({ ...vacio, grupos: [["bujia"]], moto: [["ek"]] });
    });

    it("beta es una moto conocida (nunca un término obligatorio)", () => {
      expect(catalogQuery("cadena beta")).toEqual({ ...vacio, grupos: [["cadena"]], moto: [["beta"]] });
    });

    it("'rin trasero bera': el producto obligatorio, el lado opcional y la moto con nombre", () => {
      expect(catalogQuery("rin trasero bera")).toEqual({
        ...vacio,
        grupos: [["rin"]],
        opcionales: [["trasero"]],
        moto: [["bera"]],
      });
    });
  });

  describe("uniones letra + número (lo que ya hacía catalogTermGroups)", () => {
    it("siglas de 1-2 letras se unen con su número en UN grupo (dt 200, cg 150)", () => {
      expect(catalogQuery("dt 200")).toEqual({ ...vacio, grupos: [["dt200", "dt 200"]] });
      expect(catalogQuery("cg 150")).toEqual({ ...vacio, grupos: [["cg150", "cg 150"]] });
    });

    it("letras de 3-4 con un número corto arman la sigla y la unión (rin 17)", () => {
      expect(catalogQuery("rin 17")).toEqual({ ...vacio, grupos: [["rin"], ["rin17", "rin 17", "17"]] });
    });

    it("letras de 3-4 con una cilindrada NO se unen: la sigla queda obligatoria y el número ordena", () => {
      expect(catalogQuery("rin 250")).toEqual({ ...vacio, grupos: [["rin"]], cilindrada: [["250"]] });
    });

    it("una descriptiva antes de un número no se une con él ('talla 38')", () => {
      expect(catalogQuery("casco talla 38")).toEqual({ ...vacio, grupos: [["casco"], ["38"]], opcionales: [["talla"]] });
    });

    it("una descriptiva corta antes de un número tampoco se une ('par 12')", () => {
      expect(catalogQuery("bujia par 12")).toEqual({ ...vacio, grupos: [["bujia"], ["12"]], opcionales: [["par"]] });
    });
  });

  describe("palabras cortas que no se unen con el número siguiente", () => {
    it.each([
      ["maleta de 45", [["maleta"], ["45"]]],
      ["caja del 45", [["caja"], ["45"]]],
      ["filtro y 12", [["filtro"], ["12"]]],
      ["cadena o 45", [["cadena"], ["45"]]],
      ["correa a 45", [["correa"], ["45"]]],
      ["correa al 45", [["correa"], ["45"]]],
      ["tapa la 45", [["tapa"], ["45"]]],
      ["tapa el 45", [["tapa"], ["45"]]],
      ["tapa es 45", [["tapa"], ["45"]]],
      ["tapa un 45", [["tapa"], ["45"]]],
      ["tapa por 45", [["tapa"], ["45"]]],
      ["tapa con 45", [["tapa"], ["45"]]],
      ["tapa x 45", [["tapa"], ["45"]]],
      ["tapa en 45", [["tapa"], ["45"]]],
    ])("%s", (consulta, grupos) => {
      expect(catalogQuery(consulta).grupos).toEqual(grupos);
    });

    it("'de 125' no se une con el número: 125 es cilindrada", () => {
      expect(catalogQuery("bujia de 125")).toEqual({ ...vacio, grupos: [["bujia"]], cilindrada: [["125"]] });
    });
  });

  describe("decimales", () => {
    it("'11.7' se conserva entero (el punto lo escapa la base)", () => {
      expect(catalogQuery("11.7")).toEqual({ ...vacio, grupos: [["11.7"]] });
      expect(catalogQuery("base givi h11.7").grupos).toEqual([["base"], ["givi"], ["h11.7"]]);
    });
  });

  describe("año", () => {
    it("'año'/'ano' es relleno y el año que lo sigue se descarta (nunca es un requisito)", () => {
      expect(catalogQuery("asiento sbr año 2020")).toEqual({ ...vacio, grupos: [["asiento"]], moto: [["sbr"]] });
      expect(catalogQuery("asiento sbr ano 2020")).toEqual({ ...vacio, grupos: [["asiento"]], moto: [["sbr"]] });
      expect(catalogQuery("asiento año")).toEqual({ ...vacio, grupos: [["asiento"]] });
    });

    it("'ano' también es relleno para searchTerms (comparte RELLENO)", () => {
      expect(searchTerms("repuesto año")).toEqual(["repuesto"]);
    });
  });

  describe("sinónimos y duplicados", () => {
    it("un sinónimo activo suma su destino como alternativa del grupo obligatorio", () => {
      const sinonimos: SearchSynonym[] = [{ from: "pastilla", to: "pastillas de freno" }];

      expect(catalogQuery("pastilla bera", sinonimos)).toEqual({
        ...vacio,
        grupos: [["pastilla", "pastillas de freno"]],
        moto: [["bera"]],
      });
    });

    it("un sinónimo inactivo no suma nada", () => {
      expect(catalogQuery("pastilla", [{ from: "pastilla", to: "pastillas de freno", isActive: false }]).grupos).toEqual([
        ["pastilla"],
      ]);
    });

    it("no repite un grupo, un opcional, una moto ni una cilindrada escritos dos veces", () => {
      expect(catalogQuery("casco casco negro negro bera bera 250 250")).toEqual({
        ...vacio,
        grupos: [["casco"]],
        opcionales: [["negro"]],
        moto: [["bera"]],
        cilindrada: [["250"]],
      });
    });

    it("no pasa de 12 grupos obligatorios", () => {
      const consulta = "aa1 bb2 cc3 dd4 ee5 ff6 gg7 hh8 ii9 jj10 kk11 ll12 mm13 nn14";
      expect(catalogQuery(consulta).grupos).toHaveLength(12);
    });
  });

  it("catalogTermGroups sigue devolviendo lo de siempre (la usa tools.ts hasta T3a)", () => {
    expect(catalogTermGroups("sbr 200")).toEqual([["sbr"], ["sbr200", "sbr 200", "200"]]);
  });
});
