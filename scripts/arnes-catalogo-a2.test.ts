// ---------------------------------------------------------------------------
// ARNÉS del catálogo de Seba (A2 T7, 30/9/2026, plan "Seba no cotiza lo que no
// es"). FUERA de la suite normal: `vitest.config.ts` lo excluye y se corre aparte,
//
//   npm run test:arnes
//
// Qué hace, en orden:
//   1. Carga el catálogo de prueba (`__fixtures__/catalogo-a2.ts`, 301 productos
//      con código `A2FIX-####` en `description`) con psql COMO postgres:
//      `products` es de solo lectura para la app (CLAUDE.md, "`products` es de
//      solo lectura…", migración 20260925010000) y el trigger BEFORE solo deja
//      pasar a postgres/supabase_admin. El SQL se arma en el momento con
//      `armarSqlCarga(CATALOGO_A2)` (la misma función que
//      `scripts/fixture-a2-sql.ts`), nunca se lee de un `.sql` viejo: la fuente
//      es una sola.
//   2. Corre el `buildCatalogTool` REAL —cliente admin (service_role), la
//      función SQL `buscar_productos`/`corregir_terminos`/`diagnosticar_terminos`
//      de las migraciones, los sinónimos de M4 en `ai_lessons` y la memoria del
//      pedido en Redis— sobre TODOS los casos de `casos-a2.ts`, incluidas las
//      conversaciones de dos turnos. Único doble: `getBcvRate` (una tasa fija de
//      40; la tasa BCV no es lo que se mide y en el CI no hay salida a la
//      página del BCV).
//   3. Compara cada caso con lo esperado con las MISMAS aserciones que la suite
//      normal (`verificarEsperadoA2`, compartidas a propósito).
//   4. Regla «cero casos peor»: ningún caso puede fallar. Lo esperado de cada
//      caso ya es el comportamiento de `3d3e9a0` (el hotfix de una sola opción y
//      sin agotados junto a algo con stock) ajustado a D6 y a las decisiones del
//      plan; donde una decisión cambia a propósito lo que salía antes, el caso
//      lleva `cambioDeliberado` y su expectativa ya es la nueva. Un caso rojo es
//      una regresión respecto de ese contrato, no una diferencia que se acepta.
//   5. Borra el fixture y las claves de Redis SIEMPRE (`afterAll`), aunque algo
//      falle. Si el borrado falla, el arnés se pone rojo.
//
// Sin base o sin Redis el arnés FALLA con un mensaje claro: nunca se salta en
// verde (la trampa de `queue.test.ts`, que "pasa" sin ejecutar una aserción si no
// hay Redis).
//
// Entorno:
//   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (de `.env.local` en local)
//   ARNES_SUPABASE_URL   opcional: pisa la URL de arriba. En local `.env.local`
//                        apunta a :8000 y el Kong real puede estar en otro puerto
//                        (`docker port supabase_kong_Liminal_CRM`, hoy 55321).
//   REDIS_URL            p. ej. redis://127.0.0.1:6379
//   ARNES_POSTGREST_URL  opcional: un PostgREST SIN Kong delante (p. ej. http://127.0.0.1:3000).
//                        Es lo que hay en el CI, donde `supabase db start` levanta solo Postgres:
//                        supabase-js pide `<URL>/rest/v1/…` y Kong quita ese prefijo; sin Kong, el
//                        arnés reescribe `<NEXT_PUBLIC_SUPABASE_URL>/rest/v1/` a `<ARNES_POSTGREST_URL>/`.
//                        Las rutas son las mismas, solo cambia el camino hasta PostgREST.
//   ARNES_DB_URL         cómo llega psql a Postgres como postgres, p. ej.
//                        postgresql://postgres:postgres@127.0.0.1:54322/postgres
//                        (lo que usa el CI). Sin ella, en local, se entra por
//                        `docker exec -i <ARNES_DB_CONTAINER> psql -U postgres`
//                        (contenedor por defecto: supabase_db_Liminal_CRM).
//
// Local:   ARNES_SUPABASE_URL=http://127.0.0.1:55321 npm run test:arnes
// CI:      job `migraciones` de .github/workflows/ci.yml.
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/bcv", () => ({
  getBcvRate: vi.fn(async () => ({ rate: 40, isStale: false })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { getRedis } from "@/lib/redis";
import { buildCatalogTool, type CatalogOutcome } from "@/lib/ai/tools";
import { CATALOGO_A2 } from "@/lib/ai/__fixtures__/catalogo-a2";
import { CASOS_A2, type CasoA2, type LlamadaA2 } from "@/lib/ai/__fixtures__/casos-a2";
import { SINONIMOS_M4 } from "@/lib/ai/__fixtures__/simulador-sql-a2";
import { nuevoCatalogOutcome, verificarEsperadoA2 } from "@/lib/ai/__fixtures__/verificar-caso-a2";
import { armarSqlBorrado, armarSqlCarga } from "./fixture-a2-sql";

type Cliente = ReturnType<typeof createAdminClient>;

let supabase: Cliente;
/** Las conversaciones (uuid) que este arnés usó: sus claves de Redis se borran al final. */
const conversacionesUsadas: string[] = [];
let fixtureCargado = false;
/** Lo que cada caso dio: alimenta el veredicto final «cero casos peor». */
const resultados = new Map<string, "ok" | "fallo">();

// ---------------------------------------------------------------------------
// psql como postgres
// ---------------------------------------------------------------------------

function psql(sql: string): string {
  const url = process.env.ARNES_DB_URL;
  const [comando, args] = url
    ? (["psql", [url, "-v", "ON_ERROR_STOP=1", "-1", "-tA", "-f", "-"]] as const)
    : ([
        "docker",
        [
          "exec",
          "-i",
          process.env.ARNES_DB_CONTAINER ?? "supabase_db_Liminal_CRM",
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-1",
          "-tA",
          "-f",
          "-",
        ],
      ] as const);

  const r = spawnSync(comando, [...args], { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    throw new Error(
      `Arnés: no se pudo ejecutar «${comando}» (${r.error.message}). Sin psql como postgres no se puede cargar el fixture: ` +
        `define ARNES_DB_URL (postgresql://postgres:…@host:puerto/postgres) o levanta el contenedor de la base local.`
    );
  }
  if (r.status !== 0) {
    throw new Error(`Arnés: psql terminó con código ${r.status}.\n${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function contarFixture(): number {
  const salida = psql("select count(*) from public.products where description like 'A2FIX-%';");
  return Number(salida.trim().split("\n").pop());
}

// ---------------------------------------------------------------------------
// Preparación y limpieza
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // (1) Variables de entorno: nombradas, para que el mensaje diga QUÉ falta.
  if (process.env.ARNES_SUPABASE_URL) process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.ARNES_SUPABASE_URL;
  const faltan = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "REDIS_URL"].filter((n) => !process.env[n]);
  if (faltan.length > 0) {
    throw new Error(
      `Arnés del catálogo: faltan variables de entorno (${faltan.join(", ")}). ` +
        `Ver la cabecera de scripts/arnes-catalogo-a2.test.ts. Este arnés NO se salta: sin la base y Redis reales no prueba nada.`
    );
  }

  // (1b) PostgREST directo (CI): reescribe la ruta que Kong quitaría. Se instala ANTES de crear el
  //      cliente admin porque `createAdminClient` captura el `fetch` global en ese momento.
  const postgrest = process.env.ARNES_POSTGREST_URL;
  if (postgrest) {
    const prefijo = `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, "")}/rest/v1/`;
    const destino = `${postgrest.replace(/\/$/, "")}/`;
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = ((entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
      return url.startsWith(prefijo)
        ? fetchOriginal(destino + url.slice(prefijo.length), init)
        : fetchOriginal(entrada, init);
    }) as typeof fetch;
  }

  // (2) Redis real.
  try {
    const pong = await getRedis().ping();
    if (pong !== "PONG") throw new Error(`respondió ${pong}`);
  } catch (err) {
    throw new Error(
      `Arnés del catálogo: Redis no responde en REDIS_URL (${process.env.REDIS_URL}): ${err instanceof Error ? err.message : String(err)}. ` +
        `Levantarlo: docker run -d --name sbk_redis -p 6379:6379 redis:7-alpine redis-server --appendonly yes`
    );
  }

  // (3) La base, por el mismo camino que usa la aplicación (PostgREST con la service role),
  //     y que la migración de la búsqueda (M1) y los sinónimos de M4 estén aplicados.
  supabase = createAdminClient();
  const sonda = await supabase.from("ai_lessons").select("synonym_from, synonym_to, scope, kind, is_active").eq("kind", "sinonimo").eq("is_active", true);
  if (sonda.error) {
    throw new Error(
      `Arnés del catálogo: la base no responde por PostgREST en ${process.env.NEXT_PUBLIC_SUPABASE_URL}: ${sonda.error.message}. ` +
        `En local, el Kong real puede no estar en el puerto de .env.local: define ARNES_SUPABASE_URL (docker port supabase_kong_Liminal_CRM).`
    );
  }
  const globales = new Set((sonda.data ?? []).filter((s) => s.scope === "global").map((s) => `${s.synonym_from}->${s.synonym_to}`));
  const sinM4 = SINONIMOS_M4.filter((s) => !globales.has(`${s.from}->${s.to}`));
  if (sinM4.length > 0) {
    throw new Error(
      `Arnés del catálogo: faltan sinónimos globales de la migración M4 (20260930040000) en ai_lessons: ${sinM4
        .map((s) => `${s.from}->${s.to}`)
        .join(", ")}. ¿Está aplicada la migración?`
    );
  }
  const extra = globales.size - SINONIMOS_M4.length;
  if (extra > 0) {
    console.warn(`Arnés del catálogo: hay ${extra} sinónimo(s) global(es) además de los de M4; pueden mover el resultado de un caso.`);
  }

  // (4) El fixture. La carga empieza borrando cualquier carga anterior (idempotente).
  psql(armarSqlCarga(CATALOGO_A2));
  fixtureCargado = true;
  const cargados = contarFixture();
  if (cargados !== CATALOGO_A2.length) {
    throw new Error(`Arnés del catálogo: se esperaban ${CATALOGO_A2.length} productos del fixture y hay ${cargados}.`);
  }
});

afterAll(async () => {
  // SIEMPRE: aunque un caso falle o la preparación haya quedado a medias.
  const problemas: string[] = [];

  try {
    psql(armarSqlBorrado());
    if (contarFixture() !== 0) problemas.push("el fixture NO quedó borrado de products");
  } catch (err) {
    problemas.push(`no se pudo borrar el fixture: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const redis = getRedis();
    if (conversacionesUsadas.length > 0) await redis.del(...conversacionesUsadas.map((id) => `catalogo:pedido:${id}`));
    await redis.quit();
  } catch (err) {
    problemas.push(`no se pudieron limpiar las claves de Redis: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (fixtureCargado || problemas.length > 0) {
    const ok = [...resultados.values()].filter((r) => r === "ok").length;
    const fallos = [...resultados.values()].filter((r) => r === "fallo").length;
    console.info(`Arnés del catálogo A2: ${resultados.size} casos, ${ok} en verde, ${fallos} peor. Fixture borrado y Redis limpio.`);
  }
  if (problemas.length > 0) throw new Error(`Arnés del catálogo: limpieza incompleta:\n- ${problemas.join("\n- ")}`);
});

// ---------------------------------------------------------------------------
// Los casos
// ---------------------------------------------------------------------------

async function correrLlamada(conversationId: string, llamada: LlamadaA2, rafaga: string[] | undefined): Promise<CatalogOutcome> {
  const outcome = nuevoCatalogOutcome();
  const tool = buildCatalogTool(
    { supabase, conversationId, contactId: randomUUID(), rafagaCliente: rafaga },
    outcome
  );
  // `execute` lo llama el SDK de IA con (input, opciones); acá solo importa el input.
  // @ts-expect-error -- firma simplificada, igual que en tools.test.ts
  await tool.execute({ ...llamada }, { toolCallId: "arnes", messages: [] });
  return outcome;
}

describe("arnés del catálogo A2: buildCatalogTool real, base real y Redis real", () => {
  it("el fixture está cargado (301 productos, todos con el prefijo A2FIX-)", () => {
    expect(contarFixture()).toBe(CATALOGO_A2.length);
  });

  it.each(CASOS_A2.map((c) => [c.id, c] as const))("%s", async (_id, caso: CasoA2) => {
    // Un uuid por caso: la memoria del pedido de Redis (`catalogo:pedido:<id>`) es POR conversación y
    // un caso no puede heredar la del anterior. Tiene que ser un uuid de verdad: `ai_lessons.conversation_id`
    // se filtra con `.eq.<id>` y un texto cualquiera daría un 400 que la herramienta tragaría en silencio.
    const conversationId = randomUUID();
    conversacionesUsadas.push(conversationId);

    try {
      if (caso.turnoPrevio) {
        const previo = await correrLlamada(conversationId, caso.turnoPrevio.llamada, caso.turnoPrevio.rafagaCliente);
        verificarEsperadoA2(caso.turnoPrevio.esperado, previo, `${caso.id} (turno previo)`);

        const raw = await getRedis().get(`catalogo:pedido:${conversationId}`);
        const memoria = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
        const m = caso.turnoPrevio.memoria;
        expect(memoria?.ultimoQuery, `${caso.id}: memoria.ultimoQuery`).toBe(m.ultimoQuery);
        expect(memoria?.preguntaHechaPara, `${caso.id}: memoria.preguntaHechaPara`).toBe(m.preguntaHechaPara);
        expect(memoria?.preguntaTipo, `${caso.id}: memoria.preguntaTipo`).toBe(m.preguntaTipo);
        const motoGuardada = ((memoria?.moto ?? []) as string[][]).map((g) => g[0]);
        expect(motoGuardada, `${caso.id}: memoria.moto`).toEqual(m.moto);
        const anioGuardado = ((memoria?.anio ?? []) as string[][])[0]?.[0] ?? null;
        expect(anioGuardado, `${caso.id}: memoria.anio`).toBe(m.anio);
      }

      const outcome = await correrLlamada(conversationId, caso.llamada, caso.rafagaCliente);
      verificarEsperadoA2(caso.esperado, outcome, caso.id);
      resultados.set(caso.id, "ok");
    } catch (err) {
      resultados.set(caso.id, "fallo");
      throw err;
    }
  });

  it("cero casos peor: todos los casos de casos-a2.ts dieron lo esperado", () => {
    const peor = CASOS_A2.filter((c) => resultados.get(c.id) !== "ok").map((c) => c.id);
    const deliberados = CASOS_A2.filter((c) => c.cambioDeliberado !== undefined).length;
    console.info(
      `Arnés del catálogo A2: ${CASOS_A2.length} casos, ${CASOS_A2.length - peor.length} en verde, ${peor.length} peor ` +
        `(${deliberados} llevan un cambio deliberado ya reflejado en su expectativa).`
    );
    expect(peor, `casos peor que lo esperado: ${peor.join(", ")}`).toEqual([]);
  });
});
