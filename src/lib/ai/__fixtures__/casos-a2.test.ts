import { describe, expect, it } from "vitest";
import { CATALOGO_A2, PREFIJO_CODIGO_A2 } from "@/lib/ai/__fixtures__/catalogo-a2";
import { CASOS_A2, SECCIONES_A2, type CasoA2, type EsperadoA2 } from "@/lib/ai/__fixtures__/casos-a2";
import { armarSqlBorrado, armarSqlCarga } from "../../../../scripts/fixture-a2-sql";

/**
 * Coherencia de los DATOS de la Entrega A2 (30/9/2026, plan "Seba no cotiza lo
 * que no es", T1): este archivo no prueba ninguna lógica de búsqueda -- eso es
 * de T2..T5 y del arnés (T7) --, solo que el catálogo de prueba y los casos
 * que lo consumen no se contradicen. Un nombre mal escrito en `debeCotizar`
 * haría que el arnés "pase" o "falle" por una razón que no tiene nada que ver
 * con la búsqueda.
 */

const nombres = new Set(CATALOGO_A2.map((p) => p.nombre));
const indicePorNombre = new Map(CATALOGO_A2.map((p, i) => [p.nombre, i]));

/** Todas las listas de nombres que un `EsperadoA2` cita, con su etiqueta. */
function nombresCitados(esperado: EsperadoA2) {
  return esperado.items.flatMap((item) => [
    ...item.debeCotizar.map((nombre) => ({ campo: "debeCotizar", nombre })),
    ...item.nuncaCotizar.map((nombre) => ({ campo: "nuncaCotizar", nombre })),
    ...(item.agotadosMencionados ?? []).map((nombre) => ({ campo: "agotadosMencionados", nombre })),
    ...(item.otrasOpciones ?? []).map((nombre) => ({ campo: "otrasOpciones", nombre })),
  ]);
}

function esperadosDe(caso: CasoA2): EsperadoA2[] {
  return [caso.esperado, ...(caso.turnoPrevio ? [caso.turnoPrevio.esperado] : [])];
}

describe("catalogo-a2: el catálogo de prueba", () => {
  it("tiene códigos A2FIX-#### únicos y nombres únicos", () => {
    const codigos = CATALOGO_A2.map((p) => p.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const codigo of codigos) expect(codigo).toMatch(new RegExp(`^${PREFIJO_CODIGO_A2}[0-9]{4}$`));

    const nombresLista = CATALOGO_A2.map((p) => p.nombre);
    expect(new Set(nombresLista).size).toBe(nombresLista.length);
  });

  it("tiene el ruido PRIMERO: ninguna fila `correcto` va antes de una fila `ruido`", () => {
    const ultimoRuido = CATALOGO_A2.map((p) => p.rol).lastIndexOf("ruido");
    const primerCorrecto = CATALOGO_A2.map((p) => p.rol).indexOf("correcto");
    expect(ultimoRuido).toBeGreaterThan(-1);
    expect(primerCorrecto).toBeGreaterThan(ultimoRuido);
  });

  it("los precios en Bs son positivos y todos en VES (`buscar_productos` exige price > 0)", () => {
    for (const p of CATALOGO_A2) {
      expect(p.precioBs).toBeGreaterThan(0);
      expect(p.currency).toBe("VES");
      expect(p.stock).toBeGreaterThanOrEqual(0);
    }
  });

  it("nombra en MAYÚSCULAS, como Saint (salvo las letras que no tienen mayúscula)", () => {
    for (const p of CATALOGO_A2) expect(p.nombre).toBe(p.nombre.toUpperCase());
  });

  describe("trae el ruido que hoy tapa a los correctos (por familia)", () => {
    const cuenta = (patron: RegExp, conStock = false) =>
      CATALOGO_A2.filter((p) => patron.test(p.nombre) && (!conStock || p.stock > 0)).length;

    it("defensas, parrillas, amortiguadores, baterías y tacómetros de otras motos", () => {
      for (const moto of ["BRZ", "KAVAK", "KLR", "VSTROM", "DR650"]) {
        expect(cuenta(new RegExp(`^DEFENSA .*${moto}`))).toBeGreaterThan(0);
      }
      for (const moto of ["BRZ", "KLR", "VSTROM"]) expect(cuenta(new RegExp(`^PARRILLA .*${moto}`))).toBeGreaterThan(0);
      for (const moto of ["BERA SOCIALISTA", "BWS150"]) {
        expect(cuenta(new RegExp(`^AMORTIGUADOR .*${moto}`))).toBeGreaterThan(0);
      }
      for (const moto of ["VSTROM", "DR650", "GY6", "JAGUAR/BERA"]) {
        expect(cuenta(new RegExp(`^BATERIA .*${moto}`))).toBeGreaterThan(0);
      }
      for (const moto of ["GR250", "KAVAK", "OWEN", "BERA SBR"]) {
        expect(cuenta(new RegExp(`^TACOMETRO .*${moto}`))).toBeGreaterThan(0);
      }
    });

    it("al menos 15 maletas con stock, y la MALETA REDONDA 34 LTS TOMCAT GRIS", () => {
      expect(cuenta(/^MALETA /, true)).toBeGreaterThanOrEqual(15);
      expect(nombres.has("MALETA REDONDA 34 LTS TOMCAT GRIS")).toBe(true);
    });

    it("tanques: OWEN 2014 azul, SBR rojo/blanco con stock y azul/gris en 0, EK XPRESS II 2024 azul", () => {
      const stock = (nombre: string) => CATALOGO_A2.find((p) => p.nombre === nombre)?.stock;
      expect(stock("TANQUE OWEN 2014 AZUL")).toBeGreaterThan(0);
      expect(stock("TANQUE EK XPRESS II 2024 AZUL")).toBeGreaterThan(0);
      expect(stock("TANQUE SBR ROJO")).toBeGreaterThan(0);
      expect(stock("TANQUE SBR BLANCO")).toBeGreaterThan(0);
      for (const n of ["TANQUE SBR AZUL", "TANQUE SBR 2024 AZUL", "TANQUE SBR GRIS", "TANQUE SBR 2024 GRIS"]) {
        expect(stock(n)).toBe(0);
      }
    });

    it("cauchos: 120/70 con stock, 130/70-12 en 0, rin 10 de scooter, más de 3 cauchos y tripas 18 con stock", () => {
      expect(cuenta(/^CAUCHO 1[0-9] 120\/70/, true)).toBeGreaterThan(0);
      const c13070 = CATALOGO_A2.filter((p) => /^CAUCHO 12 130\/70/.test(p.nombre));
      expect(c13070.length).toBeGreaterThanOrEqual(2);
      expect(c13070.every((p) => p.stock === 0)).toBe(true);
      expect(cuenta(/^CAUCHO .*10 .*SCOOTER/, true)).toBeGreaterThan(0);
      expect(cuenta(/^CAUCHO 18 /, true)).toBeGreaterThan(3);
      expect(cuenta(/^TRIPA 18 /, true)).toBeGreaterThan(3);
    });

    it("más de 3 aceites con stock, con el aditivo de metales y el de bastones", () => {
      expect(cuenta(/^ACEITE /, true)).toBeGreaterThan(3);
      expect(nombres.has("ACEITE ADITIVO TRATAMIENTO METALES SENFI")).toBe(true);
      expect(CATALOGO_A2.some((p) => /^ACEITE .*BASTONES/.test(p.nombre) && p.stock > 0)).toBe(true);
    });

    it("rodamientos (BERA 38T y KLR) y las tres rolineras 6301/6302/6202", () => {
      expect(nombres.has("KIT RODAMIENTO BERA 38T")).toBe(true);
      expect(CATALOGO_A2.some((p) => /^KIT RODAMIENTO KLR/.test(p.nombre))).toBe(true);
      for (const medida of ["6301", "6302", "6202"]) {
        expect(CATALOGO_A2.filter((p) => p.nombre.startsWith(`ROLINERA ${medida}`)).length).toBe(1);
      }
    });

    it("al menos 6 ASIENTO SBR con existencias distintas (incluye «ASIENTO SBR /SOC ORIGINAL»)", () => {
      const asientos = CATALOGO_A2.filter((p) => /^ASIENTO SBR /.test(p.nombre) && p.stock > 0);
      expect(asientos.length).toBeGreaterThanOrEqual(6);
      expect(new Set(asientos.map((p) => p.stock)).size).toBe(asientos.length);
      expect(nombres.has("ASIENTO SBR /SOC ORIGINAL")).toBe(true);
    });

    it("7 rines con paleta y un único RIN TRASERO EK XPRESS PALETA (19 u.)", () => {
      expect(cuenta(/^RIN .*PALETA/)).toBe(7);
      const ek = CATALOGO_A2.filter((p) => p.nombre === "RIN TRASERO EK XPRESS PALETA");
      expect(ek).toHaveLength(1);
      expect(ek[0].stock).toBe(19);
    });

    it("10 chaquetas, 2 de ellas EDGE en 0", () => {
      const chaquetas = CATALOGO_A2.filter((p) => /^CHAQUETA /.test(p.nombre));
      expect(chaquetas).toHaveLength(10);
      const edge = chaquetas.filter((p) => p.nombre.includes("EDGE"));
      expect(edge).toHaveLength(2);
      expect(edge.every((p) => p.stock === 0)).toBe(true);
    });

    it("intercomunicadores: 3 «PARA CASCO» en 0, 5 con stock y EJEAS V7 PRO con 8 u.", () => {
      const paraCasco = CATALOGO_A2.filter((p) => /^INTERCOMUNICADOR PARA CASCO/.test(p.nombre));
      expect(paraCasco).toHaveLength(3);
      expect(paraCasco.every((p) => p.stock === 0)).toBe(true);
      expect(cuenta(/^INTERCOMUNICADOR /, true)).toBe(5);
      expect(CATALOGO_A2.find((p) => p.nombre === "INTERCOMUNICADOR EJEAS V7 PRO")?.stock).toBe(8);
    });

    it("coronas y piñones: 5 CORONA 45T con stock, piñones 14T y 17T, CORONA 36T HORSE con 200", () => {
      expect(cuenta(/^CORONA 45T /, true)).toBe(5);
      expect(cuenta(/^PIÑON 14T /)).toBeGreaterThan(0);
      expect(cuenta(/^PIÑON 17T /)).toBeGreaterThan(0);
      expect(CATALOGO_A2.find((p) => p.nombre === "CORONA 36T HORSE")?.stock).toBe(200);
    });

    it("los aceites del caso de no regresión, MOTUL 5000 vs 5100, y DT2000 para probar dt200", () => {
      for (const n of [
        "ACEITE INCA 20W50 4T",
        "ACEITE OILSTONE 4T 20W50 1L",
        "ACEITE IPONE 20W50 4T",
        "ACEITE MOTUL 5100 15W50 4T",
        "ACEITE MOTUL 5100 20W50 4T",
        "ACEITE MOTUL 5000 20W50 4T",
        "MAGNETO DT200 MS",
        "MAGNETO DT2000 MS",
        "CASCO GIVI H11.7",
        "VISERA CASCO FRANKIE",
        "LIGA FRENO LATA",
        "LUZ CRUCE CROMADO",
        "DEFENSA BRZ 250",
      ]) {
        expect(nombres.has(n), n).toBe(true);
      }
    });
  });
});

describe("casos-a2: los casos", () => {
  it("cada `id` es único y trae descripción", () => {
    const ids = CASOS_A2.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const caso of CASOS_A2) expect(caso.descripcion.length).toBeGreaterThan(5);
  });

  it("todo nombre en debeCotizar / nuncaCotizar / agotadosMencionados / otrasOpciones existe en el catálogo del fixture", () => {
    const faltan: string[] = [];
    for (const caso of CASOS_A2) {
      for (const esperado of esperadosDe(caso)) {
        for (const { campo, nombre } of nombresCitados(esperado)) {
          if (!nombres.has(nombre)) faltan.push(`${caso.id} ${campo}: ${nombre}`);
        }
      }
    }
    expect(faltan).toEqual([]);
  });

  it("lo que DEBE aparecer (cotizado, agotado mencionado, otra opción) es una fila `correcto`; nunca una `ruido`", () => {
    const mal: string[] = [];
    for (const caso of CASOS_A2) {
      for (const esperado of esperadosDe(caso)) {
        for (const { campo, nombre } of nombresCitados(esperado)) {
          if (campo === "nuncaCotizar") continue;
          const fila = CATALOGO_A2[indicePorNombre.get(nombre) ?? -1];
          if (fila && fila.rol !== "correcto") mal.push(`${caso.id} ${campo}: ${nombre} es ruido`);
        }
      }
    }
    expect(mal).toEqual([]);
  });

  it("dentro de un mismo ítem, ningún nombre está a la vez en «debe» y en «nunca»", () => {
    for (const caso of CASOS_A2) {
      for (const esperado of esperadosDe(caso)) {
        for (const item of esperado.items) {
          const debe = new Set([...item.debeCotizar, ...(item.agotadosMencionados ?? []), ...(item.otrasOpciones ?? [])]);
          const cruce = item.nuncaCotizar.filter((n) => debe.has(n));
          expect(cruce, caso.id).toEqual([]);
        }
      }
    }
  });

  it("el ruido citado en `nuncaCotizar` va antes que las filas correctas del mismo caso", () => {
    // El motivo de fondo de la regla del 26/9/2026: un test de orden tiene que
    // partir de datos que YA estén en el orden equivocado.
    for (const caso of CASOS_A2) {
      for (const esperado of esperadosDe(caso)) {
        for (const item of esperado.items) {
          const ruido = item.nuncaCotizar
            .map((n) => CATALOGO_A2[indicePorNombre.get(n) ?? -1])
            .filter((fila) => fila?.rol === "ruido")
            .map((fila) => indicePorNombre.get(fila.nombre) as number);
          const correctos = [...item.debeCotizar, ...(item.agotadosMencionados ?? []), ...(item.otrasOpciones ?? [])]
            .map((n) => indicePorNombre.get(n))
            .filter((i): i is number => i !== undefined);
          if (ruido.length === 0 || correctos.length === 0) continue;
          expect(Math.max(...ruido), caso.id).toBeLessThan(Math.min(...correctos));
        }
      }
    }
  });

  it("existe al menos un caso por cada sección del documento de casos del VPS", () => {
    const secciones = new Set(CASOS_A2.map((c) => c.seccion));
    for (const seccion of SECCIONES_A2) expect(secciones.has(seccion), seccion).toBe(true);
    for (const seccion of secciones) expect(SECCIONES_A2).toContain(seccion);
  });

  it("la sección `corrector` cubre la tabla de la sección 4.3 del plan", () => {
    const queries = CASOS_A2.filter((c) => c.seccion === "corrector").map((c) => c.llamada.query.toLowerCase());
    for (const termino of [
      "horsen", "iphone", "motopower", "ciguañal", "tisum", "stinsun", "swhera", "rallo", "siriu",
      "frente", "compresion", "alante", "numero", "relacion", "medida", "guarda", "diente", "brazo", "manga",
      "bidon", "bota", "proteccion",
    ]) {
      const cubierto = queries.some((q) => q.includes(termino)) || CASOS_A2.some((c) => c.llamada.motoModel === termino);
      expect(cubierto, termino).toBe(true);
    }
  });

  it("todo caso de la sección `corrector` declara qué corrección espera (o `null`)", () => {
    for (const caso of CASOS_A2.filter((c) => c.seccion === "corrector")) {
      for (const item of caso.esperado.items) expect(item.correccion === null || Array.isArray(item.correccion)).toBe(true);
    }
  });

  it("un caso `cambioDeliberado` explica el porqué", () => {
    const deliberados = CASOS_A2.filter((c) => c.cambioDeliberado !== undefined);
    expect(deliberados.length).toBeGreaterThan(0);
    for (const caso of deliberados) expect(caso.cambioDeliberado?.length).toBeGreaterThan(20);
  });

  it("una conversación de dos turnos declara qué memoria deja el primer turno", () => {
    const dosTurnos = CASOS_A2.filter((c) => c.turnoPrevio !== undefined);
    expect(dosTurnos.length).toBeGreaterThan(5);
    for (const caso of dosTurnos) {
      expect(caso.turnoPrevio?.memoria).toBeDefined();
      // Un primer turno que solo pregunta no escala; uno que ya cotizó o agotó sí.
      const previo = caso.turnoPrevio?.esperado;
      if (previo?.items.every((i) => i.estado === "generico")) expect(previo.motivoEscalada, caso.id).toBeNull();
    }
  });

  it("un estado sin resultados o un genérico nunca declara productos que deban cotizarse", () => {
    for (const caso of CASOS_A2) {
      for (const item of caso.esperado.items) {
        if (item.estado === "sin_resultados" || item.estado === "generico") expect(item.debeCotizar, caso.id).toEqual([]);
      }
    }
  });

  // D6 (29/9/2026, noche): se cotiza UNA opción en todos los casos; la ÚNICA
  // excepción es el pedido explícito de ver opciones (`ver-opciones-*`), que da
  // hasta tres. La alternativa de D2 también es UNA.
  it("D6: ningún ítem declara más de UNA fila cotizada ni más de UNA alternativa (salvo `ver-opciones-*`, hasta tres)", () => {
    for (const caso of CASOS_A2) {
      const tope = caso.id.startsWith("ver-opciones-") ? 3 : 1;
      for (const esperado of esperadosDe(caso)) {
        for (const item of esperado.items) {
          expect(item.debeCotizar.length, `${caso.id} debeCotizar`).toBeLessThanOrEqual(tope);
          expect(item.otrasOpciones?.length ?? 0, `${caso.id} otrasOpciones`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("D6: los casos `ver-opciones-*` existen y piden exactamente tres", () => {
    const casos = CASOS_A2.filter((c) => c.id.startsWith("ver-opciones-"));
    expect(casos.length).toBeGreaterThanOrEqual(4);
    for (const caso of casos) expect(caso.esperado.items[0].debeCotizar, caso.id).toHaveLength(3);
  });

  it("D2: un caso con `variante_agotada` y alternativa declara la variante que se dice agotada y UNA alternativa", () => {
    const conAlternativa = CASOS_A2.filter((c) => (c.esperado.items[0].otrasOpciones?.length ?? 0) > 0);
    expect(conAlternativa.length).toBeGreaterThanOrEqual(4);
    for (const caso of conAlternativa) {
      const item = caso.esperado.items[0];
      expect(item.avisos, caso.id).toContain("variante_agotada");
      expect(item.variantesAgotadas?.length ?? 0, caso.id).toBeGreaterThan(0);
      expect(item.otrasOpciones, caso.id).toHaveLength(1);
    }
  });

  it("el motivo de escalada es coherente con lo que se cotiza", () => {
    for (const caso of CASOS_A2) {
      const { items, motivoEscalada } = caso.esperado;
      const algunoConExistencia = items.some((i) => i.estado === "con_existencia");
      if (algunoConExistencia) expect(motivoEscalada, caso.id).toBe("confirmar_inventario");
      if (motivoEscalada === "sin_stock") expect(algunoConExistencia, caso.id).toBe(false);
    }
  });
});

describe("fixture-a2-sql: el SQL que se genera", () => {
  it("la carga trae un INSERT por producto, con el ruido primero y sin `saint_code` (el cron de Saint no lo toca)", () => {
    const sql = armarSqlCarga(CATALOGO_A2);
    expect(sql).toContain("insert into public.products");
    for (const p of CATALOGO_A2) expect(sql).toContain(p.codigo);
    expect(sql).not.toMatch(/saint_code/);
    // el ruido va antes: el primer código del SQL es el A2FIX-0001, el último el del último producto
    expect(sql.indexOf(CATALOGO_A2[0].codigo)).toBeLessThan(sql.indexOf(CATALOGO_A2[CATALOGO_A2.length - 1].codigo));
    // borra una carga anterior en el mismo archivo (idempotente) y no abre transacción propia (`psql -1` la abre)
    expect(sql).toMatch(/delete from public\.products where description like 'A2FIX-%'/);
    expect(sql).not.toMatch(/^\s*(begin|commit);/im);
  });

  it("escapa los apóstrofos de los nombres", () => {
    const sql = armarSqlCarga([
      { ...CATALOGO_A2[0], codigo: "A2FIX-9999", nombre: "PRUEBA D'ACCORD" },
    ]);
    expect(sql).toContain("'PRUEBA D''ACCORD'");
  });

  it("el borrado solo toca las filas del fixture", () => {
    const sql = armarSqlBorrado();
    expect(sql).toMatch(/delete from public\.products where description like 'A2FIX-%'/);
    expect(sql).not.toMatch(/truncate/i);
  });
});
