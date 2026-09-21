import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogLink, Playbook } from "@/lib/types";

const generateObjectMock = vi.fn();

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock("@/lib/ai/model", () => ({
  // getClassifierModel fija el esfuerzo bajo por dentro: el llamador ya no
  // lo elige, solo dice qué fase pide la llamada.
  getClassifierModel: (fase: string) => ({
    model: `modelo-falso:${fase}`,
    providerOptions: { openai: { reasoningEffort: "low" } },
  }),
}));

import { fetchActivePlaybooks, matchPlaybook, playbookSentRecently } from "@/lib/ai/playbooks";
import { log } from "@/lib/log";

const USAGE = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };

function playbook(name: string, overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: `id-${name}`,
    name,
    triggerDescription: `cuando aplica ${name}`,
    responseText: `texto de ${name}`,
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    cedeAlInventario: false,
    tags: [],
    ...overrides,
  };
}

/** T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026). */
function catalogLink(overrides: Partial<CatalogLink> = {}): CatalogLink {
  return {
    id: "link-1",
    key: "cascos",
    label: "Cascos",
    url: "https://drive.google.com/cascos",
    sortOrder: 1,
    isActive: true,
    updatedBy: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

const HISTORY = [{ role: "user" as const, content: "hola quiero accesorios" }];

describe("matchPlaybook", () => {
  it("no llama al modelo cuando no hay escenarios activos", async () => {
    generateObjectMock.mockClear();

    const result = await matchPlaybook(HISTORY, []);

    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(result.playbook).toBeNull();
    expect(result.usage.totalTokens).toBe(0);
  });

  it("devuelve el escenario cuyo nombre eligió el modelo", async () => {
    const catalogo = playbook("Catálogo general");
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Catálogo general", usage: USAGE });

    const result = await matchPlaybook(HISTORY, [playbook("Postventa Cashea"), catalogo]);

    expect(result.playbook).toEqual(catalogo);
    expect(result.usage).toEqual(USAGE);
  });

  it("devuelve null cuando el modelo responde que no coincide ninguno", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });

    const result = await matchPlaybook(HISTORY, [playbook("Catálogo general")]);

    expect(result.playbook).toBeNull();
    // Los tokens se gastaron igual: el turno tiene que contabilizarlos.
    expect(result.usage).toEqual(USAGE);
  });

  it("trata un nombre desconocido como si no hubiera coincidido, sin romper el turno", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Escenario inventado", usage: USAGE });

    const result = await matchPlaybook(HISTORY, [playbook("Catálogo general")]);

    expect(result.playbook).toBeNull();
  });

  it("ofrece al modelo los nombres de los escenarios más la opción de no elegir ninguno", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });

    await matchPlaybook(HISTORY, [playbook("Postventa Cashea"), playbook("Catálogo general")]);

    const call = generateObjectMock.mock.calls[0][0] as { enum: string[]; system: string };
    expect(call.enum).toEqual(["Postventa Cashea", "Catálogo general", "ninguno"]);
    // El prompt tiene que llevar el "cuándo aplica" de cada escenario: es lo
    // único con lo que el modelo puede decidir.
    expect(call.system).toContain("cuando aplica Postventa Cashea");
    expect(call.system).toContain("cuando aplica Catálogo general");
  });

  /**
   * Frente B3 (5/9/2026, "El reloj dice la verdad"): la franja y el horario
   * ya vienen calculados, igual que en prompt.ts — el clasificador no tiene
   * que deducir "tarde" a partir de "4:45 p. m." para comparar contra un
   * disparador que hable de horario.
   */
  it("le lleva al clasificador la franja y el horario ya calculados", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });

    // 20:30 Caracas, viernes: franja noche, tienda cerrada (default L-V 8-18).
    await matchPlaybook(HISTORY, [playbook("saludo")], new Date("2026-09-05T00:30:00Z"));

    const call = generateObjectMock.mock.calls[0][0] as { system: string };
    expect(call.system).toContain("franja: noche");
    expect(call.system).toMatch(/tienda está cerrada/);
  });

  it("si el modelo falla, no coincide ningún escenario en vez de tumbar el turno", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockRejectedValue(new Error("503 del proveedor"));

    const result = await matchPlaybook(HISTORY, [playbook("Catálogo general")]);

    expect(result.playbook).toBeNull();
    expect(result.usage.totalTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tarea 4, "La voz de mostrador con nombre propio y el cierre de v1.1"
// (15/9/2026), decisión 5: reemplaza el descarte CONDICIONAL que trajo la
// corrida anterior (T4, 14/9/2026 — el quinto argumento `lastCustomerText`
// solo sacaba un escenario de saludo cuando el cliente traía algo más que
// un saludo). Desde T3 de esta corrida (`44145c7`) el saludo lo pone
// `buildInstructions` (prompt.ts), una sola vez por conversación y con la
// franja ya calculada — así que fase 0 ya no tiene que decidir SI el
// cliente vino a saludar o a preguntar: ningún escenario del panel tiene
// que volver a saludar, punto. `matchPlaybook` perdió el quinto parámetro y
// el filtro corre siempre, sin mirar el historial.
// ---------------------------------------------------------------------------
describe("matchPlaybook · el saludo no tapa la pregunta real", () => {
  const saludo = playbook("Saludo", { responseText: "¡Buenas tardes! ¿En qué podemos ayudarte hoy?" });
  const catalogo = playbook("Catálogo general", { responseText: "Claro, dame un momento para revisar." });
  // Empieza agradeciendo, no saludando: `isGreetingPlaybook` no lo reconoce
  // como saludo y por eso sigue en el enum aunque el descarte sea
  // incondicional.
  const postventa = playbook("Postventa Cashea", {
    responseText: "¡Gracias por tu compra! Cualquier duda con Cashea, escríbenos.",
  });

  it("con un 'hola' pelado, el enum NO incluye el escenario de saludo", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });

    await matchPlaybook([{ role: "user", content: "hola" }], [saludo, catalogo]);

    const call = generateObjectMock.mock.calls[0][0] as { enum: string[] };
    expect(call.enum).not.toContain("Saludo");
    expect(call.enum).toContain("Catálogo general");
  });

  it("con saludo y pregunta en el mismo mensaje, tampoco lo incluye", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Catálogo general", usage: USAGE });

    await matchPlaybook([{ role: "user", content: "Buenas tardes, tienen tanque de EK Xpress" }], [saludo, catalogo]);

    const call = generateObjectMock.mock.calls[0][0] as { enum: string[] };
    expect(call.enum).not.toContain("Saludo");
    expect(call.enum).toContain("Catálogo general");
  });

  it("con solo escenarios de saludo activos, no llama al modelo y el turno no cuesta nada", async () => {
    generateObjectMock.mockClear();

    const result = await matchPlaybook([{ role: "user", content: "hola" }], [saludo]);

    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(result.playbook).toBeNull();
    expect(result.usage.totalTokens).toBe(0);
  });

  it("deja en el registro cuántos escenarios de saludo ignoró, y cuáles", async () => {
    const info = vi.spyOn(log, "info");
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Catálogo general", usage: USAGE });

    await matchPlaybook([{ role: "user", content: "hola" }], [saludo, catalogo]);

    expect(info).toHaveBeenCalledWith("escenarios_saludo_ignorados", { ignorados: 1, nombres: "Saludo" });
  });

  it("un escenario que agradece, no que saluda, sigue en el enum", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Postventa Cashea", usage: USAGE });

    await matchPlaybook([{ role: "user", content: "hola" }], [saludo, postventa]);

    const call = generateObjectMock.mock.calls[0][0] as { enum: string[] };
    expect(call.enum).not.toContain("Saludo");
    expect(call.enum).toContain("Postventa Cashea");
  });

  it("el prompt le dice al modelo que clasifique por la pregunta cuando el cliente saluda y pregunta a la vez", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Catálogo general", usage: USAGE });

    await matchPlaybook([{ role: "user", content: "hola, quiero un casco" }], [catalogo]);

    const call = generateObjectMock.mock.calls[0][0] as { system: string };
    expect(call.system).toContain("el saludo no cuenta");
  });
});

// ---------------------------------------------------------------------------
// T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
// D6): un escenario con `{{catalogo:<key>}}`/`{{catalogos}}` que no resuelve
// contra los catálogos ACTIVOS de hoy NUNCA llega al cliente — se saca de
// los candidatos ANTES de llamar al modelo, mismo patrón que el descarte de
// saludo de más arriba.
// ---------------------------------------------------------------------------
describe("matchPlaybook · el marcador de catálogo sin resolver no es candidato", () => {
  it("un escenario con {{catalogo:x}} sin ningún catálogo cargado no entra al enum", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });
    const roto = playbook("Catálogo cascos", { responseText: "Acá tienes: {{catalogo:cascos}}" });
    const ok = playbook("Ubicación", { responseText: "Estamos en tal parte" });

    await matchPlaybook(HISTORY, [roto, ok], undefined, undefined, []);

    const call = generateObjectMock.mock.calls[0][0] as { enum: string[] };
    expect(call.enum).not.toContain("Catálogo cascos");
    expect(call.enum).toContain("Ubicación");
  });

  it("con el catálogo activo cargado, el mismo escenario sí entra", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Catálogo cascos", usage: USAGE });
    const ok = playbook("Catálogo cascos", { responseText: "Acá tienes: {{catalogo:cascos}}" });

    const result = await matchPlaybook(HISTORY, [ok], undefined, undefined, [catalogLink()]);

    expect(result.playbook).toEqual(ok);
  });

  it("un catálogo INACTIVO deja el escenario fuera, igual que uno inexistente (D6)", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });
    const roto = playbook("Catálogo cascos", { responseText: "Acá tienes: {{catalogo:cascos}}" });

    await matchPlaybook(HISTORY, [roto], undefined, undefined, [catalogLink({ isActive: false })]);

    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("{{catalogos}} sin NINGÚN catálogo activo también cuenta como sin resolver", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });
    const roto = playbook("Catálogo general", { responseText: "Ver también: {{catalogos}}" });

    await matchPlaybook(HISTORY, [roto], undefined, undefined, []);

    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("un marcador dentro de attachment_url (adjunto tipo link) también cuenta", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });
    const roto = playbook("Con adjunto", {
      responseText: "Mira esto",
      attachmentUrl: "{{catalogo:cascos}}",
      attachmentType: "link",
    });

    await matchPlaybook(HISTORY, [roto], undefined, undefined, []);

    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("un marcador dentro de attachment_url de un adjunto que NO es link no se evalúa (no se manda como texto)", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Con adjunto", usage: USAGE });
    const conAdjuntoDocumento = playbook("Con adjunto", {
      responseText: "Mira esto",
      attachmentUrl: "{{catalogo:cascos}}",
      attachmentType: "document",
    });

    const result = await matchPlaybook(HISTORY, [conAdjuntoDocumento], undefined, undefined, []);

    expect(result.playbook).toEqual(conAdjuntoDocumento);
  });

  it("sin ningún marcador, un escenario sigue siendo candidato aunque no haya catálogos cargados", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Postventa Cashea", usage: USAGE });
    const sinMarcador = playbook("Postventa Cashea");

    const result = await matchPlaybook(HISTORY, [sinMarcador], undefined, undefined, []);

    expect(result.playbook).toEqual(sinMarcador);
  });

  it("deja en el registro cuántos escenarios con enlace sin resolver ignoró, y cuáles", async () => {
    const info = vi.spyOn(log, "info");
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Ubicación", usage: USAGE });
    const roto = playbook("Catálogo cascos", { responseText: "Acá tienes: {{catalogo:cascos}}" });
    const ok = playbook("Ubicación", { responseText: "Estamos en tal parte" });

    await matchPlaybook(HISTORY, [roto, ok], undefined, undefined, []);

    expect(info).toHaveBeenCalledWith("escenarios_enlace_sin_resolver", {
      ignorados: 1,
      nombres: "Catálogo cascos",
    });
  });

  it("sin el parámetro links (llamador viejo), un escenario con marcador queda fuera igual (default [])", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });
    const roto = playbook("Catálogo cascos", { responseText: "Acá tienes: {{catalogo:cascos}}" });

    await matchPlaybook(HISTORY, [roto]);

    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  /**
   * Corrección de la revisión `code-review high` del 19/9/2026, punto 1: un
   * marcador mal escrito (clave con guion bajo, aquí) no calzaba la regex
   * estricta de `resolveCatalogMarkers` y `missing` quedaba `[]` — el
   * escenario seguía siendo candidato y el texto crudo `{{catalogo:…}}`
   * podía salir tal cual por WhatsApp. Ahora la red laxa de
   * `catalog-links.ts` lo marca igual que un marcador bien formado sin
   * catálogo activo.
   */
  it("un escenario con un marcador MAL ESCRITO tampoco es candidato", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });
    const malEscrito = playbook("Catálogo mal escrito", {
      responseText: "Acá tienes: {{catalogo:cascos_nuevos}}",
    });
    const ok = playbook("Ubicación", { responseText: "Estamos en tal parte" });

    await matchPlaybook(HISTORY, [malEscrito, ok], undefined, undefined, [catalogLink()]);

    const call = generateObjectMock.mock.calls[0][0] as { enum: string[] };
    expect(call.enum).not.toContain("Catálogo mal escrito");
    expect(call.enum).toContain("Ubicación");
  });
});

describe("matchPlaybook · costo del turno", () => {
  /**
   * El reconocimiento de escenario corre en TODOS los turnos y devuelve un
   * nombre de una lista cerrada. Razonar de más ahí se paga en cada mensaje
   * que entra, sin mejorar la elección.
   */
  it("le traslada al proveedor el esfuerzo de razonamiento bajo", async () => {
    generateObjectMock.mockResolvedValue({ object: "saludo", usage: USAGE });

    await matchPlaybook(HISTORY, [playbook("saludo")]);

    const call = generateObjectMock.mock.calls[0][0] as { providerOptions?: unknown };
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
  });
});

// ---------------------------------------------------------------------------
// La ventana de repetición
// ---------------------------------------------------------------------------

interface Filtro {
  op: string;
  columna: string;
  valor: unknown;
}

/** Fake de la cadena `.from().select().eq().eq().gt().limit()`. */
function fakeSupabase(filas: { id: string }[], error: { message: string } | null = null) {
  const filtros: Filtro[] = [];
  const tablas: string[] = [];

  const cadena = {
    eq: (columna: string, valor: unknown) => {
      filtros.push({ op: "eq", columna, valor });
      return cadena;
    },
    gt: (columna: string, valor: unknown) => {
      filtros.push({ op: "gt", columna, valor });
      return cadena;
    },
    limit: async () => ({ data: error ? null : filas, error }),
  };

  const client = {
    from: (tabla: string) => {
      tablas.push(tabla);
      return { select: () => cadena };
    },
  };

  return { client: client as never, filtros, tablas };
}

const AHORA = Date.parse("2026-08-27T16:30:00.000Z");

describe("playbookSentRecently — un escenario no se repite en el mismo chat", () => {
  it("dice que sí cuando la bitácora tiene un envío dentro de la ventana", async () => {
    const { client } = fakeSupabase([{ id: "turno-1" }]);

    expect(await playbookSentRecently(client, "conv-1", "pb-1", AHORA)).toBe(true);
  });

  it("dice que no cuando no hay ninguno", async () => {
    const { client } = fakeSupabase([]);

    expect(await playbookSentRecently(client, "conv-1", "pb-1", AHORA)).toBe(false);
  });

  /**
   * Los tres cortes son el contrato: ESTE escenario, en ESTA conversación,
   * dentro de la ventana. Quitar cualquiera lo convierte en otra pregunta —
   * sin `playbook_id` frenaría escenarios distintos, sin `conversation_id`
   * frenaría el chat de otro cliente.
   */
  it("pregunta por este escenario, en esta conversación y dentro de las seis horas", async () => {
    const { client, filtros, tablas } = fakeSupabase([]);

    await playbookSentRecently(client, "conv-1", "pb-1", AHORA);

    expect(tablas).toEqual(["agent_turns"]);
    expect(filtros).toContainEqual({ op: "eq", columna: "conversation_id", valor: "conv-1" });
    expect(filtros).toContainEqual({ op: "eq", columna: "playbook_id", valor: "pb-1" });
    expect(filtros).toContainEqual({
      op: "gt",
      columna: "created_at",
      valor: "2026-08-27T10:30:00.000Z",
    });
  });

  /**
   * Falla cerrado. Cuesta barato equivocarse hacia acá —el turno sigue por el
   * flujo genérico y el cliente igual recibe respuesta— y equivocarse hacia el
   * otro lado es el incidente del 27 de agosto.
   */
  it("si la consulta falla, da el escenario por repetido", async () => {
    const { client } = fakeSupabase([], { message: "connection reset" });

    expect(await playbookSentRecently(client, "conv-1", "pb-1", AHORA)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T1, plan "El catálogo configurado sale siempre" (21/9/2026): la lectura del
// TURNO (`fetchActivePlaybooks`) tiene que traer `cede_al_inventario` en el
// select y mapearla al campo `cedeAlInventario` del tipo de dominio -- sin
// esto, la cuarta condición de "el repuesto manda" (H1) no puede evaluarse
// nunca en `agent.ts`, aunque el supervisor haya marcado la casilla en el
// panel.
// ---------------------------------------------------------------------------
interface FakeActivePlaybookRow {
  id: string;
  name: string;
  trigger_description: string;
  response_text: string;
  attachment_url: string | null;
  attachment_type: string | null;
  after_send: string;
  is_active: boolean;
  cede_al_inventario: boolean;
  ai_playbook_tags: { tag: { id: string; label: string; color: string } | null }[] | null;
}

function fakeActivePlaybooksSupabase(rows: FakeActivePlaybookRow[] | null, error: { message: string } | null = null) {
  const calls: { select?: string; eq?: [string, unknown]; order?: string } = {};

  const client = {
    from(table: string) {
      if (table !== "ai_playbooks") throw new Error(`tabla inesperada: ${table}`);
      return {
        select(columns: string) {
          calls.select = columns;
          return {
            eq(column: string, value: unknown) {
              calls.eq = [column, value];
              return {
                order(column2: string) {
                  calls.order = column2;
                  return Promise.resolve({ data: rows, error });
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchActivePlaybooks — la lectura del turno trae cede_al_inventario", () => {
  it("pide la columna cede_al_inventario en el select", async () => {
    const { client, calls } = fakeActivePlaybooksSupabase([]);

    await fetchActivePlaybooks(client);

    expect(calls.select).toContain("cede_al_inventario");
  });

  it("mapea cede_al_inventario = true al campo cedeAlInventario del Playbook", async () => {
    const { client } = fakeActivePlaybooksSupabase([
      {
        id: "pb-catalogo-general",
        name: "Catálogo general",
        trigger_description: "el cliente pide el catálogo",
        response_text: "Acá tienes nuestro catálogo.",
        attachment_url: null,
        attachment_type: null,
        after_send: "wait",
        is_active: true,
        cede_al_inventario: true,
        ai_playbook_tags: null,
      },
    ]);

    const result = await fetchActivePlaybooks(client);

    expect(result).toHaveLength(1);
    expect(result[0].cedeAlInventario).toBe(true);
  });

  it("mapea cede_al_inventario = false (el default) al campo cedeAlInventario", async () => {
    const { client } = fakeActivePlaybooksSupabase([
      {
        id: "pb-otro",
        name: "Otro escenario",
        trigger_description: "cuando aplica otro",
        response_text: "texto de otro",
        attachment_url: null,
        attachment_type: null,
        after_send: "wait",
        is_active: true,
        cede_al_inventario: false,
        ai_playbook_tags: null,
      },
    ]);

    const result = await fetchActivePlaybooks(client);

    expect(result[0].cedeAlInventario).toBe(false);
  });
});
