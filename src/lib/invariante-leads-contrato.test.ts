import { describe, expect, it } from "vitest";
import { isUnassignedLead } from "@/lib/inbox-filters";

// ===========================================================================
// El contrato de "sin dueño": las dos implementaciones tienen que coincidir
//
// La invariante que gobierna la reforma (ver CLAUDE.md) se apoya, en la Etapa
// 1, en una sola pregunta: ¿esta conversación sigue esperando y quedó sin
// dueño? Esa pregunta se responde HOY en dos lugares distintos, en dos
// lenguajes distintos, y las dos respuestas están en producción:
//
//   1. `unassigned_waiting_count()` (SQL, migración 20260830040000) — es la
//      que informa `/api/health`, o sea el KPI que decide si la Etapa 2 del
//      plan arranca o si la reforma se revisa.
//   2. `isUnassignedLead` (TypeScript, inbox-filters.ts) — es la que arma la
//      píldora "Sin dueño" de la bandeja, o sea lo que ve el asesor.
//
// Si se separan, el tablero y la bandeja afirman cosas distintas sobre el
// mismo hecho, y nadie se entera hasta que alguien las compara a mano. No es
// una preocupación teórica: la ventana de 24 h de Meta ya tiene su propio
// archivo de contrato en este repo (`ventana-24h-contrato.test.ts`)
// precisamente porque sus dos patas se habían separado.
//
// Los cinco casos de acá abajo son los MISMOS, con los mismos nombres y en el
// mismo orden, que siembra `supabase/tests/invariante_leads.sql` — el que
// corre en el job `migraciones` de CI contra Postgres. Este archivo prueba la
// pata de TypeScript; aquel prueba la de SQL. Si alguien cambia una de las
// dos definiciones sin la otra, uno de los dos se pone rojo.
//
// AL AGREGAR UN CASO ACÁ, AGREGARLO ALLÁ TAMBIÉN (y al revés).
// ===========================================================================

/** Un traspaso, en la forma mínima que `isUnassignedLead` necesita. */
function traspaso(toKind: "ai" | "human" | "unassigned" | "closed", minutosAtras: number) {
  return { toKind, createdAt: new Date(Date.now() - minutosAtras * 60_000).toISOString() };
}

describe('contrato de "sin dueño" — los mismos casos que invariante_leads.sql', () => {
  it("caso 1 · soltada y nunca recuperada: CUENTA", () => {
    expect(isUnassignedLead(true, [traspaso("unassigned", 90)])).toBe(true);
  });

  /**
   * El caso que justifica todo este archivo y su gemelo en SQL.
   *
   * La forma natural de escribir el conteo —"¿tiene alguna fila
   * unassigned?"— acierta en los otros cuatro casos y falla justo en este. Y
   * no es un caso raro: el reconciliador escribe un `reabierto` encima de
   * TODO lo que rescata, así que con esa definición cada conversación
   * recuperada seguiría contando como perdida para siempre y el KPI solo
   * sabría subir. Medido el 30/8/2026 con estos mismos cinco casos: la
   * definición ingenua devuelve 3 donde la correcta devuelve 1.
   */
  it("caso 2 · soltada y DESPUÉS rescatada por el reconciliador: NO cuenta", () => {
    expect(
      isUnassignedLead(true, [traspaso("unassigned", 90), traspaso("ai", 30)])
    ).toBe(false);
  });

  it("caso 3 · soltada y después tomada por una persona: NO cuenta", () => {
    expect(
      isUnassignedLead(true, [traspaso("unassigned", 90), traspaso("human", 30)])
    ).toBe(false);
  });

  it("caso 4 · sin ninguna fila de bitácora: NO cuenta, nunca se soltó", () => {
    expect(isUnassignedLead(true, [])).toBe(false);
  });

  it("caso 5 · soltada, pero el asesor ya contestó: NO cuenta, no espera a nadie", () => {
    // `awaiting_reply` en false es exactamente lo que expresa la fila 5 del
    // archivo SQL poniéndole un `last_message_at` posterior al último mensaje
    // del cliente: alguien ya respondió.
    expect(isUnassignedLead(false, [traspaso("unassigned", 90)])).toBe(false);
  });

  /**
   * El orden de la lista no es el orden de la historia. La bitácora se
   * consulta ordenada, pero nada garantiza que siga ordenada al llegar acá
   * —ni PostgREST lo promete para una relación embebida—, así que lo que
   * decide es la FECHA, no la posición. Este caso es el mismo del 2 con el
   * array al revés: si alguien reemplazara `latestHandoff` por un
   * `handoffs.at(-1)`, acá se vería.
   */
  it("el veredicto no depende del orden del array, solo de la fecha", () => {
    expect(
      isUnassignedLead(true, [traspaso("ai", 30), traspaso("unassigned", 90)])
    ).toBe(false);
  });
});
