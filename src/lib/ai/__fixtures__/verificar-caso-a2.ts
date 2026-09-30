import { expect } from "vitest";
import type { CatalogOutcome } from "@/lib/ai/tools";
import type { EsperadoA2 } from "@/lib/ai/__fixtures__/casos-a2";
import { armarMensajeDeCotizacion, notaDeBusquedas } from "@/lib/ai/quote-message";
import { revealsIdentity } from "@/lib/ai/identity-guard";

// ---------------------------------------------------------------------------
// Cómo se compara lo que `buildCatalogTool` dejó en su `CatalogOutcome` con lo
// que un caso de `casos-a2.ts` espera (A2 T7, 30/9/2026). Vive AQUÍ, y no
// dentro de `tools.test.ts`, porque lo comparten dos consumidores que tienen
// que decir lo mismo: la suite normal (`tools.test.ts`, contra el simulador
// TypeScript del SQL) y el arnés (`scripts/arnes-catalogo-a2.test.ts`, contra la
// base y Redis reales). Si cada uno tuviera su copia, el día que se afine una
// aserción en uno el otro seguiría dando verde con la regla vieja.
// ---------------------------------------------------------------------------

/** Un `CatalogOutcome` en blanco, como el que `agent.ts` arma al empezar el turno. */
export function nuevoCatalogOutcome(): CatalogOutcome {
  return {
    ran: false,
    conExistencia: false,
    agotados: false,
    sinResultados: false,
    generico: false,
    cotizacion: [],
    preguntaFiltro: null,
    consultas: [],
    avisos: [],
    motivoForzado: null,
  };
}

/** Lo que la red de seguridad de `agent.ts` haría con este `CatalogOutcome`: el motivo que escala, o null si el turno solo pregunta. */
export function motivoQueEscala(outcome: CatalogOutcome): string | null {
  if (!outcome.ran) return null;
  const preguntaPendiente = outcome.generico && outcome.cotizacion.length === 0 && outcome.motivoForzado === null;
  if (preguntaPendiente) return null;
  return (
    outcome.motivoForzado ?? (outcome.conExistencia ? "confirmar_inventario" : outcome.agotados ? "sin_stock" : "no_identificado")
  );
}

function nombresDe(outcome: CatalogOutcome, producto: string | null, alternativa: boolean): string[] {
  return outcome.cotizacion
    .filter((l) => l.productoPedido === producto && (l.esAlternativa === true) === alternativa)
    .map((l) => l.nombre);
}

/**
 * Las aserciones de UN turno: un ítem esperado por búsqueda, en el orden en que
 * se hicieron (una lista = una búsqueda por producto), el motivo de escalada, la
 * nota para el asesor y que el mensaje armado se pueda armar sin delatar
 * identidad ni prometer «Hay N más» (D6).
 */
export function verificarEsperadoA2(esperado: EsperadoA2, outcome: CatalogOutcome, donde: string): void {
  expect(outcome.consultas, `${donde}: cantidad de búsquedas`).toHaveLength(esperado.items.length);

  esperado.items.forEach((item, i) => {
    const consulta = outcome.consultas[i];
    const etiqueta = `${donde} [${item.producto ?? "consulta simple"}] (${consulta.decision || consulta.resultado}; grupos ${JSON.stringify(consulta.grupos)}, relajados ${JSON.stringify(consulta.relajados)})`;

    if (item.estado !== undefined) expect(consulta.resultado, `${etiqueta}: estado`).toBe(item.estado);

    const cotizadas = nombresDe(outcome, item.producto, false);
    const alternativas = nombresDe(outcome, item.producto, true);

    if (item.debeCotizar.length > 0) {
      expect(cotizadas, `${etiqueta}: lo cotizado`).toEqual(item.debeCotizar);
    } else if (item.estado === "con_existencia") {
      // El mejor candidato es una fila de ruido del fixture: se cotiza UNA cualquiera que no esté prohibida.
      expect(cotizadas, `${etiqueta}: se cotiza UNA`).toHaveLength(1);
    } else if (item.estado === "generico" || item.estado === "sin_resultados") {
      expect(cotizadas, `${etiqueta}: no se cotiza nada`).toEqual([]);
    }

    for (const prohibido of item.nuncaCotizar) {
      expect([...cotizadas, ...alternativas], `${etiqueta}: nunca ${prohibido}`).not.toContain(prohibido);
    }

    if (item.agotadosMencionados !== undefined && alternativas.length === 0) {
      expect(cotizadas, `${etiqueta}: se nombra UN agotado`).toHaveLength(1);
      expect(item.agotadosMencionados, `${etiqueta}: el agotado nombrado`).toContain(cotizadas[0]);
      const linea = outcome.cotizacion.find((l) => l.nombre === cotizadas[0]);
      expect(linea?.stock, `${etiqueta}: está en cero`).toBe(0);
    }

    if (item.otrasOpciones !== undefined) {
      expect(alternativas, `${etiqueta}: la UNA alternativa`).toEqual(item.otrasOpciones);
      for (const nombre of alternativas) {
        expect(outcome.cotizacion.find((l) => l.nombre === nombre)?.stock, `${etiqueta}: la alternativa tiene existencia`).toBeGreaterThan(0);
      }
    }

    // Nunca un agotado junto a algo con existencia (hotfix del 29/9 / D6).
    const lineasDelItem = outcome.cotizacion.filter((l) => l.productoPedido === item.producto);
    if (lineasDelItem.some((l) => l.stock > 0)) {
      expect(lineasDelItem.every((l) => l.stock > 0), `${etiqueta}: un agotado NO va junto a algo con stock`).toBe(true);
    }

    for (const variante of item.variantesAgotadas ?? []) {
      expect(
        consulta.avisos.some((a) => a.tipo === "variante_agotada" && a.variante.includes(variante)),
        `${etiqueta}: variante agotada ${variante}`
      ).toBe(true);
    }

    const tipos = consulta.avisos.map((a) => a.tipo);
    for (const aviso of item.avisos) expect(tipos, `${etiqueta}: aviso ${aviso}`).toContain(aviso);

    if (item.relajados !== undefined) expect(consulta.relajados, `${etiqueta}: relajados`).toEqual(item.relajados);

    if (item.preguntaFiltro !== undefined && item.estado === "generico") {
      expect(outcome.preguntaFiltro, `${etiqueta}: la pregunta de filtro`).toBe(item.preguntaFiltro);
    }

    expect(consulta.corregido, `${etiqueta}: corrección`).toEqual(item.correccion);
    if (item.correccionDescartada !== undefined) {
      expect(consulta.correccionDescartada, `${etiqueta}: corrección descartada`).toEqual(item.correccionDescartada);
    }
  });

  expect(motivoQueEscala(outcome), `${donde}: motivo de escalada`).toBe(esperado.motivoEscalada);

  if (esperado.notaIncluye !== undefined) {
    const nota = notaDeBusquedas(outcome.consultas);
    for (const renglon of esperado.notaIncluye) expect(nota, `${donde}: la nota nombra «${renglon}»`).toContain(renglon);
  }

  // El mensaje que saldría (`agent.ts`) se puede armar, no delata identidad y no promete «más opciones» (D6).
  if (outcome.cotizacion.length > 0 || outcome.avisos.length > 0) {
    const { texto } = armarMensajeDeCotizacion({
      textoModelo: "",
      lineas: outcome.cotizacion,
      avisos: outcome.avisos,
      ordenProductos: outcome.consultas.find((c) => c.productos !== null)?.productos ?? undefined,
    });
    expect(texto, `${donde}: mensaje armado`).not.toBe("");
    expect(revealsIdentity(texto), `${donde}: identidad`).toBeNull();
    expect(texto, `${donde}: sin «Hay N más»`).not.toMatch(/Hay [0-9]+ opci/);
  }
}
