import path from "path";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

/**
 * Config del ARNÉS DE TURNOS de Seba v2 (17/11/2026, entrega 3 del rework):
 * `scripts/arnes-turnos-v2.test.ts` corre el turno REAL (`runSeba2Turn`) con el
 * modelo real contra una base real, sin escribir nada en ella. Por eso NO forma
 * parte de la suite normal (`vitest.config.ts` lo excluye): llama a un proveedor
 * de pago y necesita variables de entorno que la suite no tiene. Se corre con
 * `npm run test:arnes-turnos` (ver la cabecera del archivo del arnés para las
 * variables) y, sin ellas, se SALTA con un aviso en lugar de fallar.
 *
 * Calcado de `vitest.arnes.config.ts`: sin `setupFiles`, un solo archivo, sin
 * paralelismo. El presupuesto de reloj es el de una corrida de decenas de turnos
 * con llamadas al modelo (el tope por caso, 90 s, lo pone el propio arnés).
 */
export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    include: ["scripts/arnes-turnos-v2.test.ts"],
    fileParallelism: false,
    globals: true,
    // Un solo `it` corre todos los casos, de a uno: el tope de una hora cubre
    // cientos de turnos de hasta 90 s sin que el reloj de vitest los corte antes.
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    // `.env.local` para la corrida en local (llave del modelo, por ejemplo); en el
    // VPS las variables ya vienen del entorno.
    env: loadEnv(mode, process.cwd(), ""),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
    },
  },
}));
