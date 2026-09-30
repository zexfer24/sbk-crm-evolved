import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El build de producción (Dockerfile de Dokploy) compila SIN lo que lista
 * `.dockerignore` —`scripts/`, `docs/`, `backups/`…—, pero `next build` corre
 * el chequeo de tipos sobre TODO `src/`, tests incluidos. Un import desde
 * `src/` hacia una de esas carpetas compila en local y en el CI (que tienen el
 * repo entero) y rompe solo el deploy. Pasó el 30/9/2026:
 * `casos-a2.test.ts` importaba `scripts/fixture-a2-sql` y Dokploy falló con
 * TS2307 mientras el CI estaba en verde.
 */

const raiz = resolve(__dirname, "../..");

function excluidosDelBuild(): string[] {
  return readFileSync(join(raiz, ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!") && !/[*]/.test(l))
    .map((l) => l.replace(/\/$/, ""));
}

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivosTs(ruta);
    return /\.(ts|tsx|mts)$/.test(nombre) ? [ruta] : [];
  });
}

describe(".dockerignore y los imports de src/", () => {
  it("ningún archivo de src/ importa algo que el build de Docker no copia", () => {
    const excluidos = excluidosDelBuild();
    expect(excluidos).toContain("scripts");

    const infracciones: string[] = [];
    for (const archivo of archivosTs(join(raiz, "src"))) {
      const texto = readFileSync(archivo, "utf8");
      for (const m of texto.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const destino = relative(raiz, resolve(dirname(archivo), m[1])).replace(/\\/g, "/");
        const primero = destino.split("/")[0];
        if (excluidos.includes(primero) || excluidos.includes(destino)) {
          infracciones.push(`${relative(raiz, archivo).replace(/\\/g, "/")} → ${m[1]}`);
        }
      }
    }
    expect(infracciones).toEqual([]);
  });
});
