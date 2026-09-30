import path from "path";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

/**
 * Config del ARNÉS del catálogo (A2 T7, 30/9/2026, plan "Seba no cotiza lo que
 * no es"): `scripts/arnes-catalogo-a2.test.ts` corre el `buildCatalogTool` REAL
 * contra la base y el Redis REALES, no contra un fake. Por eso NO forma parte de
 * la suite normal (`vitest.config.ts` lo excluye): sin base ni Redis no tiene
 * nada que decir, y con ellos toca la tabla `products` (carga y borra un
 * fixture). Se corre con `npm run test:arnes` (ver la cabecera del archivo del
 * arnés para las variables de entorno).
 *
 * Sin `setupFiles` (nada de jsdom ni jest-dom), sin paralelismo (un solo
 * archivo, un solo cliente de Redis) y con presupuestos de reloj pensados para
 * llamadas de red de verdad.
 */
export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    include: ["scripts/arnes-catalogo-a2.test.ts"],
    fileParallelism: false,
    globals: true,
    // Cada caso hace de 1 a ~8 llamadas a PostgREST (y, en los de dos turnos,
    // a Redis); la carga del fixture y la preparación cuestan más.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // `.env.local` (Supabase, service role, REDIS_URL) para la corrida en
    // local; en el CI las variables ya vienen del entorno del paso.
    env: loadEnv(mode, process.cwd(), ""),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
    },
  },
}));
