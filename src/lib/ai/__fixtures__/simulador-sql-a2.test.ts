import { describe, expect, it } from "vitest";
import {
  buscarProductosSim,
  claveFonetica,
  corregirTerminosSim,
  diagnosticarTerminosSim,
  levenshtein,
  patronBusqueda,
  similitud,
  type FilaSim,
} from "@/lib/ai/__fixtures__/simulador-sql-a2";

/**
 * A2 T5 (30/9/2026): el simulador es el espejo en TypeScript de `buscar_productos`
 * (M1), `corregir_terminos` (M2) y `diagnosticar_terminos` (M3), y `tools.test.ts`
 * confía en él para correr los casos del plan. Estos tests fijan que el espejo
 * reproduce lo que los tests SQL (`supabase/tests/*.sql`) fijan en la base real,
 * con los mismos ejemplos: si el simulador miente, un test de `tools.ts` pasaría
 * por una razón equivocada.
 */

const fila = (id: string, name: string, stock = 5): FilaSim => ({
  id,
  name,
  brand: null,
  price: 10,
  currency: "USD",
  stock_quantity: stock,
});

describe("patronBusqueda: los patrones de M1", () => {
  const calza = (alt: string, tipo: Parameters<typeof patronBusqueda>[1], texto: string) => patronBusqueda(alt, tipo).test(texto);

  it("la moto calza por PALABRA: 'gr' calza GR250 y 'GR 250', nunca GRIS", () => {
    expect(calza("gr", "moto", "pastilla gr250")).toBe(true);
    expect(calza("gr", "moto", "pastilla gr 250")).toBe(true);
    expect(calza("gr", "moto", "maleta 34 lts tomcat gris")).toBe(false);
  });

  it("un número que termina la alternativa: 45 calza 45T y 45LTS, no 5000; dt200 no calza DT2000", () => {
    expect(calza("45", "prod", "corona 45t bera")).toBe(true);
    expect(calza("45", "prod", "maleta 45lts plata")).toBe(true);
    expect(calza("50", "prod", "aceite motul 5000 20w50")).toBe(false);
    expect(calza("dt200", "prod", "magneto dt200 ms")).toBe(true);
    expect(calza("dt200", "prod", "magneto dt2000 ms")).toBe(false);
  });

  it("una palabra de 3 letras o menos calza como palabra ENTERA con plural: 'cro' no calza CROMADO; 'rin' calza RINES", () => {
    expect(calza("cro", "prod", "luz cruce cromado")).toBe(false);
    expect(calza("rin", "prod", "rines de aluminio")).toBe(true);
    expect(calza("rin", "prod", "orings")).toBe(false);
  });

  it("un decimal con punto acepta una letra antes: 11.7 calza H11.7", () => {
    expect(calza("11.7", "prod", "casco givi h11.7")).toBe(true);
  });

  it("el año y la cilindrada: 250 calza GR250 y '250', nunca 2500", () => {
    expect(calza("250", "cil", "pastilla gr250")).toBe(true);
    expect(calza("250", "cil", "defensa brz 250")).toBe(true);
    expect(calza("250", "cil", "correa 2500")).toBe(false);
  });

  it("'inicio' ancla al principio del nombre", () => {
    expect(calza("casco", "inicio", "casco frankie")).toBe(true);
    expect(calza("casco", "inicio", "visera casco frankie")).toBe(false);
  });
});

describe("buscarProductosSim: las columnas nuevas de M1", () => {
  const base = { p_motos_conocidas: ["sbr", "bera", "jaguar", "kavak"], p_marcas_de_moto: ["bera", "jaguar"] };

  it("nombra_otra_moto: un modelo distinto es otra moto; una marca sin modelo con el cliente de esa marca NO lo es", () => {
    const filas = [
      fila("a", "TAPA LATERAL BERA SBR"),
      fila("b", "BATERIA SECA JAGUAR/BERA"),
      fila("c", "BATERIA UNIVERSAL"),
    ];
    const r = buscarProductosSim(filas, {
      ...base,
      p_terminos: [["tapa", "bateria"]],
      p_moto: [["milan"]],
      p_moto_marca: [["bera"]],
    });
    const por = (nombre: string) => r.find((x) => x.name === nombre);
    expect(por("TAPA LATERAL BERA SBR")?.nombra_otra_moto).toBe(true);
    expect(por("BATERIA SECA JAGUAR/BERA")?.nombra_otra_moto).toBe(false);
    expect(por("BATERIA UNIVERSAL")?.es_universal).toBe(true);
  });

  it("el desempate final es la EXISTENCIA (mayor primero), no el nombre", () => {
    const filas = [fila("a", "ASIENTO A", 1), fila("b", "ASIENTO B", 9), fila("c", "ASIENTO C", 0)];
    const r = buscarProductosSim(filas, { p_terminos: [["asiento"]] });
    expect(r.map((x) => x.name)).toEqual(["ASIENTO B", "ASIENTO A", "ASIENTO C"]);
  });

  it("las ventanas se calculan ANTES del límite", () => {
    const filas = Array.from({ length: 12 }, (_, i) => fila(`f${i}`, `BOTA ${i}`, i < 10 ? 0 : 3));
    const r = buscarProductosSim(filas, { p_terminos: [["bota"]], p_limite: 3 });
    expect(r).toHaveLength(3);
    expect(r[0].filas_con_puntaje_maximo).toBe(12);
    expect(r[0].filas_con_maximo_y_stock).toBe(2);
  });

  it("las variantes exigen TODAS a la vez: filas_con_variante y filas_con_variante_y_stock", () => {
    const filas = [
      fila("a", "CASCO NEGRO MATE", 2),
      fila("b", "CASCO NEGRO BRILLANTE", 3),
      fila("c", "CASCO BLANCO MATE", 0),
    ];
    const r = buscarProductosSim(filas, { p_terminos: [["casco"]], p_variantes: [["negro"], ["mate"]] });
    expect(r[0].filas_con_variante).toBe(1);
    expect(r[0].filas_con_variante_y_stock).toBe(1);
    expect(r[0].name).toBe("CASCO NEGRO MATE");
  });

  describe("la moto solo calza entre la FAMILIA del pedido (T5b, caso 38 del test SQL)", () => {
    const motos = ["sbr", "bera", "kavak"];
    const filas = [
      // El ruido primero: una fila de OTRO producto que menciona «aceite» y nombra la SBR.
      fila("bomba", "BOMBA DE ACEITE BERA SBR", 5),
      fila("tensor", "TENSOR DE CADENA BERA SBR", 4),
      fila("a1", "ACEITE INCA 20W50 4T", 6),
      fila("a2", "ACEITE OILSTONE 4T", 9),
      fila("c1", "CADENA SBR 428H", 3),
      fila("c2", "CADENA UNIVERSAL 428H", 2),
    ];
    const args = { p_moto: [["sbr"]], p_motos_conocidas: motos, p_marcas_de_moto: ["bera"] };

    it("«aceite» + moto sbr: la moto NO calza (la bomba no empieza con el producto), la familia no depende de la moto y la bomba no va primera", () => {
      const r = buscarProductosSim(filas, { ...args, p_terminos: [["aceite"]] });
      expect(r[0].puntaje_moto_maximo).toBe(0);
      expect(r[0].filas_que_nombran_moto).toBe(0);
      // Con la moto que no calza, el conjunto es todo el máximo: la bomba sigue dentro (hotfix: nunca
      // un agotado si hay con existencia), pero no sube por nombrar la moto.
      expect(r[0].filas_con_puntaje_maximo).toBe(3);
      expect(r[0].filas_con_maximo_y_stock).toBe(3);
      expect(r.map((x) => x.name)).toEqual(["ACEITE OILSTONE 4T", "ACEITE INCA 20W50 4T", "BOMBA DE ACEITE BERA SBR"]);
    });

    it("«cadena» + moto sbr: calza con CADENA SBR (empieza con el producto) y esa va primera; el tensor no cuenta como 'nombra moto' de la familia", () => {
      const r = buscarProductosSim(filas, { ...args, p_terminos: [["cadena"]] });
      expect(r[0].puntaje_moto_maximo).toBe(1);
      expect(r[0].filas_con_maximo_y_moto).toBe(2);
      expect(r[0].filas_que_nombran_moto).toBe(1);
      expect(r[0].name).toBe("CADENA SBR 428H");
    });

    it("sin ninguna fila que empiece con el producto, la familia es todo el máximo: nada se restringe", () => {
      const r = buscarProductosSim(filas, { ...args, p_terminos: [["sbr"], ["cadena"]] });
      expect(r[0].puntaje_moto_maximo).toBe(1);
      expect(r[0].filas_que_nombran_moto).toBe(2);
    });
  });

  it("sin coincidencia por palabra (solo el prefiltro de subcadena) no devuelve nada", () => {
    expect(buscarProductosSim([fila("a", "ORINGS")], { p_terminos: [["rin"]] })).toEqual([]);
  });
});

describe("diagnosticarTerminosSim (M3)", () => {
  const filas = [fila("a", "MANGUERA FRENO DELANTERO"), fila("b", "BOMBA FRENO HORSE")];

  it("existe / co-ocurre con la cabeza: 'bomba' existe pero nunca junto a 'manguera'", () => {
    const r = diagnosticarTerminosSim(filas, [["manguera"], ["bomba"], ["pwk"]], 0);
    expect(r).toEqual([
      { grupo_idx: 0, en_catalogo: true, con_cabeza: true },
      { grupo_idx: 1, en_catalogo: true, con_cabeza: false },
      { grupo_idx: 2, en_catalogo: false, con_cabeza: false },
    ]);
  });

  it("sin cabeza (o fuera de rango) `con_cabeza` es null", () => {
    expect(diagnosticarTerminosSim(filas, [["manguera"]], null)[0].con_cabeza).toBeNull();
    expect(diagnosticarTerminosSim(filas, [["manguera"]], 7)[0].con_cabeza).toBeNull();
  });
});

describe("corregirTerminosSim (M2): la tabla del plan", () => {
  const catalogo = [
    "ACEITE IPONE 20W50",
    "SIRIUS CASCO",
    "CAUCHO TIMSUN",
    "RIN HORSE RAYO",
    "CIGUEÑAL HORSE",
    "GUARDAFANGO HORSE",
    "INTERCOMUNICADOR PARA CASCO",
    "LIGA FRENO LATA",
    "COMPRESOR AIRE",
    "FRENO DELANTERO",
    "BOTAS CUERO",
    "HONDA CBF",
  ].map((n, i) => fila(`p${i}`, n));
  const corregir = (t: string[], protegidos: string[] = [], marcas: string[] = ["ipone", "timsun", "honda"], excluidos: string[] = ["para", "medida"]) =>
    corregirTerminosSim(catalogo, t, protegidos, marcas, excluidos);

  it("se corrigen: iphone→ipone (una tecla), ciguañal→cigueñal, tisum→timsun (marca), rallo→rayo (suena igual)", () => {
    expect(corregir(["iphone"])).toEqual([{ original: "iphone", corregido: "ipone" }]);
    expect(corregir(["ciguañal"])).toEqual([{ original: "ciguañal", corregido: "cigueñal".normalize("NFD").replace(/[̀-ͯ]/g, "") }]);
    expect(corregir(["tisum"])).toEqual([{ original: "tisum", corregido: "timsun" }]);
    expect(corregir(["rallo"])).toEqual([{ original: "rallo", corregido: "rayo" }]);
  });

  it("no se corrigen: prefijo (siriu), relleno (medida), protegidas (beta), plural/singular, palabras que solo se parecen", () => {
    expect(corregir(["siriu"])).toEqual([]);
    expect(corregir(["medida"])).toEqual([]);
    expect(corregir(["pareja"])).toEqual([]);
    expect(corregir(["llanta"])).toEqual([]);
    expect(corregir(["frente"])).toEqual([]);
    expect(corregir(["compresion"])).toEqual([]);
    expect(corregir(["bota"])).toEqual([]);
    expect(corregir(["beta"], ["beta"])).toEqual([]);
  });

  it("kenda→honda solo existe si HONDA viaja como marca (T5b: `tools.ts` ya no pasa las motos en p_marcas)", () => {
    // Con una moto en `p_marcas` el SQL la propone a distancia 2: esa era la fuga.
    expect(corregir(["kenda"])).toEqual([{ original: "kenda", corregido: "honda" }]);
    // Con solo marcas de producto (lo que `tools.ts` pasa hoy) no hay corrección.
    expect(corregir(["kenda"], [], ["ipone", "timsun"])).toEqual([]);
  });

  it("un término repetido cuenta una sola vez", () => {
    expect(corregir(["iphone", "iphone"])).toEqual([{ original: "iphone", corregido: "ipone" }]);
  });
});

describe("helpers de M2", () => {
  it("claveFonetica: rallo=rayo, vicera=visera, iphone=ipone; dama≠gama, pareja≠para", () => {
    expect(claveFonetica("rallo")).toBe(claveFonetica("rayo"));
    expect(claveFonetica("vicera")).toBe(claveFonetica("visera"));
    expect(claveFonetica("iphone")).toBe(claveFonetica("ipone"));
    expect(claveFonetica("dama")).not.toBe(claveFonetica("gama"));
    expect(claveFonetica("pareja")).not.toBe(claveFonetica("para"));
  });

  it("levenshtein y similitud de trigramas", () => {
    expect(levenshtein("iphone", "ipone")).toBe(1);
    expect(levenshtein("tisum", "timsun")).toBe(2);
    expect(levenshtein("igual", "igual")).toBe(0);
    expect(similitud("timsun", "timsun")).toBe(1);
    expect(similitud("timsun", "zzzzzz")).toBe(0);
  });
});
