import { describe, expect, it } from "vitest";
import {
  catalogQuery,
  catalogTermGroups,
  DESCRIPTIVAS,
  MARCAS_CONOCIDAS,
  MARCAS_DE_MOTO,
  motoDesdeTexto,
  MOTOS_CONOCIDAS,
  normalize,
  RELLENO_CATALOGO,
  searchTerms,
  singular,
  VARIANTES,
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
        // A2 (30/9/2026): "kit" y "set" dejan de ser obligatorios
        "moto", "talla", "4t", "2t", "edge", "juego", "par", "kit", "set",
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
        // A2 (30/9/2026): las que salieron de los casos del VPS. "toro", "new" y
        // "super" quedan AFUERA a propósito: son palabras de producto.
        "milan", "runner", "leon", "rex", "aguila", "rkv", "hj", "cool", "vstrom", "gy6", "bws", "dr",
      ].sort()
    );
  });
});

describe("catalogQuery", () => {
  // A2 (T4, 30/9/2026): la salida ganó `variantes`, `motoMarca`, `anio`,
  // `motoCorregida` y `gruposInfo`. Los tests viejos comparan con
  // `toMatchObject` (los arrays listados sí se comparan enteros) para no
  // repetir `gruposInfo` en cada caso; el test de `gruposInfo` lo fija aparte.
  const vacio = {
    grupos: [],
    opcionales: [],
    variantes: [],
    moto: [],
    motoMarca: [],
    cilindrada: [],
    anio: [],
    motoCorregida: [],
  };

  it("una consulta vacía no devuelve nada", () => {
    expect(catalogQuery("   ")).toMatchObject(vacio);
    expect(catalogQuery("   ").gruposInfo).toEqual([]);
  });

  it("las palabras descriptivas van a opcionales, el producto y la marca quedan obligatorios", () => {
    expect(catalogQuery("aceite 20w50 semi sintetico inca")).toMatchObject({
      ...vacio,
      grupos: [["aceite"], ["20w50"], ["inca"]],
      opcionales: [["semi"], ["sintetico"]],
    });
    expect(catalogQuery("aceite motul 5100 15w50 semi sintetico")).toMatchObject({
      ...vacio,
      grupos: [["aceite"], ["motul"], ["5100"], ["15w50"]],
      opcionales: [["semi"], ["sintetico"]],
    });
  });

  it("'casco bonnie edge' y los colores/acabados son opcionales; 'original' tampoco cambia el conjunto obligatorio", () => {
    expect(catalogQuery("casco bonnie edge")).toMatchObject({ ...vacio, grupos: [["casco"], ["bonnie"]], variantes: [["edge"]] });
    expect(catalogQuery("casco sirius electron integral gris mate")).toMatchObject({
      ...vacio,
      // `singular` le quita la "s" a "sirius" ("siriu"): calza igual por
      // inicio de palabra en la base (\msiriu), así que no se toca acá.
      grupos: [["casco"], ["siriu"], ["electron"]],
      // A2: los colores y el acabado pasan a `variantes` (estrictas y preferentes)
      opcionales: [["integral"]],
      variantes: [["gris"], ["mate"]],
    });
    expect(catalogQuery("aceite inca original")).toMatchObject({
      ...vacio,
      grupos: [["aceite"], ["inca"]],
      opcionales: [["original"]],
    });
  });

  it("el plural de un color también es variante y el de una descriptiva, opcional (cascos azules, verdes, grises)", () => {
    expect(catalogQuery("cascos negros")).toMatchObject({ ...vacio, grupos: [["casco"]], variantes: [["negro"]] });
    expect(catalogQuery("cascos azules")).toMatchObject({ ...vacio, grupos: [["casco"]], variantes: [["azul"]] });
    expect(catalogQuery("cascos verdes")).toMatchObject({ ...vacio, grupos: [["casco"]], variantes: [["verde"]] });
    expect(catalogQuery("cascos grises")).toMatchObject({ ...vacio, grupos: [["casco"]], variantes: [["gris"]] });
    expect(catalogQuery("guantes originales")).toMatchObject({ ...vacio, grupos: [["guante"]], opcionales: [["original"]] });
  });

  it("'4 tiempos' y '2 tiempos' se convierten en el opcional 4t/2t (y '4t' escrito también)", () => {
    expect(catalogQuery("oilstone 4 tiempos")).toMatchObject({ ...vacio, grupos: [["oilstone"]], opcionales: [["4t"]] });
    expect(catalogQuery("aceite 2 tiempos")).toMatchObject({ ...vacio, grupos: [["aceite"]], opcionales: [["2t"]] });
    expect(catalogQuery("oilstone 4t")).toMatchObject({ ...vacio, grupos: [["oilstone"]], opcionales: [["4t"]] });
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
      expect(catalogQuery("caucho 110/90-17")).toMatchObject({ ...vacio, grupos: [["caucho"], ["110"], ["90"], ["17"]] });
      expect(catalogQuery("caucho 80/100-14")).toMatchObject({ ...vacio, grupos: [["caucho"], ["80"], ["100"], ["14"]] });
      // Pero una cilindrada suelta en la misma frase sigue siéndolo.
      expect(catalogQuery("caucho 110/90-17 250").cilindrada).toEqual([["250"]]);
    });
  });

  describe("moto con nombre y cilindrada", () => {
    it("una moto conocida va a `moto`; el 250 suelto es cilindrada, no un término", () => {
      expect(catalogQuery("defensa gxs 250")).toMatchObject({
        ...vacio,
        grupos: [["defensa"]],
        moto: [["gxs"]],
        cilindrada: [["250"]],
      });
      expect(catalogQuery("defensa ava mustang 250")).toMatchObject({
        ...vacio,
        grupos: [["defensa"]],
        moto: [["ava"], ["mustang"]],
        cilindrada: [["250"]],
      });
    });

    it("'200cc' y '200 cc' son cilindrada sin la 'cc'", () => {
      expect(catalogQuery("leva racing 200cc")).toMatchObject({ ...vacio, grupos: [["leva"], ["racing"]], cilindrada: [["200"]] });
      expect(catalogQuery("leva racing 200 cc")).toMatchObject({ ...vacio, grupos: [["leva"], ["racing"]], cilindrada: [["200"]] });
      expect(catalogQuery("aceite 50cc").cilindrada).toEqual([["50"]]);
    });

    it("un número suelto de 3 dígitos entre 50 y 400 es cilindrada; fuera de rango o de 2 dígitos es término", () => {
      expect(catalogQuery("bujia 125")).toMatchObject({ ...vacio, grupos: [["bujia"]], cilindrada: [["125"]] });
      expect(catalogQuery("cadena 400").cilindrada).toEqual([["400"]]);
      expect(catalogQuery("cadena 428")).toMatchObject({ ...vacio, grupos: [["cadena"], ["428"]] });
      expect(catalogQuery("maleta 45")).toMatchObject({ ...vacio, grupos: [["maleta"], ["45"]] });
      expect(catalogQuery("cadena 520").grupos).toEqual([["cadena"], ["520"]]);
    });

    it("'sbr 200' es moto + cilindrada (la moto ya no se une con su número); 'ek' de 2 letras también es moto", () => {
      expect(catalogQuery("sbr 200")).toMatchObject({ ...vacio, moto: [["sbr"]], cilindrada: [["200"]] });
      expect(catalogQuery("bujia ek")).toMatchObject({ ...vacio, grupos: [["bujia"]], moto: [["ek"]] });
    });

    it("beta es una moto conocida (nunca un término obligatorio)", () => {
      expect(catalogQuery("cadena beta")).toMatchObject({ ...vacio, grupos: [["cadena"]], moto: [["beta"]] });
    });

    it("'rin trasero bera': el producto obligatorio, el lado opcional y la moto con nombre", () => {
      expect(catalogQuery("rin trasero bera")).toMatchObject({
        ...vacio,
        grupos: [["rin"]],
        opcionales: [["trasero"]],
        moto: [["bera"]],
      });
    });
  });

  describe("uniones letra + número (lo que ya hacía catalogTermGroups)", () => {
    it("siglas de 1-2 letras se unen con su número en UN grupo (dt 200, cg 150)", () => {
      expect(catalogQuery("dt 200")).toMatchObject({ ...vacio, grupos: [["dt200", "dt 200"]] });
      expect(catalogQuery("cg 150")).toMatchObject({ ...vacio, grupos: [["cg150", "cg 150"]] });
    });

    it("letras de 3-4 con un número corto arman la sigla y la unión (rin 17)", () => {
      expect(catalogQuery("rin 17")).toMatchObject({ ...vacio, grupos: [["rin"], ["rin17", "rin 17", "17"]] });
    });

    it("letras de 3-4 con una cilindrada NO se unen: la sigla queda obligatoria y el número ordena", () => {
      expect(catalogQuery("rin 250")).toMatchObject({ ...vacio, grupos: [["rin"]], cilindrada: [["250"]] });
    });

    it("'talla 38' ya no es un opcional 'talla' con un 38 obligatorio: es la variante 38", () => {
      expect(catalogQuery("casco talla 38")).toMatchObject({ ...vacio, grupos: [["casco"]], variantes: [["38"]] });
    });

    it("una descriptiva corta antes de un número tampoco se une ('par 12')", () => {
      expect(catalogQuery("bujia par 12")).toMatchObject({ ...vacio, grupos: [["bujia"], ["12"]], opcionales: [["par"]] });
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
      expect(catalogQuery("bujia de 125")).toMatchObject({ ...vacio, grupos: [["bujia"]], cilindrada: [["125"]] });
    });
  });

  describe("decimales", () => {
    it("'11.7' se conserva entero (el punto lo escapa la base)", () => {
      expect(catalogQuery("11.7")).toMatchObject({ ...vacio, grupos: [["11.7"]] });
      expect(catalogQuery("base givi h11.7").grupos).toEqual([["base"], ["givi"], ["h11.7"]]);
    });
  });

  describe("año", () => {
    it("'año'/'ano' es relleno y el año que lo sigue nunca es un requisito: va a `anio` (A2)", () => {
      expect(catalogQuery("asiento sbr año 2020")).toMatchObject({
        ...vacio,
        grupos: [["asiento"]],
        moto: [["sbr"]],
        anio: [["2020"]],
      });
      expect(catalogQuery("asiento sbr ano 2020")).toMatchObject({
        ...vacio,
        grupos: [["asiento"]],
        moto: [["sbr"]],
        anio: [["2020"]],
      });
      expect(catalogQuery("asiento año")).toMatchObject({ ...vacio, grupos: [["asiento"]] });
    });

    it("'ano' también es relleno para searchTerms (comparte RELLENO)", () => {
      expect(searchTerms("repuesto año")).toEqual(["repuesto"]);
    });
  });

  describe("sinónimos y duplicados", () => {
    it("un sinónimo activo suma su destino como alternativa del grupo obligatorio", () => {
      const sinonimos: SearchSynonym[] = [{ from: "pastilla", to: "pastillas de freno" }];

      expect(catalogQuery("pastilla bera", sinonimos)).toMatchObject({
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
      expect(catalogQuery("casco casco negro negro bera bera 250 250")).toMatchObject({
        ...vacio,
        grupos: [["casco"]],
        variantes: [["negro"]],
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

// ---------------------------------------------------------------------------
// Entrega A2 "Seba no cotiza lo que no es" (T4, 30/9/2026): `catalogQuery`
// gana variantes, año, marca de moto, medidas de caucho con cualquier
// separador, rin, unidades, tallas y sinónimos de varias palabras. Los casos
// salen de `docs/planes/2026-09-30-seba-a2-casos-del-vps.md` (medidos por el
// VPS contra `products` el 29/9/2026).
// ---------------------------------------------------------------------------

describe("listas cerradas de la A2", () => {
  it("VARIANTES es exactamente la lista fijada: colores, acabados, edge/paleta/rayo/tornasol y tallas", () => {
    expect([...VARIANTES].sort()).toEqual(
      [
        // colores (los mismos de DESCRIPTIVAS)
        "amarilla", "amarillo", "azul", "beige", "blanca", "blanco", "celeste", "dorada", "dorado", "gris",
        "marron", "morada", "morado", "naranja", "negra", "negro", "plateada", "plateado", "roja", "rojo",
        "rosada", "rosado", "verde",
        // acabado y variantes de nombre
        "mate", "brillante", "cromado", "cromada", "edge", "paleta", "rayo", "tornasol",
        // tallas sueltas ("xxxl" solo existe para mapear 3xl)
        "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl",
      ].sort()
    );
  });

  it("MARCAS_DE_MOTO es exactamente la lista fijada y toda marca es también una moto conocida", () => {
    expect([...MARCAS_DE_MOTO].sort()).toEqual(
      [
        "bera", "ek", "empire", "md", "hj", "yamaha", "honda", "suzuki", "kawasaki", "keeway", "haojue", "bajaj",
        "tvs", "ktm", "jaguar",
      ].sort()
    );
    for (const marca of MARCAS_DE_MOTO) expect(MOTOS_CONOCIDAS.has(marca)).toBe(true);
  });

  it("MARCAS_CONOCIDAS es exactamente la lista fijada: marcas comerciales y todas las motos", () => {
    const comerciales = [
      "timsun", "switchera", "ipone", "motorpower", "motul", "inca", "oilstone", "givi", "ls2", "ich", "benf",
      "lefor", "ejeas", "senfi", "carkmotos", "jerez", "aldrich", "tomcat", "buff", "frankie",
    ];
    expect([...MARCAS_CONOCIDAS].sort()).toEqual([...new Set([...comerciales, ...MOTOS_CONOCIDAS])].sort());
  });
});

describe("catalogQuery A2: medidas de caucho", () => {
  it.each([
    ["caucho 130/70-12", [["caucho"], ["130"], ["70"], ["12"]]],
    ["caucho 130/70/12", [["caucho"], ["130"], ["70"], ["12"]]],
    ["caucho 130 70 12", [["caucho"], ["130"], ["70"], ["12"]]],
    ["caucho 130-70-12", [["caucho"], ["130"], ["70"], ["12"]]],
    // El caso real de producción: el 130 se tomaba como cilindrada.
    ["caucho 130 - 70 - 12", [["caucho"], ["130"], ["70"], ["12"]]],
    ["caucho 130/60/R13", [["caucho"], ["130"], ["60"], ["13"]]],
    ["caucho 130/60 R13", [["caucho"], ["130"], ["60"], ["13"]]],
    ["caucho 130/60R13", [["caucho"], ["130"], ["60"], ["13"]]],
    ["caucho 130-80-17", [["caucho"], ["130"], ["80"], ["17"]]],
    ["caucho 90 90 19", [["caucho"], ["90"], ["19"]]],
    ["caucho 90/90-18", [["caucho"], ["90"], ["18"]]],
    ["caucho 80/100-14", [["caucho"], ["80"], ["100"], ["14"]]],
    ["caucho kenda 70/120", [["caucho"], ["kenda"], ["70"], ["120"]]],
    ["caucho 80/100", [["caucho"], ["80"], ["100"]]],
  ])("%s: cada número es un grupo obligatorio y ninguno es cilindrada", (consulta, grupos) => {
    const q = catalogQuery(consulta);
    expect(q.grupos).toEqual(grupos);
    expect(q.cilindrada).toEqual([]);
    expect(q.anio).toEqual([]);
  });

  it("los números de una medida no llevan numeroDe (no complementan a ninguna palabra)", () => {
    expect(catalogQuery("caucho 130 - 70 - 12").gruposInfo.map((g) => g.numeroDe)).toEqual([null, null, null, null]);
  });

  it("la cilindrada suelta en la misma frase sigue siéndolo", () => {
    expect(catalogQuery("caucho 130/70-12 250").cilindrada).toEqual([["250"]]);
  });

  it("dos números con espacio NO son una medida (sin rin válido no se lee como caucho)", () => {
    expect(catalogQuery("maleta 45 30").grupos).toEqual([["maleta"], ["45"], ["30"]]);
  });

  it("la viscosidad se resuelve ANTES que la medida: 20/50, 20 50, 20-50 y 20:50 son 20w50", () => {
    for (const v of ["20/50", "20 50", "20-50", "20:50", "20 : 50"]) {
      expect(catalogQuery(`aceite ${v}`).grupos).toEqual([["aceite"], ["20w50"]]);
    }
    expect(catalogQuery("motul 5100 20:50").grupos).toEqual([["motul"], ["5100"], ["20w50"]]);
    expect(catalogQuery("motul 5100 20/50").grupos).toEqual([["motul"], ["5100"], ["20w50"]]);
  });
});

describe("catalogQuery A2: rin y numeral", () => {
  it("'rin 17' con rin como primera palabra de producto sigue como hoy: rin + rin17|rin 17|17", () => {
    expect(catalogQuery("rin 17").grupos).toEqual([["rin"], ["rin17", "rin 17", "17"]]);
  });

  it("'rin' después de otro sustantivo de producto se descarta y queda solo el número", () => {
    expect(catalogQuery("caucho rin 17").grupos).toEqual([["caucho"], ["17"]]);
    expect(catalogQuery("tripa trasera rin 130-80-17")).toMatchObject({
      grupos: [["tripa"], ["130"], ["80"], ["17"]],
      opcionales: [["trasera"]],
    });
  });

  it("'rin trasero de paleta': rin sigue siendo producto (es la primera palabra) y paleta es variante", () => {
    expect(catalogQuery("rin trasero de paleta")).toMatchObject({
      grupos: [["rin"]],
      opcionales: [["trasero"]],
      variantes: [["paleta"]],
    });
  });

  it.each([
    ["caucho n° 18 delantero"],
    ["caucho nº18 delantero"],
    ["caucho no 18 delantero"],
    ["caucho nro 18 delantero"],
    ["caucho num 18 delantero"],
    ["caucho numero 18 delantero"],
    ["caucho #18 delantero"],
    ["caucho n18 delantero"],
    ["caucho n. 18 delantero"],
  ])("%s: solo el número, nunca 'n', 'no', 'nro' ni 'n18'", (consulta) => {
    expect(catalogQuery(consulta)).toMatchObject({
      grupos: [["caucho"], ["18"]],
      opcionales: [["delantero"]],
      variantes: [],
    });
  });

  it("'tripa de moto n° 18' -> tripa y 18 (moto es opcional)", () => {
    expect(catalogQuery("tripa de moto n° 18")).toMatchObject({
      grupos: [["tripa"], ["18"]],
      opcionales: [["moto"]],
    });
  });

  it("un numeral suelto de un dígito conserva su número (n° 8)", () => {
    expect(catalogQuery("caucho n° 8").grupos).toEqual([["caucho"], ["8"]]);
  });
});

describe("catalogQuery A2: unidades", () => {
  it.each([
    ["maleta 45 litros", "45"],
    ["maleta 45 litro", "45"],
    ["maleta 45 lts", "45"],
    ["maleta 45lts", "45"],
    ["maleta 45 lt", "45"],
    ["maleta 45 l", "45"],
    ["ibk 30 litros", "30"],
  ])("%s: UN solo grupo de litros", (consulta, n) => {
    const grupos = catalogQuery(consulta).grupos;
    const litros = grupos[grupos.length - 1];
    expect(litros.slice(0, 4)).toEqual([`${n}lts`, `${n} lts`, `${n} litro`, `${n}lt`]);
    // nunca el número suelto ni "litro" como término aparte
    expect(grupos.flat()).not.toContain(n);
    expect(grupos.flat()).not.toContain("litro");
  });

  it("'maleta 45 litros' -> maleta + el grupo de litros exacto", () => {
    expect(catalogQuery("maleta 45 litros").grupos).toEqual([["maleta"], ["45lts", "45 lts", "45 litro", "45lt"]]);
    expect(catalogQuery("ibk 30 litros").grupos).toEqual([["ibk"], ["30lts", "30 lts", "30 litro", "30lt"]]);
  });

  it("una 'l' suelta detrás de un número es litro, NO talla ('aceite 1 l'); suma la forma pegada '1l' (1L de Saint)", () => {
    const q = catalogQuery("aceite 1 l");
    expect(q.variantes).toEqual([]);
    expect(q.grupos).toEqual([["aceite"], ["1lts", "1 lts", "1 litro", "1lt", "1l"]]);
  });

  it("'litros' sin número no es una unidad: queda como término (y admite sinónimo)", () => {
    expect(catalogQuery("litros").grupos).toEqual([["litro"]]);
    expect(catalogQuery("litros", [{ from: "litros", to: "lts" }]).grupos).toEqual([["litro", "lts"]]);
  });

  it("pulgadas dejan SOLO el número (7PULGADAS/7PUL del catálogo lo calzan por prefijo)", () => {
    expect(catalogQuery("7 pulgadas").grupos).toEqual([["7"]]);
    expect(catalogQuery("pantalla 7 pulgadas").grupos).toEqual([["pantalla"], ["7"]]);
    expect(catalogQuery("pantalla 7 pulgada").grupos).toEqual([["pantalla"], ["7"]]);
    expect(catalogQuery("pantalla 7 pulg").grupos).toEqual([["pantalla"], ["7"]]);
    expect(catalogQuery("pantalla 7pul").grupos).toEqual([["pantalla"], ["7"]]);
    expect(catalogQuery('pantalla 7"').grupos).toEqual([["pantalla"], ["7"]]);
  });

  it("'30mm' se conserva tal cual", () => {
    expect(catalogQuery("carburador 30mm").grupos).toEqual([["carburador"], ["30mm"]]);
  });

  it("'58cm' y '58 cm' son una variante de talla, no un obligatorio", () => {
    for (const c of ["casco 58cm", "casco 58 cm"]) {
      expect(catalogQuery(c)).toMatchObject({ grupos: [["casco"]], variantes: [["58cm", "58 cm", "58"]] });
    }
  });
});

describe("catalogQuery A2: variantes y tallas", () => {
  it("'casco givi h11.7 talla xl': h11.7, givi y casco obligatorios; xl es variante", () => {
    expect(catalogQuery("casco givi h11.7 talla xl")).toMatchObject({
      grupos: [["casco"], ["givi"], ["h11.7"]],
      variantes: [["xl"]],
      opcionales: [],
    });
  });

  it("'botas talla 39' -> la talla es variante; 'talla' no queda como opcional", () => {
    expect(catalogQuery("botas talla 39")).toMatchObject({
      grupos: [["bota"]],
      variantes: [["39"]],
      opcionales: [],
    });
  });

  it("2xl<->xxl y 3xl<->xxxl", () => {
    expect(catalogQuery("chaqueta talla 2xl").variantes).toEqual([["xxl", "2xl"]]);
    expect(catalogQuery("chaqueta xxl").variantes).toEqual([["xxl", "2xl"]]);
    expect(catalogQuery("chaqueta 3xl").variantes).toEqual([["xxxl", "3xl"]]);
    expect(catalogQuery("chaqueta talla xxxl").variantes).toEqual([["xxxl", "3xl"]]);
  });

  it("las tallas sueltas s/m/l/xl cuentan si el token es exactamente ese", () => {
    expect(catalogQuery("casco xl").variantes).toEqual([["xl"]]);
    expect(catalogQuery("casco talla m").variantes).toEqual([["m"]]);
    expect(catalogQuery("casco l").variantes).toEqual([["l"]]);
    // "l" dentro de otra palabra no es talla
    expect(catalogQuery("luces led").variantes).toEqual([]);
  });

  it("una talla de 1 letra detrás de un número no es talla (m, s: no cuentan)", () => {
    expect(catalogQuery("cadena 4 m").variantes).toEqual([]);
  });

  it("colores, acabados y nombres de variante van a variantes, no a grupos", () => {
    expect(catalogQuery("tanque azul")).toMatchObject({ grupos: [["tanque"]], variantes: [["azul"]] });
    expect(catalogQuery("chaqueta edge")).toMatchObject({ grupos: [["chaqueta"]], variantes: [["edge"]] });
    for (const v of ["mate", "brillante", "cromado", "cromada", "edge", "paleta", "rayo", "tornasol"]) {
      expect(catalogQuery(`casco ${v}`)).toMatchObject({ grupos: [["casco"]], variantes: [[v]], opcionales: [] });
    }
  });

  it("no repite una variante escrita dos veces", () => {
    expect(catalogQuery("casco azul azul").variantes).toEqual([["azul"]]);
  });
});

describe("catalogQuery A2: relleno, kit/set y semitaco", () => {
  it("medida, medidas, tipo, modelo, marca, numero y pulgada son relleno (solo del catálogo)", () => {
    expect(catalogQuery("bujia medida tipo modelo marca numero pulgada medidas").grupos).toEqual([["bujia"]]);
    // searchTerms (la biblioteca) NO cambia: sigue viendo esas palabras
    expect(searchTerms("cual es la marca")).toContain("marca");
  });

  it("'kit' y 'set' son opcionales, nunca obligatorios", () => {
    expect(catalogQuery("kit arrastre")).toMatchObject({ grupos: [["arrastre"]], opcionales: [["kit"]] });
    expect(catalogQuery("set de pastillas")).toMatchObject({ grupos: [["pastilla"]], opcionales: [["set"]] });
    expect(catalogQuery("kits").grupos).toEqual([]);
  });

  it("'kit de cilindro pasador fino': kit opcional; cilindro, pasador y fino obligatorios", () => {
    expect(catalogQuery("kit de cilindro pasador fino")).toMatchObject({
      grupos: [["cilindro"], ["pasador"], ["fino"]],
      opcionales: [["kit"]],
    });
  });

  it.each(["semi taco", "semi-taco", "semitaco", "semitacos"])("'%s' es el grupo obligatorio 'semitaco'", (v) => {
    expect(catalogQuery(`caucho 90 90 19 ${v}`)).toMatchObject({
      grupos: [["caucho"], ["90"], ["19"], ["semitaco"]],
      opcionales: [],
    });
  });

  /**
   * "cros" -> "cro": el singular sigue siendo un prefijo de 3 letras. Que no
   * calce con CROMADO lo garantiza SQL (`patron_busqueda`, M1): toda
   * alternativa alfabética de 3 letras o menos calza como palabra entera.
   */
  it("'tipo de cros' deja el grupo 'cro' (la entereza la da SQL, no el parser)", () => {
    expect(catalogQuery("tipo de cros").grupos).toEqual([["cro"]]);
  });
});

describe("catalogQuery A2: años", () => {
  it("un año 1980-2035 va a `anio`, nunca a grupos", () => {
    expect(catalogQuery("un sbr 2023")).toMatchObject({ grupos: [], moto: [["sbr"]], anio: [["2023"]] });
    expect(catalogQuery("bujia 1980").anio).toEqual([["1980"]]);
    expect(catalogQuery("bujia 2035").anio).toEqual([["2035"]]);
  });

  it("fuera de 1980-2035 ya no es un año: es un número de producto", () => {
    expect(catalogQuery("bujia 1979")).toMatchObject({ grupos: [["bujia"], ["1979"]], anio: [] });
    expect(catalogQuery("bujia 2036")).toMatchObject({ grupos: [["bujia"], ["2036"]], anio: [] });
    expect(catalogQuery("motul 5100").grupos).toEqual([["motul"], ["5100"]]);
  });

  it("'rojo 2014' -> variante rojo, año 2014, ningún obligatorio (TANQUE OWEN 2014 ya no calza)", () => {
    expect(catalogQuery("rojo 2014")).toMatchObject({ grupos: [], variantes: [["rojo"]], anio: [["2014"]] });
  });

  it("un año nunca se une a letras: 'dt 2014' no arma dt2014", () => {
    const q = catalogQuery("dt 2014");
    expect(q.grupos).toEqual([]);
    expect(q.anio).toEqual([["2014"]]);
  });

  it("el año que sigue a 'año'/'ano' también es año", () => {
    expect(catalogQuery("asiento año 1975")).toMatchObject({ grupos: [["asiento"]], anio: [["1975"]] });
  });

  it("'Bera Dt 2014': la marca sola va a `moto`, el año a `anio`; 'dt' (sigla sin nombre) se descarta", () => {
    expect(catalogQuery("Bera Dt 2014")).toMatchObject({ grupos: [], moto: [["bera"]], motoMarca: [], anio: [["2014"]] });
  });

  it("'GR 2025', 'Empire GS 2026' y 'bera kavak 2025'", () => {
    expect(catalogQuery("GR 2025")).toMatchObject({ grupos: [], moto: [["gr"]], anio: [["2025"]] });
    expect(catalogQuery("Empire GS 2026")).toMatchObject({
      grupos: [],
      motoMarca: [["empire"]],
      moto: [["gs"]],
      anio: [["2026"]],
    });
    expect(catalogQuery("bera kavak 2025")).toMatchObject({
      grupos: [],
      motoMarca: [["bera"]],
      moto: [["kavak"]],
      anio: [["2025"]],
    });
  });
});

describe("catalogQuery A2: moto, marca y cilindrada", () => {
  it("con marca Y modelo, la marca va a motoMarca y el modelo a moto; con solo marca, va a moto", () => {
    expect(catalogQuery("tapas laterales milan bera")).toMatchObject({ moto: [["milan"]], motoMarca: [["bera"]] });
    expect(catalogQuery("tapas bera")).toMatchObject({ moto: [["bera"]], motoMarca: [] });
    expect(catalogQuery("bera empire")).toMatchObject({ moto: [["bera"], ["empire"]], motoMarca: [] });
  });

  it("gr250/dr650/bws150 pegados se parten en moto + cilindrada", () => {
    expect(catalogQuery("pastillas gr250")).toMatchObject({ grupos: [["pastilla"]], moto: [["gr"]], cilindrada: [["250"]] });
    expect(catalogQuery("bateria dr650")).toMatchObject({ grupos: [["bateria"]], moto: [["dr"]], cilindrada: [["650"]] });
    expect(catalogQuery("aceite bws150")).toMatchObject({ moto: [["bws"]], cilindrada: [["150"]] });
  });

  it("'dr' solo es moto si trae número: suelto (2 letras) se descarta como cualquier sigla", () => {
    expect(catalogQuery("bateria dr")).toMatchObject({ grupos: [["bateria"]], moto: [] });
    expect(catalogQuery("bateria dr 650")).toMatchObject({ moto: [["dr"]], cilindrada: [["650"]] });
    expect(catalogQuery("bateria vstrom 650")).toMatchObject({ moto: [["vstrom"]], cilindrada: [["650"]] });
  });

  it("GR de 'GRIS' no es moto: 'maleta gris' es variante, la moto va vacía", () => {
    expect(catalogQuery("maleta gris")).toMatchObject({ grupos: [["maleta"]], variantes: [["gris"]], moto: [] });
  });

  it("las motos nuevas del VPS son moto (rkv, milan, runner, aguila, rex, leon, hj, cool, bws)", () => {
    expect(catalogQuery("tanque rkv")).toMatchObject({ grupos: [["tanque"]], moto: [["rkv"]] });
    expect(catalogQuery("amortiguador md aguila")).toMatchObject({ moto: [["aguila"]], motoMarca: [["md"]] });
    expect(catalogQuery("pinon hj cool")).toMatchObject({ moto: [["cool"]], motoMarca: [["hj"]] });
  });

  it("'toro', 'new' y 'super' NO son motos: son palabras de producto", () => {
    expect(catalogQuery("new").grupos).toEqual([["new"]]);
    expect(catalogQuery("super").grupos).toEqual([["super"]]);
    expect(catalogQuery("toro").grupos).toEqual([["toro"]]);
  });

  it("'xpress' se reconoce tal cual (el singular 'xpres' lo perdía) y 'express' es alias: xpress corregida", () => {
    expect(catalogQuery("asiento xpress")).toMatchObject({ moto: [["xpress"]], motoCorregida: [] });
    expect(catalogQuery("asiento express")).toMatchObject({
      grupos: [["asiento"]],
      moto: [["xpress"]],
      motoCorregida: [{ original: "express", corregido: "xpress" }],
    });
  });

  it("una moto tipeada a distancia 1 (palabras de 5+ letras) se corrige y queda anotada: horsen -> horse", () => {
    expect(catalogQuery("tubo de escape horsen")).toMatchObject({
      grupos: [["tubo"], ["escape"]],
      moto: [["horse"]],
      motoCorregida: [{ original: "horsen", corregido: "horse" }],
    });
  });

  it("la corrección de moto NO toca palabras de producto ni marcas comerciales", () => {
    for (const q of ["aceite iphone 20w50", "casco sirius", "aceite motul", "cadena beta", "pastilla frankie"]) {
      expect(catalogQuery(q).motoCorregida).toEqual([]);
    }
    // beta (4 letras) sigue siendo moto propia, no "bera"
    expect(catalogQuery("cadena beta")).toMatchObject({ moto: [["beta"]] });
  });
});

describe("catalogQuery A2: sinónimos de varias palabras", () => {
  const sinonimos: SearchSynonym[] = [
    { from: "boca pato", to: "pico pato" },
    { from: "porta maleta", to: "base maleta" },
    { from: "kit de rodaje", to: "kit rodamiento" },
  ];

  it("'boca pato gr250': un solo grupo [frase, destino]; sus palabras no generan grupos propios", () => {
    expect(catalogQuery("boca pato gr250", sinonimos)).toMatchObject({
      grupos: [["boca pato", "pico pato"]],
      moto: [["gr"]],
      cilindrada: [["250"]],
    });
  });

  it("'porta maleta' (y con plural) calza el sinónimo", () => {
    expect(catalogQuery("porta maleta", sinonimos).grupos).toEqual([["porta maleta", "base maleta"]]);
    expect(catalogQuery("porta maletas sbr", sinonimos)).toMatchObject({
      grupos: [["porta maleta", "base maleta"]],
      moto: [["sbr"]],
    });
  });

  it("tolera el 'de' del sinónimo: 'kit de rodaje' y 'kit rodaje'; kit no queda como opcional aparte", () => {
    for (const c of ["kit de rodaje sbr", "kit rodaje sbr"]) {
      expect(catalogQuery(c, sinonimos)).toMatchObject({
        grupos: [["kit de rodaje", "kit rodamiento"]],
        opcionales: [],
        moto: [["sbr"]],
      });
    }
  });

  it("la frase tiene que aparecer SEGUIDA: separada por otra palabra no calza", () => {
    expect(catalogQuery("boca grande pato", sinonimos).grupos).toEqual([["boca"], ["grande"], ["pato"]]);
  });

  it("un sinónimo inactivo no calza", () => {
    expect(catalogQuery("boca pato", [{ from: "boca pato", to: "pico pato", isActive: false }]).grupos).toEqual([
      ["boca"],
      ["pato"],
    ]);
  });

  it("los sinónimos de una palabra siguen sumando su destino al grupo, como antes", () => {
    expect(catalogQuery("pastilla bera", [{ from: "pastilla", to: "pastillas de freno" }]).grupos).toEqual([
      ["pastilla", "pastillas de freno"],
    ]);
  });
});

describe("catalogQuery A2: gruposInfo", () => {
  it("es paralelo a grupos y marca los que vinieron tras 'de'/'con'/'para'", () => {
    const q = catalogQuery("manguera de bomba de freno delantero");
    expect(q.grupos).toEqual([["manguera"], ["bomba"], ["freno"]]);
    expect(q.opcionales).toEqual([["delantero"]]);
    expect(q.gruposInfo).toEqual([
      { trasPreposicion: false, numeroDe: null },
      { trasPreposicion: true, numeroDe: null },
      { trasPreposicion: true, numeroDe: null },
    ]);
  });

  it("'corona de 45': el 45 complementa a corona", () => {
    const q = catalogQuery("corona de 45");
    expect(q.grupos).toEqual([["corona"], ["45"]]);
    expect(q.gruposInfo).toEqual([
      { trasPreposicion: false, numeroDe: null },
      { trasPreposicion: true, numeroDe: 0 },
    ]);
  });

  it("'piñón de 14 con reborde de 11': 14 es de piñón, reborde va tras 'con', 11 es de reborde", () => {
    const q = catalogQuery("piñón de 14 con reborde de 11");
    expect(q.grupos).toEqual([["pinon"], ["14"], ["reborde"], ["11"]]);
    expect(q.gruposInfo).toEqual([
      { trasPreposicion: false, numeroDe: null },
      { trasPreposicion: true, numeroDe: 0 },
      { trasPreposicion: true, numeroDe: null },
      { trasPreposicion: true, numeroDe: 2 },
    ]);
  });

  it("un número que sigue directo a una palabra también la complementa ('caucho 21 delantero')", () => {
    const q = catalogQuery("caucho 21 delantero");
    expect(q.grupos).toEqual([["caucho"], ["21"]]);
    expect(q.gruposInfo[1]).toEqual({ trasPreposicion: false, numeroDe: 0 });
  });

  it("los índices de numeroDe apuntan al grupo FINAL, aunque haya duplicados antes", () => {
    const q = catalogQuery("bomba bomba de 12");
    expect(q.grupos).toEqual([["bomba"], ["12"]]);
    expect(q.gruposInfo[1].numeroDe).toBe(0);
    expect(q.gruposInfo).toHaveLength(q.grupos.length);
  });

  it("el largo de gruposInfo siempre iguala al de grupos", () => {
    for (const c of ["caucho 90 90 19 semi taco", "maleta 45 litros", "rin 17", "dt 200", "aceite 20w50 inca"]) {
      const q = catalogQuery(c);
      expect(q.gruposInfo).toHaveLength(q.grupos.length);
    }
  });
});

describe("catalogQuery A2: casos del VPS (2.5 y 2.6)", () => {
  it("'carburador pwk 30mm cortina plana': pwk queda obligatorio (D3 lo relaja después, con datos)", () => {
    expect(catalogQuery("carburador pwk 30mm cortina plana").grupos).toEqual([
      ["carburador"], ["pwk"], ["30mm"], ["cortina"], ["plana"],
    ]);
  });

  it("'ICH Sirius abatible 3120 negro mate'", () => {
    expect(catalogQuery("ICH Sirius abatible 3120 negro mate")).toMatchObject({
      grupos: [["ich"], ["siriu"], ["abatible"], ["3120"]],
      variantes: [["negro"], ["mate"]],
    });
  });

  it("'caucho 21 delantero' y 'caucho 18 trasero' (no regresión de la lista de cauchos)", () => {
    expect(catalogQuery("caucho 21 delantero")).toMatchObject({ grupos: [["caucho"], ["21"]], opcionales: [["delantero"]] });
    expect(catalogQuery("caucho 18 trasero")).toMatchObject({ grupos: [["caucho"], ["18"]], opcionales: [["trasero"]] });
  });

  it("'piñon 14' y 'corona de 45' calzan el número; el sufijo (45T, 14T) lo resuelve SQL", () => {
    expect(catalogQuery("piñon 14").grupos).toEqual([["pinon"], ["14"]]);
    expect(catalogQuery("corona de 45").grupos).toEqual([["corona"], ["45"]]);
  });

  it("no regresión: rolineras, aceites, botas, tanque rkv, juego de pastilla GR 250", () => {
    expect(catalogQuery("rolinera 6301").grupos).toEqual([["rolinera"], ["6301"]]);
    expect(catalogQuery("aceite 4 tiempos oilstone")).toMatchObject({ grupos: [["aceite"], ["oilstone"]], opcionales: [["4t"]] });
    // `singular` recorta "-les" de más ("impermeabl"): calza igual por prefijo en la base
    expect(catalogQuery("botas impermeables").grupos).toEqual([["bota"], ["impermeabl"]]);
    expect(catalogQuery("juego de pastilla GR 250")).toMatchObject({
      grupos: [["pastilla"]],
      opcionales: [["juego"]],
      moto: [["gr"]],
      cilindrada: [["250"]],
    });
    expect(catalogQuery("timsum de pista").grupos).toEqual([["timsum"], ["pista"]]);
  });
});

describe("motoDesdeTexto", () => {
  it("'Bera Milan' -> moto milan, marca bera", () => {
    expect(motoDesdeTexto("Bera Milan")).toEqual({
      moto: [["milan"]],
      motoMarca: [["bera"]],
      cilindrada: [],
      anio: [],
      motoCorregida: [],
    });
  });

  it("'EK horsen' -> moto horse (corregida), marca ek", () => {
    expect(motoDesdeTexto("EK horsen")).toEqual({
      moto: [["horse"]],
      motoMarca: [["ek"]],
      cilindrada: [],
      anio: [],
      motoCorregida: [{ original: "horsen", corregido: "horse" }],
    });
  });

  it("'horsen' solo se corrige a horse (marca vacía)", () => {
    expect(motoDesdeTexto("horsen")).toMatchObject({ moto: [["horse"]], motoMarca: [] });
  });

  it("'GR 250', 'GR250' y 'DT250' parten letras y cilindrada", () => {
    expect(motoDesdeTexto("GR 250")).toMatchObject({ moto: [["gr"]], cilindrada: [["250"]], anio: [] });
    expect(motoDesdeTexto("GR250")).toMatchObject({ moto: [["gr"]], cilindrada: [["250"]] });
    // dt no está en MOTOS_CONOCIDAS, pero acá todo lo que trae el modelo es moto
    expect(motoDesdeTexto("DT250")).toMatchObject({ moto: [["dt"]], cilindrada: [["250"]] });
    expect(motoDesdeTexto("BWS150")).toMatchObject({ moto: [["bws"]], cilindrada: [["150"]] });
    expect(motoDesdeTexto("DR 650")).toMatchObject({ moto: [["dr"]], cilindrada: [["650"]] });
  });

  it("'MD Aguila 2014', 'SBR 2025', 'Empire GS 2026' separan el año", () => {
    expect(motoDesdeTexto("MD Aguila 2014")).toMatchObject({ moto: [["aguila"]], motoMarca: [["md"]], anio: [["2014"]] });
    expect(motoDesdeTexto("SBR 2025")).toMatchObject({ moto: [["sbr"]], motoMarca: [], anio: [["2025"]] });
    expect(motoDesdeTexto("Empire GS 2026")).toMatchObject({ moto: [["gs"]], motoMarca: [["empire"]], anio: [["2026"]] });
  });

  it("'Bera Dt 2014': acá dt SÍ es moto (todo lo que trae el modelo lo es), la marca va aparte", () => {
    expect(motoDesdeTexto("Bera Dt 2014")).toMatchObject({ moto: [["dt"]], motoMarca: [["bera"]], anio: [["2014"]] });
  });

  it("'Toro Rex' y 'Runner 6G': lo que no está en la lista igual es moto", () => {
    expect(motoDesdeTexto("Toro Rex")).toMatchObject({ moto: [["toro"], ["rex"]], motoMarca: [] });
    expect(motoDesdeTexto("Runner 6G")).toMatchObject({ moto: [["runner"], ["6g"]], cilindrada: [] });
    expect(motoDesdeTexto("Bera New Runner")).toMatchObject({ moto: [["new"], ["runner"]], motoMarca: [["bera"]] });
  });

  it("'express' es alias de xpress; el relleno y 'moto' no cuentan; sin texto no devuelve nada", () => {
    expect(motoDesdeTexto("EK express")).toMatchObject({
      moto: [["xpress"]],
      motoMarca: [["ek"]],
      motoCorregida: [{ original: "express", corregido: "xpress" }],
    });
    expect(motoDesdeTexto("moto de la marca bera")).toMatchObject({ moto: [["bera"]] });
    expect(motoDesdeTexto("   ")).toEqual({ moto: [], motoMarca: [], cilindrada: [], anio: [], motoCorregida: [] });
  });

  it("'año 2014' y '150cc' también se entienden; no repite valores", () => {
    expect(motoDesdeTexto("sbr año 2014 150cc")).toMatchObject({ moto: [["sbr"]], anio: [["2014"]], cilindrada: [["150"]] });
    expect(motoDesdeTexto("sbr sbr")).toMatchObject({ moto: [["sbr"]] });
  });

  it("no corrige palabras cortas ni las que ya son motos ('beta' no es 'bera')", () => {
    expect(motoDesdeTexto("Beta")).toMatchObject({ moto: [["beta"]], motoCorregida: [] });
  });
});

describe("RELLENO_CATALOGO (A2, T5: el corrector lo recibe como `p_excluidos`)", () => {
  it("se exporta y trae el relleno de la búsqueda más las palabras que no describen nada en el catálogo", () => {
    for (const palabra of ["para", "con", "del", "precio", "tienen", "medida", "tipo", "modelo", "marca", "numero", "pulgada"]) {
      expect(RELLENO_CATALOGO.has(palabra), palabra).toBe(true);
    }
    // Un producto no es relleno.
    expect(RELLENO_CATALOGO.has("caucho")).toBe(false);
  });
});
