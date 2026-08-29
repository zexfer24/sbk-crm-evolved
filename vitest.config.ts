import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    // 29/8/2026: el include de fábrica del plugin es /\.[tj]sx?$/ — pasaba por
    // Babel todo .ts del grafo, incluidos los ~62 archivos de test de entorno
    // node y el grueso de src/lib, que no pueden contener JSX. Ese costo se
    // paga en el cuello de transformación que comparte toda la suite. esbuild
    // sigue compilando el TypeScript plano; Babel queda solo donde puede haber
    // JSX. Este config no afecta a `next dev/build`.
    react({ include: /\.[tj]sx$/ }),
  ],
  test: {
    // 28/8/2026: de los ~79 archivos de test solo ~19 tocan el DOM; los demás
    // construían un jsdom que nunca usaban, pagando su costo de CPU en cada
    // proceso del pool de forks. El default pasa a "node" y las pruebas que
    // sí necesitan DOM lo declaran explícitamente con
    // `/** @vitest-environment jsdom */` como primera línea del archivo.
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    css: false,
    // 28/8/2026: con pool "forks" + isolate true (los defaults), cada archivo
    // corre en un proceso aislado con su propio jsdom, y en Windows de 8
    // núcleos hasta 7 corren a la vez compitiendo por CPU. Los 5000ms por
    // defecto alcanzan cuando la máquina está libre, pero expiran en los
    // archivos caros en cuanto hay carga real (no es una regresión del test,
    // es contención). Subimos el presupuesto como red de seguridad sin tocar
    // el paralelismo, y bajamos el umbral de "lento" a 1s para que el
    // reporter haga visible la degradación en vez de que el margen la esconda.
    testTimeout: 15000,
    hookTimeout: 15000,
    slowTestThreshold: 1000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
    },
  },
});
