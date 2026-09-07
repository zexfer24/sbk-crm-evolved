// ---------------------------------------------------------------------------
// Comparador grande×chico de la clasificación (T2, corrida "La respuesta
// llega en siete segundos", 7/9/2026).
//
// Objetivo de la corrida: la clasificación (fase 0 + fase 1 del turno) se
// lleva 2,9 s de mediana con el modelo grande de producción, y para bajar el
// turno completo a 7 s de mediana tiene que bajar a ~1 s. La costura para
// mover SOLO la clasificación a otro modelo ya existe (`AI_CLASSIFIER_MODEL`,
// ver model.ts) pero está vacía. Este archivo NO decide si se aplica: mide.
//
// Por qué es un archivo de vitest y no un script `tsx` suelto: classify.ts,
// playbooks.ts y model.ts importan `server-only`, y el alias de
// vitest.config.ts (`server-only` → vitest.server-only-stub.ts) es lo único
// que los deja importarse fuera de una request de Next. Vive en `scripts/`
// y no al lado de esos módulos porque no es un test de esos módulos: es una
// medición que compara dos configuraciones completas del sistema.
//
// POR QUÉ DOS PASADAS (y no una sola alternando por conversación): el modelo
// de clasificación sale de `AI_CLASSIFIER_MODEL`, una variable de
// `process.env` -- GLOBAL AL PROCESO, no un parámetro que viaje con cada
// llamada. Si se alternara "grande, chico, grande, chico..." con varias
// conversaciones en vuelo a la vez (que es lo que hace falta para no
// pegarse al timeout, ver abajo), una llamada que arrancó con la variable en
// "grande" podría terminar de resolverse después de que otra tarea la haya
// puesto en "chico" -- se mediría un modelo con el nombre del otro. La única
// forma segura de paralelizar es fijar la variable UNA vez por pasada y no
// tocarla hasta que esa pasada completa termine: pasada 1 evalúa TODAS las
// conversaciones con el grande (`AI_CLASSIFIER_MODEL` borrado), pasada 2
// TODAS con el chico.
//
// POR QUÉ CONCURRENCIA ACOTADA (no todo en serie): 200 conversaciones × 2
// llamadas (intención + escenario) por modelo, en serie y a 1-3 s cada una,
// rondan los 27 minutos -- pegados al timeout de 30 de este archivo. Un pool
// de 5 conversaciones en vuelo por pasada (más las 2 llamadas concurrentes
// de cada una, `Promise.all`, mismo patrón que la fase 0/fase 1 del turno
// real en agent.ts:1040) baja cada pasada a un puñado de minutos sin superar
// el tope de peticiones simultáneas del proveedor: `AI_MAX_CONCURRENT_REQUESTS`
// se sube a 20 acá abajo, y 5 conversaciones × 2 llamadas son 10 en vuelo
// como mucho, con margen debajo de ese tope.
//
// CÓMO CORRERLO DE VERDAD (el operador, con credenciales de producción
// exportadas en la SHELL de esa corrida -- nunca en un archivo):
//
//   export OPENAI_API_KEY=<clave real de producción>
//   export OPENAI_BASE_URL=<la de producción, hoy OpenRouter>
//   export COMPARAR_CLASIFICADOR=1
//   export COMPARAR_CLASIFICADOR_FIXTURE=scripts/historiales-clasificador.json
//   rtk npx vitest run scripts/comparar-clasificador.test.ts
//
// `COMPARAR_CLASIFICADOR_FIXTURE` es OBLIGATORIO para medir contra datos
// reales: sin ella (o sin COMPARAR_CLASIFICADOR) el archivo entero sale
// skipped, y si solo falta la variable de fixture cae al fixture SINTÉTICO
// commiteado (`comparar-clasificador.fixture-sintetico.json`) a propósito --
// así una corrida sin la variable nunca mide contra el archivo real por
// descuido. El export real sale con `scripts/exportar-historiales-clasificador.sql`
// (cabecera de ese archivo: comando exacto por SSH). Opcional:
// `COMPARAR_CLASIFICADOR_CHICO` para probar un candidato distinto al default
// (`google/gemini-3.1-flash-lite`, el nombre tal como lo lista OpenRouter).
//
// Este comparador respeta `AI_AGENT_REASONING`/`AI_AGENT_MODEL`/
// `AI_AGENT_PROVIDER` si ya vienen en el entorno (no los toca): así mide con
// la MISMA configuración de producción salvo la única variable que compara,
// `AI_CLASSIFIER_MODEL`.
//
// Detección de fallos SIN parchear console.error: bajo concurrencia, un
// parche de `console.error` por llamada se interleava con las demás llamadas
// en vuelo y deja de ser confiable (dos capturas simultáneas pueden robarse
// líneas entre sí). En su lugar:
//   - `classifyIntent` SÍ lanza -- se envuelve en try/catch normal.
//   - `matchPlaybook` NUNCA lanza (ver playbooks.ts): ante un fallo del
//     proveedor atrapa el error y devuelve `{ playbook: null, usage:
//     ZERO_USAGE }`, EXACTAMENTE lo mismo que devuelve cuando no hay ningún
//     escenario candidato a esa hora. La única forma de distinguir "falló"
//     de "no había nada que reconocer" es mirar si HABÍA candidatos
//     (`playbooksAtTime`, la misma función que usa `matchPlaybook`
//     internamente): con candidatos, `playbook === null && usage.totalTokens
//     === 0` es un fallo -- un NO_MATCH real del modelo consume tokens.
//   - Un colector GLOBAL de `console.error` (uno solo, para toda la corrida,
//     las dos pasadas) que arranca al principio del test y se restaura al
//     final en un `finally`: no distingue de qué llamada vino cada línea,
//     pero eso está bien -- se vuelca ENTERO en la sección "Eventos de log
//     durante la corrida" del reporte, así que un `escenario_reconocimiento_
//     fallido` o un `ia_rate_limit` de rate-limit.ts queda citado igual,
//     aunque no atado a una conversación puntual.
//
// Qué mide, y qué NO: reconstruye cada historial con `historyLine` (mismo
// camino que `loadHistory` en agent.ts) y llama `classifyIntent` +
// `matchPlaybook` una vez por conversación en cada pasada. El criterio de
// aplicación (≥95% de acuerdo en intención, cero escenarios que el grande
// reconozca y el chico no) se IMPRIME como veredicto, pero el test NO falla
// por no cumplirlo -- probar el candidato y que salga "no cumple" es un
// resultado válido de este archivo, no un bug. Falla solo si no pudo
// completar NINGUNA llamada al proveedor (por ejemplo, sin credenciales):
// eso sí es "no pudo correr", no un dato de la comparación.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";

// rate-limit.ts lee AI_MAX_CONCURRENT_REQUESTS/AI_MAX_REQUESTS_PER_MINUTE en
// CADA llamada (topeConcurrente/topePorMinuto), no al importar -- fijarlas
// acá arriba, antes de importar classify.ts/playbooks.ts, alcanza y además
// deja claro que esto no es el ritmo de producción: el comparador corre
// cientos de conversaciones y necesita margen, no el freno pensado para
// turnos reales de cliente. El pool de este archivo (ver CONCURRENCIA más
// abajo) se queda deliberadamente por debajo de este tope.
process.env.AI_MAX_CONCURRENT_REQUESTS ??= "20";
process.env.AI_MAX_REQUESTS_PER_MINUTE ??= "600";

import { classifyIntent, INTENT_VALUES, type Intent } from "@/lib/ai/classify";
import { matchPlaybook } from "@/lib/ai/playbooks";
import { playbooksAtTime } from "@/lib/ai/greeting-window";
import { historyLine, type HistoryRow } from "@/lib/ai/history-line";
import { parseBusinessHours } from "@/lib/business-hours";
import { errorText } from "@/lib/log";
import type { Playbook, PlaybookAfterSend, PlaybookAttachmentType, Tag, TagColor } from "@/lib/types";

const TREINTA_MINUTOS_MS = 30 * 60 * 1000;

/** Mismo default que documenta el brief: el nombre tal como lo lista OpenRouter. */
const MODELO_CHICO_DEFAULT = "google/gemini-3.1-flash-lite";

/** Conversaciones en vuelo a la vez, DENTRO de una pasada (ver cabecera). */
const CONCURRENCIA = 5;

const RUTA_FIXTURE_SINTETICO = path.join(__dirname, "comparar-clasificador.fixture-sintetico.json");
const RUTA_REPORTE = path.join(__dirname, "comparar-clasificador.reporte.md");

function rutaFixture(): string {
  const propia = process.env.COMPARAR_CLASIFICADOR_FIXTURE?.trim();
  return propia ? path.resolve(propia) : RUTA_FIXTURE_SINTETICO;
}

function modeloChico(): string {
  return process.env.COMPARAR_CLASIFICADOR_CHICO?.trim() || MODELO_CHICO_DEFAULT;
}

// --- Forma del JSON que produce exportar-historiales-clasificador.sql ------

interface RawMensajeRow extends HistoryRow {
  created_at: string;
}

interface RawEscenarioTag {
  id: string;
  label: string;
  color: string;
}

interface RawEscenario {
  id: string;
  name: string;
  trigger_description: string;
  response_text: string;
  attachment_url: string | null;
  attachment_type: string | null;
  after_send: string;
  is_active: boolean;
  tags: RawEscenarioTag[];
}

interface RawConversacion {
  conversation_id: string;
  mensajes: RawMensajeRow[];
}

interface RawFixture {
  conversaciones: RawConversacion[];
  escenarios: RawEscenario[];
  horario: unknown;
}

function mapEscenario(raw: RawEscenario): Playbook {
  return {
    id: raw.id,
    name: raw.name,
    triggerDescription: raw.trigger_description,
    responseText: raw.response_text,
    attachmentUrl: raw.attachment_url,
    attachmentType: raw.attachment_type as PlaybookAttachmentType | null,
    afterSend: raw.after_send as PlaybookAfterSend,
    isActive: raw.is_active,
    tags: raw.tags.map((tag): Tag => ({ id: tag.id, label: tag.label, color: tag.color as TagColor })),
  };
}

/** Mismo camino que `loadHistory` (agent.ts): cada fila pasa por `historyLine`, las que devuelven null se saltan. */
function construirHistoria(mensajes: RawMensajeRow[]): ModelMessage[] {
  const historia: ModelMessage[] = [];
  for (const fila of mensajes) {
    const linea = historyLine(fila);
    if (!linea) continue;
    historia.push({ role: linea.role, content: linea.content });
  }
  return historia;
}

// --- Pool de concurrencia acotada, sin dependencias nuevas ------------------

/**
 * Corre `tarea` sobre cada elemento de `items` con como mucho `limite` en
 * vuelo a la vez, preservando el resultado en el mismo índice del elemento
 * (no en el orden en que terminan). `null` en un resultado es válido
 * (conversación saltada) y no interrumpe al resto.
 */
async function conPool<T, R>(items: readonly T[], limite: number, tarea: (item: T, indice: number) => Promise<R>): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  let siguiente = 0;

  async function trabajador(): Promise<void> {
    for (;;) {
      const indice = siguiente++;
      if (indice >= items.length) return;
      resultados[indice] = await tarea(items[indice], indice);
    }
  }

  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, () => trabajador());
  await Promise.all(trabajadores);
  return resultados;
}

// --- Colector global de console.error (ver cabecera: por qué uno solo) -----

let eventosLog: string[] = [];
let consoleErrorOriginal: typeof console.error | null = null;

function iniciarColectorDeLog(): void {
  eventosLog = [];
  consoleErrorOriginal = console.error;
  console.error = (...args: unknown[]) => {
    eventosLog.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
}

function detenerColectorDeLog(): void {
  if (consoleErrorOriginal) console.error = consoleErrorOriginal;
  consoleErrorOriginal = null;
}

// --- Medición de una conversación, para un modelo ya fijado en el entorno --

interface ResultadoConversacion {
  intent: Intent | null;
  intentMs: number;
  intentTokens: number;
  intentError: string | null;
  playbookId: string | null;
  playbookName: string | null;
  playbookMs: number;
  playbookTokens: number;
  playbookError: string | null;
}

interface RegistroConversacion {
  conversationId: string;
  grande: ResultadoConversacion;
  chico: ResultadoConversacion;
}

function percentil(valores: number[], p: number): number {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const indice = Math.min(ordenados.length - 1, Math.floor((p / 100) * ordenados.length));
  return Math.round(ordenados[indice]);
}

function suma(valores: number[]): number {
  return valores.reduce((total, valor) => total + valor, 0);
}

function tablaMd(encabezados: string[], filas: string[][]): string {
  const linea = (celdas: string[]) => `| ${celdas.join(" | ")} |`;
  const separador = linea(encabezados.map(() => "---"));
  return [linea(encabezados), separador, ...filas.map(linea)].join("\n");
}

describe.skipIf(!process.env.COMPARAR_CLASIFICADOR)("comparador grande×chico de clasificación", () => {
  it(
    "mide acuerdo de intención y escenarios perdidos entre el modelo grande y el candidato chico",
    async () => {
      const ruta = rutaFixture();
      const chico = modeloChico();

      let crudo: RawFixture;
      try {
        crudo = JSON.parse(fs.readFileSync(ruta, "utf-8")) as RawFixture;
      } catch (err) {
        throw new Error(`No se pudo leer/parsear el fixture "${ruta}": ${errorText(err)}`);
      }

      if (!Array.isArray(crudo.conversaciones) || crudo.conversaciones.length === 0) {
        throw new Error(`El fixture "${ruta}" no trajo conversaciones utilizables.`);
      }

      const playbooks = crudo.escenarios.map(mapEscenario);
      const businessHours = parseBusinessHours(crudo.horario);

      /**
       * Evalúa UNA conversación con el modelo que esté fijado en
       * `AI_CLASSIFIER_MODEL` en este momento. No toca la variable -- eso lo
       * hace `correrPasada`, una sola vez para toda la pasada.
       */
      async function evaluarConversacion(conversacion: RawConversacion): Promise<ResultadoConversacion | null> {
        const historia = construirHistoria(conversacion.mensajes);
        if (historia.length === 0) return null;

        const ultimoMensaje = conversacion.mensajes[conversacion.mensajes.length - 1];
        const ahora = new Date(ultimoMensaje.created_at);
        const habiaCandidatos = playbooksAtTime(playbooks, ahora).length > 0;

        async function medirIntent(): Promise<Pick<ResultadoConversacion, "intent" | "intentMs" | "intentTokens" | "intentError">> {
          const inicio = performance.now();
          try {
            const { intent, usage } = await classifyIntent(historia);
            return { intent, intentMs: performance.now() - inicio, intentTokens: usage.totalTokens ?? 0, intentError: null };
          } catch (err) {
            return { intent: null, intentMs: performance.now() - inicio, intentTokens: 0, intentError: errorText(err) };
          }
        }

        async function medirPlaybook(): Promise<
          Pick<ResultadoConversacion, "playbookId" | "playbookName" | "playbookMs" | "playbookTokens" | "playbookError">
        > {
          const inicio = performance.now();
          const { playbook, usage } = await matchPlaybook(historia, playbooks, ahora, businessHours);
          const ms = performance.now() - inicio;
          const totalTokens = usage.totalTokens ?? 0;

          // matchPlaybook NUNCA lanza: un fallo del proveedor y "no había
          // ningún escenario candidato a esta hora" dan la MISMA forma
          // (playbook null + ZERO_USAGE). Solo se puede distinguir mirando si
          // había candidatos -- ver cabecera del archivo.
          const fallo = habiaCandidatos && playbook === null && totalTokens === 0;

          return {
            playbookId: playbook?.id ?? null,
            playbookName: playbook?.name ?? null,
            playbookMs: ms,
            playbookTokens: totalTokens,
            playbookError: fallo
              ? "matchPlaybook devolvió ZERO_USAGE con escenarios candidatos disponibles (fallo del proveedor; ver Eventos de log)"
              : null,
          };
        }

        // Mismo patrón que la fase 0/fase 1 del turno real (agent.ts:1040):
        // intención y escenario corren en paralelo dentro de una misma
        // conversación.
        const [resultadoIntent, resultadoPlaybook] = await Promise.all([medirIntent(), medirPlaybook()]);
        return { ...resultadoIntent, ...resultadoPlaybook };
      }

      async function correrPasada(modeloClasificador: string | null): Promise<(ResultadoConversacion | null)[]> {
        if (modeloClasificador === null) delete process.env.AI_CLASSIFIER_MODEL;
        else process.env.AI_CLASSIFIER_MODEL = modeloClasificador;

        return conPool(crudo.conversaciones, CONCURRENCIA, (conversacion) => evaluarConversacion(conversacion));
      }

      iniciarColectorDeLog();
      let resultadosGrande: (ResultadoConversacion | null)[];
      let resultadosChico: (ResultadoConversacion | null)[];
      try {
        // Pasada 1: TODAS las conversaciones con el modelo grande.
        resultadosGrande = await correrPasada(null);
        // Pasada 2: TODAS las conversaciones con el candidato chico.
        resultadosChico = await correrPasada(chico);
      } finally {
        delete process.env.AI_CLASSIFIER_MODEL;
        detenerColectorDeLog();
      }

      // --- Combinar las dos pasadas por índice (el pool preserva el orden) --

      const registros: RegistroConversacion[] = [];
      let saltadas = 0;
      for (let i = 0; i < crudo.conversaciones.length; i++) {
        const grande = resultadosGrande[i];
        const chicoResultado = resultadosChico[i];
        if (grande === null || chicoResultado === null) {
          saltadas++;
          continue;
        }
        registros.push({ conversationId: crudo.conversaciones[i].conversation_id, grande, chico: chicoResultado });
      }

      function contarLlamadas(resultados: (ResultadoConversacion | null)[]): { total: number; conError: number; primerError: string | null } {
        let total = 0;
        let conError = 0;
        let primerError: string | null = null;
        for (const r of resultados) {
          if (r === null) continue;
          total += 2;
          if (r.intentError) {
            conError++;
            primerError ??= r.intentError;
          }
          if (r.playbookError) {
            conError++;
            primerError ??= r.playbookError;
          }
        }
        return { total, conError, primerError };
      }

      const statsGrande = contarLlamadas(resultadosGrande);
      const statsChico = contarLlamadas(resultadosChico);
      const totalLlamadas = statsGrande.total + statsChico.total;
      const llamadasConError = statsGrande.conError + statsChico.conError;
      const primerError = statsGrande.primerError ?? statsChico.primerError;

      // "No pudo correr" -- ninguna de las llamadas llegó a completarse (por
      // ejemplo, sin credenciales del proveedor). Distinto de "corrió y unas
      // cuantas fallaron", que es un resultado del comparador, no un bug de
      // este archivo.
      if (totalLlamadas > 0 && llamadasConError === totalLlamadas) {
        throw new Error(
          `El comparador no logró completar ninguna llamada al proveedor (${totalLlamadas} intentos). Primer error: ${primerError}`
        );
      }

      // --- Agregados ---------------------------------------------------------

      const CLAVES_MATRIZ = [...INTENT_VALUES, "(error)"] as const;
      const matriz: Record<string, Record<string, number>> = {};
      for (const fila of CLAVES_MATRIZ) {
        matriz[fila] = {};
        for (const columna of CLAVES_MATRIZ) matriz[fila][columna] = 0;
      }

      let coincideIntent = 0;
      let comparablesIntent = 0;
      for (const registro of registros) {
        const g = registro.grande.intent ?? "(error)";
        const c = registro.chico.intent ?? "(error)";
        matriz[g][c]++;
        if (registro.grande.intent !== null && registro.chico.intent !== null) {
          comparablesIntent++;
          if (g === c) coincideIntent++;
        }
      }
      const acuerdoIntentPct = comparablesIntent > 0 ? (coincideIntent / comparablesIntent) * 100 : 0;

      const escenariosPerdidos: { conversationId: string; playbook: string }[] = [];
      const escenariosGanados: { conversationId: string; playbook: string }[] = [];
      const escenariosDistintos: { conversationId: string; grande: string; chico: string }[] = [];

      for (const registro of registros) {
        const g = registro.grande.playbookId;
        const c = registro.chico.playbookId;
        if (g !== null && c === null) {
          escenariosPerdidos.push({ conversationId: registro.conversationId, playbook: registro.grande.playbookName ?? g });
        } else if (g === null && c !== null) {
          escenariosGanados.push({ conversationId: registro.conversationId, playbook: registro.chico.playbookName ?? c });
        } else if (g !== null && c !== null && g !== c) {
          escenariosDistintos.push({
            conversationId: registro.conversationId,
            grande: registro.grande.playbookName ?? g,
            chico: registro.chico.playbookName ?? c,
          });
        }
      }

      const tiempos = {
        grande: {
          intent: registros.map((r) => r.grande.intentMs),
          escenario: registros.map((r) => r.grande.playbookMs),
        },
        chico: {
          intent: registros.map((r) => r.chico.intentMs),
          escenario: registros.map((r) => r.chico.playbookMs),
        },
      };

      const tokens = {
        grande: {
          intent: suma(registros.map((r) => r.grande.intentTokens)),
          escenario: suma(registros.map((r) => r.grande.playbookTokens)),
        },
        chico: {
          intent: suma(registros.map((r) => r.chico.intentTokens)),
          escenario: suma(registros.map((r) => r.chico.playbookTokens)),
        },
      };

      const erroresPorModelo = (clave: "grande" | "chico") =>
        registros.flatMap((r) => {
          const resultado = r[clave];
          const lineas: string[] = [];
          if (resultado.intentError) lineas.push(`${r.conversationId} · intención: ${resultado.intentError}`);
          if (resultado.playbookError) lineas.push(`${r.conversationId} · escenario: ${resultado.playbookError}`);
          return lineas;
        });
      const erroresGrande = erroresPorModelo("grande");
      const erroresChico = erroresPorModelo("chico");

      const cumpleAcuerdo = acuerdoIntentPct >= 95;
      const cumpleEscenarios = escenariosPerdidos.length === 0;
      const veredicto = cumpleAcuerdo && cumpleEscenarios ? "APLICAR" : "NO APLICAR";

      // --- Reporte -------------------------------------------------------

      const lineas: string[] = [];
      lineas.push(`# Comparador de clasificación — grande × chico`);
      lineas.push("");
      lineas.push(`Fecha: ${new Date().toISOString()}`);
      lineas.push(`Fixture: \`${ruta}\``);
      lineas.push(`Modelo chico: \`${chico}\``);
      lineas.push(`Concurrencia por pasada: ${CONCURRENCIA}`);
      lineas.push(`Conversaciones evaluadas: ${registros.length} (saltadas por historial vacío: ${saltadas})`);
      lineas.push("");

      lineas.push(`## Intención — acuerdo`);
      lineas.push("");
      lineas.push(`Acuerdo: **${acuerdoIntentPct.toFixed(1)}%** (${coincideIntent}/${comparablesIntent} comparables; ≥95% requerido)`);
      lineas.push("");
      lineas.push(`### Matriz de confusión (filas = grande, columnas = chico)`);
      lineas.push("");
      lineas.push(
        tablaMd(
          ["grande \\ chico", ...CLAVES_MATRIZ],
          CLAVES_MATRIZ.map((fila) => [fila, ...CLAVES_MATRIZ.map((columna) => String(matriz[fila][columna]))])
        )
      );
      lineas.push("");

      lineas.push(`## Escenarios`);
      lineas.push("");
      lineas.push(`El grande reconoció y el chico NO (pérdida, ${escenariosPerdidos.length}):`);
      lineas.push(
        escenariosPerdidos.length === 0
          ? "- (ninguno)"
          : escenariosPerdidos.map((e) => `- ${e.conversationId} → "${e.playbook}"`).join("\n")
      );
      lineas.push("");
      lineas.push(`El chico reconoció y el grande NO (${escenariosGanados.length}):`);
      lineas.push(
        escenariosGanados.length === 0
          ? "- (ninguno)"
          : escenariosGanados.map((e) => `- ${e.conversationId} → "${e.playbook}"`).join("\n")
      );
      lineas.push("");
      lineas.push(`Reconocieron escenarios DISTINTOS (${escenariosDistintos.length}):`);
      lineas.push(
        escenariosDistintos.length === 0
          ? "- (ninguno)"
          : escenariosDistintos.map((e) => `- ${e.conversationId} → grande: "${e.grande}", chico: "${e.chico}"`).join("\n")
      );
      lineas.push("");

      lineas.push(`## Tiempos de clasificación (ms)`);
      lineas.push("");
      lineas.push(
        tablaMd(
          ["modelo", "fase", "mediana", "p90"],
          [
            ["grande", "intención", String(percentil(tiempos.grande.intent, 50)), String(percentil(tiempos.grande.intent, 90))],
            ["grande", "escenario", String(percentil(tiempos.grande.escenario, 50)), String(percentil(tiempos.grande.escenario, 90))],
            ["chico", "intención", String(percentil(tiempos.chico.intent, 50)), String(percentil(tiempos.chico.intent, 90))],
            ["chico", "escenario", String(percentil(tiempos.chico.escenario, 50)), String(percentil(tiempos.chico.escenario, 90))],
          ]
        )
      );
      lineas.push("");

      lineas.push(`## Tokens (suma de todas las conversaciones evaluadas)`);
      lineas.push("");
      lineas.push(
        tablaMd(
          ["modelo", "fase", "tokens totales"],
          [
            ["grande", "intención", String(tokens.grande.intent)],
            ["grande", "escenario", String(tokens.grande.escenario)],
            ["chico", "intención", String(tokens.chico.intent)],
            ["chico", "escenario", String(tokens.chico.escenario)],
          ]
        )
      );
      lineas.push("");

      lineas.push(`## Errores del proveedor`);
      lineas.push("");
      lineas.push(`Grande (${erroresGrande.length}):`);
      lineas.push(erroresGrande.length === 0 ? "- (ninguno)" : erroresGrande.map((e) => `- ${e}`).join("\n"));
      lineas.push("");
      lineas.push(`Chico (${erroresChico.length}):`);
      lineas.push(erroresChico.length === 0 ? "- (ninguno)" : erroresChico.map((e) => `- ${e}`).join("\n"));
      lineas.push("");

      lineas.push(`## Eventos de log durante la corrida`);
      lineas.push("");
      lineas.push(
        `Captura GLOBAL de \`console.error\` de las dos pasadas (no atada a una conversación puntual -- ver cabecera del archivo). ${eventosLog.length} línea(s):`
      );
      lineas.push("");
      lineas.push(eventosLog.length === 0 ? "- (ninguna)" : eventosLog.map((e) => `- ${e}`).join("\n"));
      lineas.push("");

      lineas.push(`## VEREDICTO`);
      lineas.push("");
      lineas.push(
        `**${veredicto}** — acuerdo de intención ${cumpleAcuerdo ? "cumple" : "NO cumple"} (${acuerdoIntentPct.toFixed(1)}% ${
          cumpleAcuerdo ? "≥" : "<"
        } 95%); escenarios perdidos ${cumpleEscenarios ? "cumple (cero)" : `NO cumple (${escenariosPerdidos.length})`}.`
      );
      lineas.push("");

      const reporte = lineas.join("\n");
      console.log(reporte);
      fs.writeFileSync(RUTA_REPORTE, reporte, "utf-8");

      // El test afirma que el comparador CORRIÓ hasta el final y dejó su
      // reporte -- el veredicto en sí no es una aserción de este archivo (ver
      // encabezado): la decisión de aplicar el candidato la toma el
      // orquestador leyendo el reporte.
      expect(registros.length + saltadas).toBe(crudo.conversaciones.length);
      expect(fs.existsSync(RUTA_REPORTE)).toBe(true);
    },
    TREINTA_MINUTOS_MS
  );
});
