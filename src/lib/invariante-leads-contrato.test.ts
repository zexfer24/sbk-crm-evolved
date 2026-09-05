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

  /**
   * T2.1 (5/9/2026): un asesor cerró la conversación y el cliente volvió a
   * escribir con la IA apagada en ese chat. El webhook la reabre sola y deja
   * `reabierta_por_cliente` con destino `unassigned` (ver
   * webhooks/whatsapp/route.ts) por ENCIMA del `closed` que dejó el cierre —
   * el traspaso más reciente manda, igual que en el caso 2. Pasar por
   * `closed` en el medio no blinda a la conversación de contar como sin
   * dueño: es el mismo caso 6 de `invariante_leads.sql`.
   */
  it("caso 6 · cerrada y el cliente volvió con la IA apagada: CUENTA", () => {
    expect(
      isUnassignedLead(true, [traspaso("closed", 180), traspaso("unassigned", 10)])
    ).toBe(true);
  });

  /**
   * Caso 7 (anexo A1, 5/9/2026): la IA escaló sin asesores disponibles y se
   * despidió con el mensaje de cortesía. Ese mensaje sale con
   * `is_auto_reply = true` (misma marca que la bienvenida automática, T0.1),
   * así que el trigger `handle_new_message` NO lo cuenta como respuesta
   * real: `awaiting_reply` se queda en `true` — el `true` del primer
   * argumento acá abajo es exactamente ese hecho — y el traspaso más
   * reciente sigue siendo `unassigned`/`escalada_sin_asesor`, que deja
   * `escalate.ts` desde T0.3.
   */
  it("caso 7 · escalada sin asesores y la IA se despidió con is_auto_reply: CUENTA", () => {
    expect(isUnassignedLead(true, [traspaso("unassigned", 9)])).toBe(true);
  });

  /**
   * Caso 8 (anexo A2, 5/9/2026): la misma historia del caso 6 —cerrada por un
   * asesor, el cliente vuelve a escribir— pero acá el chat SÍ tenía asesor
   * asignado. El webhook ahora deja `reabierta_por_cliente` con destino
   * `human`, no `unassigned` (ver `webhooks/whatsapp/route.ts`): sigue
   * teniendo dueño, pasar por `closed` en el medio no cambia eso.
   */
  it("caso 8 · cerrada, el cliente volvió y la conversación tenía asesor: NO CUENTA", () => {
    expect(
      isUnassignedLead(true, [traspaso("closed", 180), traspaso("human", 10)])
    ).toBe(false);
  });
});
