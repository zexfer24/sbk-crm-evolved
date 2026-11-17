import { describe, expect, it } from "vitest";
import {
  DESTINOS,
  ERROR_TIPOS,
  SUGGESTION_TTL_MINUTES,
  guardNames,
  matchesShadowFilters,
  shadowDraftFromRow,
  shadowReviewFromRow,
  shadowStats,
  suggestionExpired,
  suggestionSendable,
  suggestionTexts,
  suggestionVisible,
  EMPTY_SHADOW_FILTERS,
  validateShadowReview,
  CORRECCION_MAX,
  EJE_LABELS,
  MINIMO_DE_REVISIONES,
  UMBRAL_DE_PREPARACION,
  medirPreparacion,
  proyectarConsumo,
  sombraResumenFromRow,
  type EjeDePreparacion,
  type ShadowDraft,
  type SombraResumen,
  type ShadowFilters,
  type ShadowReview,
} from "@/lib/shadow";

const T0 = "2026-11-17T15:00:00.000Z";
const MIN = 60_000;

function draft(overrides: Partial<ShadowDraft> = {}): ShadowDraft {
  return {
    id: "d1",
    conversationId: "c1",
    modo: "copiloto",
    triggerMessageId: "m1",
    rafaga: ["Hola, ¿tienen pastillas?"],
    mensajes: [{ orden: 1, tipo: "texto", texto: "Claro, ¿para qué moto?", origen: "modelo", mediaUrl: null }],
    herramientas: [],
    productos: [],
    escalaria: false,
    motivo: null,
    area: null,
    nota: null,
    guardas: [],
    model: "gpt-x",
    inputTokens: 100,
    outputTokens: 20,
    llamadas: 2,
    durationMs: 3000,
    sugerenciaEstado: "pendiente",
    sugerenciaResueltaPor: null,
    sugerenciaResueltaAt: null,
    createdAt: T0,
    ...overrides,
  };
}

function review(draftId: string, veredicto: ShadowReview["veredicto"]): ShadowReview {
  return { draftId, veredicto, errorTipo: null, correccion: null, destino: null, reviewedBy: "a1", reviewedAt: T0 };
}

describe("SUGGESTION_TTL_MINUTES", () => {
  it("son diez minutos (literal, no el símbolo)", () => {
    expect(SUGGESTION_TTL_MINUTES).toBe(10);
  });
});

describe("suggestionVisible", () => {
  const at = (ms: number) => new Date(new Date(T0).getTime() + ms);

  it("a los 9 min 59 s sigue visible", () => {
    expect(suggestionVisible(draft(), { now: at(10 * MIN - 1000), lastAgentMessageAt: null })).toBe(true);
  });

  it("a los 10 min exactos ya no", () => {
    expect(suggestionVisible(draft(), { now: at(10 * MIN), lastAgentMessageAt: null })).toBe(false);
  });

  it("un mensaje de asesor posterior al borrador la oculta", () => {
    const despues = new Date(new Date(T0).getTime() + 1000).toISOString();
    expect(suggestionVisible(draft(), { now: at(2 * MIN), lastAgentMessageAt: despues })).toBe(false);
  });

  it("un mensaje de asesor ANTERIOR al borrador no la oculta", () => {
    const antes = new Date(new Date(T0).getTime() - 60_000).toISOString();
    expect(suggestionVisible(draft(), { now: at(2 * MIN), lastAgentMessageAt: antes })).toBe(true);
  });

  it.each(["enviada", "editada", "descartada", "vencida", null] as const)("con estado %s no se muestra", (estado) => {
    expect(suggestionVisible(draft({ sugerenciaEstado: estado }), { now: at(MIN), lastAgentMessageAt: null })).toBe(false);
  });

  it("un borrador en modo sombra nunca se muestra", () => {
    expect(suggestionVisible(draft({ modo: "sombra" }), { now: at(MIN), lastAgentMessageAt: null })).toBe(false);
  });
});

describe("suggestionExpired", () => {
  const at = (ms: number) => new Date(new Date(T0).getTime() + ms);

  it("pendiente con menos de 10 min y sin mensaje de asesor: no venció", () => {
    expect(suggestionExpired(draft(), { now: at(10 * MIN - 1000), lastAgentMessageAt: null })).toBe(false);
  });

  it("pendiente que cumplió 10 min: venció", () => {
    expect(suggestionExpired(draft(), { now: at(10 * MIN), lastAgentMessageAt: null })).toBe(true);
  });

  it("pendiente que quedó detrás de un mensaje del asesor: venció aunque sea joven", () => {
    const despues = new Date(new Date(T0).getTime() + 1000).toISOString();
    expect(suggestionExpired(draft(), { now: at(MIN), lastAgentMessageAt: despues })).toBe(true);
  });

  it("una ya resuelta no vence otra vez", () => {
    expect(suggestionExpired(draft({ sugerenciaEstado: "enviada" }), { now: at(20 * MIN), lastAgentMessageAt: null })).toBe(false);
  });
});

describe("suggestionTexts / suggestionSendable", () => {
  it("devuelve los textos en orden, sin vacíos", () => {
    const d = draft({
      mensajes: [
        { orden: 2, tipo: "texto", texto: "segundo", origen: "fijo", mediaUrl: null },
        { orden: 1, tipo: "texto", texto: "primero", origen: "modelo", mediaUrl: null },
        { orden: 3, tipo: "texto", texto: "   ", origen: "modelo", mediaUrl: null },
      ],
    });
    expect(suggestionTexts(d)).toEqual(["primero", "segundo"]);
  });

  it("una imagen con pie aporta el pie; sin pie se omite (la foto no se reenvía)", () => {
    const d = draft({
      mensajes: [
        { orden: 1, tipo: "imagen", texto: "Así se ve", origen: "herramienta", mediaUrl: "https://x/y.jpg" },
        { orden: 2, tipo: "imagen", texto: null, origen: "herramienta", mediaUrl: "https://x/z.jpg" },
      ],
    });
    expect(suggestionTexts(d)).toEqual(["Así se ve"]);
  });

  it("se puede enviar con al menos un texto y sin pase", () => {
    expect(suggestionSendable(draft())).toBe(true);
  });

  it("un pase a asesor no se envía", () => {
    expect(suggestionSendable(draft({ escalaria: true, area: "pagos" }))).toBe(false);
  });

  it("sin ningún texto no se puede enviar", () => {
    expect(suggestionSendable(draft({ mensajes: [] }))).toBe(false);
    expect(
      suggestionSendable(
        draft({ mensajes: [{ orden: 1, tipo: "imagen", texto: null, origen: "herramienta", mediaUrl: "u" }] })
      )
    ).toBe(false);
  });
});

describe("matchesShadowFilters", () => {
  const base: ShadowFilters = EMPTY_SHADOW_FILTERS;

  it("sin filtros pasa todo", () => {
    expect(matchesShadowFilters(draft(), null, base)).toBe(true);
  });

  it("fecha: respeta desde y hasta", () => {
    const d = draft({ createdAt: "2026-11-10T12:00:00.000Z" });
    expect(matchesShadowFilters(d, null, { ...base, desde: "2026-11-11T00:00:00.000Z" })).toBe(false);
    expect(matchesShadowFilters(d, null, { ...base, desde: "2026-11-10T00:00:00.000Z" })).toBe(true);
    expect(matchesShadowFilters(d, null, { ...base, hasta: "2026-11-10T00:00:00.000Z" })).toBe(false);
    expect(matchesShadowFilters(d, null, { ...base, hasta: "2026-11-11T00:00:00.000Z" })).toBe(true);
  });

  it("veredicto: cada valor y 'sin_revisar'", () => {
    const d = draft();
    expect(matchesShadowFilters(d, null, { ...base, veredicto: "sin_revisar" })).toBe(true);
    expect(matchesShadowFilters(d, review("d1", "igual"), { ...base, veredicto: "sin_revisar" })).toBe(false);
    expect(matchesShadowFilters(d, review("d1", "igual"), { ...base, veredicto: "igual" })).toBe(true);
    expect(matchesShadowFilters(d, review("d1", "no"), { ...base, veredicto: "igual" })).toBe(false);
    expect(matchesShadowFilters(d, null, { ...base, veredicto: "no" })).toBe(false);
    expect(matchesShadowFilters(d, review("d1", "cambio_menor"), { ...base, veredicto: "cambio_menor" })).toBe(true);
  });

  it("escalaria: sí / no", () => {
    expect(matchesShadowFilters(draft({ escalaria: true }), null, { ...base, escalaria: "si" })).toBe(true);
    expect(matchesShadowFilters(draft({ escalaria: false }), null, { ...base, escalaria: "si" })).toBe(false);
    expect(matchesShadowFilters(draft({ escalaria: false }), null, { ...base, escalaria: "no" })).toBe(true);
    expect(matchesShadowFilters(draft({ escalaria: true }), null, { ...base, escalaria: "no" })).toBe(false);
  });

  it("área", () => {
    expect(matchesShadowFilters(draft({ area: "pagos" }), null, { ...base, area: "pagos" })).toBe(true);
    expect(matchesShadowFilters(draft({ area: "ventas" }), null, { ...base, area: "pagos" })).toBe(false);
    expect(matchesShadowFilters(draft({ area: null }), null, { ...base, area: "pagos" })).toBe(false);
  });

  it("guarda disparada", () => {
    const d = draft({ guardas: [{ guarda: "identidad", fragmento: "soy un bot" }] });
    expect(matchesShadowFilters(d, null, { ...base, guarda: "identidad" })).toBe(true);
    expect(matchesShadowFilters(d, null, { ...base, guarda: "precio" })).toBe(false);
    expect(matchesShadowFilters(draft(), null, { ...base, guarda: "identidad" })).toBe(false);
  });
});

describe("guardNames", () => {
  it("junta los nombres distintos, ordenados", () => {
    const a = draft({ guardas: [{ guarda: "precio", fragmento: "" }, { guarda: "identidad", fragmento: "" }] });
    const b = draft({ id: "d2", guardas: [{ guarda: "precio", fragmento: "" }] });
    expect(guardNames([a, b])).toEqual(["identidad", "precio"]);
  });
});

describe("shadowStats", () => {
  it("sin revisados el porcentaje es null (se pinta «—», nunca 0)", () => {
    const stats = shadowStats([draft()], []);
    expect(stats.borradores).toBe(1);
    expect(stats.revisados).toBe(0);
    expect(stats.aprobacionPct).toBeNull();
  });

  it("el porcentaje cuenta «igual» y «cambio menor» sobre los revisados", () => {
    const drafts = [draft({ id: "a" }), draft({ id: "b" }), draft({ id: "c" }), draft({ id: "d" })];
    const reviews = [review("a", "igual"), review("b", "cambio_menor"), review("c", "no")];
    const stats = shadowStats(drafts, reviews);
    expect(stats.revisados).toBe(3);
    expect(stats.aprobacionPct).toBeCloseTo(66.67, 1);
  });

  it("una revisión de un borrador fuera del período no cuenta", () => {
    const stats = shadowStats([draft({ id: "a" })], [review("a", "igual"), review("zzz", "no")]);
    expect(stats.revisados).toBe(1);
    expect(stats.aprobacionPct).toBe(100);
  });

  it("la mediana de duración ignora los null y promedia los dos del medio", () => {
    const drafts = [
      draft({ id: "a", durationMs: 1000 }),
      draft({ id: "b", durationMs: 5000 }),
      draft({ id: "c", durationMs: null }),
      draft({ id: "d", durationMs: 3000 }),
      draft({ id: "e", durationMs: 9000 }),
    ];
    expect(shadowStats(drafts, []).medianaMs).toBe(4000);
  });

  it("sin duraciones la mediana es null", () => {
    expect(shadowStats([draft({ durationMs: null })], []).medianaMs).toBeNull();
    expect(shadowStats([], []).medianaMs).toBeNull();
  });
});

describe("listas del formulario de revisión", () => {
  it("espejan EXACTO los CHECK de la migración 20261117010000", () => {
    expect(ERROR_TIPOS.map((e) => e.value)).toEqual([
      "producto_equivocado",
      "precio",
      "tono",
      "debio_pasar",
      "no_debio_pasar",
      "dato_inventado",
      "forma_de_pago",
      "otro",
    ]);
    expect(DESTINOS.map((e) => e.value)).toEqual(["leccion", "caso_de_arnes", "prompt", "ninguno"]);
  });
});

describe("mappers tolerantes", () => {
  it("un mensajes que no es arreglo da []", () => {
    const d = shadowDraftFromRow({
      id: "x",
      conversation_id: "c",
      modo: "sombra",
      rafaga: "texto suelto",
      mensajes: { raro: true },
      herramientas: null,
      guardas: 5,
      created_at: T0,
    });
    expect(d.mensajes).toEqual([]);
    expect(d.rafaga).toEqual([]);
    expect(d.herramientas).toEqual([]);
    expect(d.guardas).toEqual([]);
    expect(d.sugerenciaEstado).toBeNull();
  });

  it("mapea una fila completa", () => {
    const d = shadowDraftFromRow({
      id: "x",
      conversation_id: "c",
      modo: "copiloto",
      trigger_message_id: "m",
      rafaga: ["hola", 4, "otra"],
      mensajes: [
        { orden: 2, tipo: "texto", texto: "b", origen: "fijo" },
        { orden: 1, tipo: "imagen", texto: "pie", origen: "herramienta", mediaUrl: "u" },
        { tipo: "video", texto: "x", origen: "modelo" },
        "basura",
      ],
      herramientas: ["buscarRepuesto", { nombre: "escalarAAsesor" }, 7],
      productos: ["p1"],
      escalaria: true,
      motivo: "pago",
      area: "pagos",
      nota: "n",
      guardas: [{ guarda: "precio", fragmento: "$5" }, { sin: "forma" }],
      model: "m",
      input_tokens: 10,
      output_tokens: 5,
      llamadas: [{}, {}, {}],
      duration_ms: 2500,
      sugerencia_estado: "pendiente",
      sugerencia_resuelta_por: null,
      sugerencia_resuelta_at: null,
      created_at: T0,
    });
    expect(d.rafaga).toEqual(["hola", "otra"]);
    expect(d.mensajes.map((m) => [m.orden, m.tipo])).toEqual([
      [2, "texto"],
      [1, "imagen"],
    ]);
    expect(d.mensajes[1].mediaUrl).toBe("u");
    expect(d.herramientas).toEqual(["buscarRepuesto", "escalarAAsesor"]);
    expect(d.guardas).toEqual([{ guarda: "precio", fragmento: "$5" }]);
    expect(d.llamadas).toBe(3);
    expect(d.area).toBe("pagos");
    expect(d.durationMs).toBe(2500);
    expect(d.sugerenciaEstado).toBe("pendiente");
  });

  it("una revisión mapea sus columnas", () => {
    expect(
      shadowReviewFromRow({
        draft_id: "d",
        veredicto: "no",
        error_tipo: "precio",
        correccion: "x",
        destino: "leccion",
        reviewed_by: "a",
        reviewed_at: T0,
      })
    ).toEqual({ draftId: "d", veredicto: "no", errorTipo: "precio", correccion: "x", destino: "leccion", reviewedBy: "a", reviewedAt: T0 });
  });
});

describe("validateShadowReview", () => {
  const ok = { veredicto: "no" as const, errorTipo: "precio", correccion: "Era $12, no $15", destino: "leccion" };

  it("sin veredicto falla", () => {
    expect(validateShadowReview({ ...ok, veredicto: null }).veredicto).toBeTruthy();
  });

  it("«igual» no exige tipo de error ni corrección", () => {
    expect(validateShadowReview({ veredicto: "igual", errorTipo: "", correccion: "", destino: "" })).toEqual({});
  });

  it.each(["cambio_menor", "no"] as const)("«%s» exige tipo de error y corrección", (veredicto) => {
    const errors = validateShadowReview({ veredicto, errorTipo: "", correccion: "   ", destino: "" });
    expect(errors.errorTipo).toBeTruthy();
    expect(errors.correccion).toBeTruthy();
    expect(validateShadowReview({ ...ok, veredicto })).toEqual({});
  });

  it("la corrección no pasa de 2000 caracteres (literal)", () => {
    expect(CORRECCION_MAX).toBe(2000);
    expect(validateShadowReview({ ...ok, correccion: "x".repeat(2000) })).toEqual({});
    expect(validateShadowReview({ ...ok, correccion: "x".repeat(2001) }).correccion).toBeTruthy();
  });
});


// ---------------- Consumo y preparación para desplegar (P1, 17/11/2026) ----------------

/** El jsonb tal cual lo devuelve `sombra_resumen`, con los tres ejes a medida. */
function filaResumen(
  ejes: Partial<Record<EjeDePreparacion, [number, number, number, number]>> = {},
  consumo: Record<string, unknown> = {}
) {
  const eje = (nombre: EjeDePreparacion) => {
    const [poblacion, revisados, reprobados, cambiosMenores] = ejes[nombre] ?? [0, 0, 0, 0];
    return { eje: nombre, poblacion, revisados, reprobados, cambios_menores: cambiosMenores };
  };
  return {
    consumo: {
      dias: [
        { dia: "2026-11-17", borradores: 10, input_tokens: 1_000_000, output_tokens: 200_000, cached_input_tokens: 5, costo_usd: 3 },
        { dia: "2026-11-16", borradores: 10, input_tokens: 1_000_000, output_tokens: 200_000, cached_input_tokens: 0, costo_usd: 1 },
      ],
      total: { borradores: 20, input_tokens: 2_000_000, output_tokens: 400_000, cached_input_tokens: 5, costo_usd: 4, sin_tarifa: 0 },
      hoy_usd: 3,
      tope_usd: 5,
      muestreo_pct: 100,
      ...consumo,
    },
    preparacion: {
      ejes: [eje("busqueda"), eje("conversacion"), eje("pago")],
      senales: { total: 20, con_guardas: 2, pasarian_a_asesor: 3, sin_mensajes: 1 },
    },
  };
}

function resumen(
  ejes: Partial<Record<EjeDePreparacion, [number, number, number, number]>> = {},
  consumo: Record<string, unknown> = {}
): SombraResumen {
  const out = sombraResumenFromRow(filaResumen(ejes, consumo));
  if (!out) throw new Error("la fila de prueba debía mapear");
  return out;
}

describe("constantes de la preparación (literales)", () => {
  it("mínimos de revisiones por eje y umbral", () => {
    expect(MINIMO_DE_REVISIONES).toEqual({ busqueda: 30, conversacion: 30, pago: 10 });
    expect(UMBRAL_DE_PREPARACION).toBe(90);
    expect(EJE_LABELS).toEqual({
      busqueda: "Búsqueda de repuestos",
      conversacion: "Conversación",
      pago: "Montos y pago",
    });
  });
});

describe("sombraResumenFromRow", () => {
  it("mapea el jsonb de la RPC a camelCase", () => {
    const out = resumen({ busqueda: [40, 35, 3, 2] });
    expect(out.consumo.dias[0]).toEqual({
      dia: "2026-11-17",
      borradores: 10,
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cachedInputTokens: 5,
      costoUsd: 3,
    });
    expect(out.consumo.total).toMatchObject({ borradores: 20, costoUsd: 4, sinTarifa: 0 });
    expect(out.consumo).toMatchObject({ hoyUsd: 3, topeUsd: 5, muestreoPct: 100 });
    expect(out.preparacion.ejes.find((e) => e.eje === "busqueda")).toEqual({
      eje: "busqueda",
      poblacion: 40,
      revisados: 35,
      reprobados: 3,
      cambiosMenores: 2,
    });
    expect(out.preparacion.senales).toEqual({ total: 20, conGuardas: 2, pasarianAAsesor: 3, sinMensajes: 1 });
  });

  it("un costo null se queda null (no se vuelve 0) y los números en texto se aceptan", () => {
    const out = resumen(
      {},
      {
        dias: [{ dia: "2026-11-17", borradores: "4", input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, costo_usd: null }],
        total: { borradores: 4, input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, costo_usd: null, sin_tarifa: 4 },
        hoy_usd: null,
        tope_usd: null,
      }
    );
    expect(out.consumo.dias[0].costoUsd).toBeNull();
    expect(out.consumo.dias[0].borradores).toBe(4);
    expect(out.consumo.total.costoUsd).toBeNull();
    expect(out.consumo.hoyUsd).toBeNull();
    expect(out.consumo.topeUsd).toBeNull();
  });

  it.each([null, undefined, "x", 3, [], {}, { consumo: 1, preparacion: 2 }, { consumo: {}, preparacion: null }])(
    "un jsonb raro (%j) da null",
    (valor) => {
      expect(sombraResumenFromRow(valor)).toBeNull();
    }
  );

  it("un día o un eje mal formado se descarta sin tumbar el resto", () => {
    const fila = filaResumen({ pago: [5, 5, 0, 0] });
    (fila.consumo.dias as unknown[]).push("raro", null, { dia: 7 });
    (fila.preparacion.ejes as unknown[]).push({ eje: "inventado", poblacion: 9 });
    const out = sombraResumenFromRow(fila);
    expect(out?.consumo.dias).toHaveLength(2);
    expect(out?.preparacion.ejes).toHaveLength(3);
  });
});

describe("medirPreparacion", () => {
  const ORDEN: EjeDePreparacion[] = ["busqueda", "conversacion", "pago"];

  it("sin revisiones: el porcentaje de cada eje es null, el general también, y el motivo dice lo que falta", () => {
    const r = medirPreparacion(resumen({ busqueda: [12, 0, 0, 0], conversacion: [50, 0, 0, 0], pago: [4, 0, 0, 0] }));

    expect(r.ejes.map((e) => e.eje)).toEqual(ORDEN);
    for (const e of r.ejes) {
      expect(e.pct).toBeNull();
      expect(e.suficiente).toBe(false);
    }
    expect(r.ejes.map((e) => e.faltan)).toEqual([30, 30, 10]);
    expect(r.general).toBeNull();
    expect(r.ejeMasFlojo).toBeNull();
    expect(r.lista).toBe(false);
    expect(r.motivo).toBe("Faltan revisiones: búsqueda 0 de 30, conversación 0 de 30, pago 0 de 10");
  });

  it("el motivo cuenta lo revisado y no menciona los ejes que ya tienen su mínimo", () => {
    const r = medirPreparacion(resumen({ busqueda: [40, 12, 0, 0], conversacion: [60, 30, 1, 0], pago: [8, 3, 0, 0] }));

    expect(r.motivo).toBe("Faltan revisiones: búsqueda 12 de 30, pago 3 de 10");
    expect(r.ejes[1]).toMatchObject({ suficiente: true, faltan: 0 });
    expect(r.general).toBeNull();
  });

  it("un eje sin ninguna población (nadie pagó todavía) cuenta como no suficiente y el motivo lo dice", () => {
    const r = medirPreparacion(resumen({ busqueda: [40, 30, 0, 0], conversacion: [60, 30, 0, 0], pago: [0, 0, 0, 0] }));

    expect(r.ejes[2]).toMatchObject({ poblacion: 0, pct: null, suficiente: false, faltan: 10 });
    expect(r.general).toBeNull();
    expect(r.motivo).toBe("Faltan revisiones: pago (todavía no hubo ningún borrador con pago)");
  });

  it("el porcentaje es (revisados - reprobados) / revisados, redondeado; los cambios menores no restan", () => {
    const r = medirPreparacion(resumen({ busqueda: [50, 32, 3, 9], conversacion: [50, 30, 0, 0], pago: [20, 12, 1, 0] }));

    // (32 - 3) / 32 = 90,625 → 91
    expect(r.ejes[0].pct).toBe(91);
    expect(r.ejes[1].pct).toBe(100);
    // (12 - 1) / 12 = 91,67 → 92
    expect(r.ejes[2].pct).toBe(92);
  });

  it("con los tres ejes suficientes, el general es el MENOR de los tres (no el promedio)", () => {
    const r = medirPreparacion(resumen({ busqueda: [50, 40, 2, 0], conversacion: [50, 30, 0, 0], pago: [20, 10, 2, 0] }));

    expect(r.ejes.map((e) => e.pct)).toEqual([95, 100, 80]);
    // El promedio sería 91: el general tiene que ser 80.
    expect(r.general).toBe(80);
    expect(r.ejeMasFlojo).toBe("pago");
    expect(r.lista).toBe(false);
    expect(r.motivo).toBe("El eje más flojo es Montos y pago (80 %): todavía no llega al 90 %");
  });

  it("exactamente 90 % en los tres ejes: lista; 89 %: no lista", () => {
    const lista = medirPreparacion(resumen({ busqueda: [50, 30, 3, 0], conversacion: [50, 30, 3, 0], pago: [20, 10, 1, 0] }));
    expect(lista.ejes.map((e) => e.pct)).toEqual([90, 90, 90]);
    expect(lista.general).toBe(90);
    expect(lista.lista).toBe(true);
    expect(lista.motivo).toBe("Los tres ejes llegan al 90 %: lista para el siguiente escalón");

    // (100 - 11) / 100 = 89 en el eje de conversación.
    const casi = medirPreparacion(resumen({ busqueda: [50, 30, 3, 0], conversacion: [200, 100, 11, 0], pago: [20, 10, 1, 0] }));
    expect(casi.ejes[1].pct).toBe(89);
    expect(casi.general).toBe(89);
    expect(casi.ejeMasFlojo).toBe("conversacion");
    expect(casi.lista).toBe(false);
  });

  it("29 revisiones de búsqueda con 100 % no alcanzan: el mínimo manda sobre el porcentaje", () => {
    const r = medirPreparacion(resumen({ busqueda: [50, 29, 0, 0], conversacion: [50, 30, 0, 0], pago: [20, 10, 0, 0] }));
    expect(r.ejes[0]).toMatchObject({ pct: 100, suficiente: false, faltan: 1 });
    expect(r.general).toBeNull();
    expect(r.lista).toBe(false);
  });

  it("un resumen sin ninguna fila de eje no inventa porcentajes", () => {
    const fila = filaResumen();
    fila.preparacion.ejes = [];
    const vacio = sombraResumenFromRow(fila);
    expect(vacio).not.toBeNull();
    const r = medirPreparacion(vacio as SombraResumen);
    expect(r.ejes.map((e) => e.pct)).toEqual([null, null, null]);
    expect(r.general).toBeNull();
  });
});

describe("proyectarConsumo", () => {
  it("costo por borrador, promedio diario y proyección al 100 % con el muestreo al 20 %", () => {
    const p = proyectarConsumo(resumen({}, { muestreo_pct: 20 }));

    // 4 USD en 20 borradores, repartidos en 2 días.
    expect(p.costoPorBorradorUsd).toBeCloseTo(0.2);
    expect(p.diasEnElPeriodo).toBe(2);
    expect(p.promedioDiarioUsd).toBeCloseTo(2);
    // Con el 20 % de las conversaciones: al 100 % serían cinco veces más.
    expect(p.alCienPorCientoUsd).toBeCloseTo(10);
  });

  it("con muestreo 100 la proyección es el propio promedio diario", () => {
    expect(proyectarConsumo(resumen()).alCienPorCientoUsd).toBeCloseTo(2);
  });

  it("muestreo 0 no se puede proyectar: null, no infinito", () => {
    const p = proyectarConsumo(resumen({}, { muestreo_pct: 0 }));
    expect(p.alCienPorCientoUsd).toBeNull();
    expect(p.promedioDiarioUsd).toBeCloseTo(2);
  });

  it("muestreo desconocido tampoco se proyecta", () => {
    expect(proyectarConsumo(resumen({}, { muestreo_pct: null })).alCienPorCientoUsd).toBeNull();
  });

  it("sin costo (todo sin tarifa) no hay costo por borrador ni proyección", () => {
    const p = proyectarConsumo(
      resumen(
        {},
        { total: { borradores: 20, input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, costo_usd: null, sin_tarifa: 20 } }
      )
    );
    expect(p.costoPorBorradorUsd).toBeNull();
    expect(p.promedioDiarioUsd).toBeNull();
    expect(p.alCienPorCientoUsd).toBeNull();
  });

  it("sin borradores ni días: todo null y cero días", () => {
    const p = proyectarConsumo(
      resumen(
        {},
        {
          dias: [],
          total: { borradores: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, costo_usd: 0, sin_tarifa: 0 },
        }
      )
    );
    expect(p).toEqual({ costoPorBorradorUsd: null, alCienPorCientoUsd: null, diasEnElPeriodo: 0, promedioDiarioUsd: null });
  });
});
