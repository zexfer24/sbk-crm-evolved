// Prueba de scripts/verificar-respaldo.sh invocando el script real con
// `bash` (Git Bash en Windows, bash normal en Linux/CI): es la única forma
// de probar el aislamiento del `pipefail` sin reescribir la lógica en TS.
//
// El caso "respaldo grande" reproduce el bug del 29/8/2026 de scripts/
// backup.sh: `grep -q "CREATE TABLE"` corta la tubería en cuanto encuentra
// la primera coincidencia, y si el volcado descomprimido es más grande que
// el buffer de la tubería del sistema (64 KB), `gzip` todavía está
// escribiendo cuando `grep` cierra y muere de SIGPIPE. Con la base chica del
// día a día el volcado entero cabía en esos 64 KB y el bug no se veía; por
// eso acá se genera un volcado de varios MB a propósito, con "CREATE TABLE"
// en la primera línea para que `grep` pueda cortar bien temprano.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";

const SCRIPT = path.join(__dirname, "verificar-respaldo.sh");

// bash debería estar disponible en cualquier entorno donde corre esta suite
// (los demás scripts del repo ya lo asumen), pero se verifica antes de
// correr en vez de asumirlo a ciegas.
const bash = spawnSync("bash", ["--version"]);
const bashDisponible = bash.error === undefined && bash.status === 0;

function correrVerificador(args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf-8" });
}

describe.skipIf(!bashDisponible)("scripts/verificar-respaldo.sh", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sbk-verificar-respaldo-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acepta un respaldo grande de verdad con CREATE TABLE al principio (el caso que reproduce el bug del 29/8/2026)", () => {
    // ~8 MB descomprimidos, muy por encima del buffer de 64 KB de la
    // tubería, con la línea que `grep` busca de primera para que corte la
    // tubería lo antes posible.
    const primeraLinea =
      "CREATE TABLE public.mensajes (id bigint, texto text);\n";
    const lineaRelleno = "-- relleno " + "x".repeat(180) + "\n";
    const CANTIDAD_LINEAS = 40_000;
    const sql = primeraLinea + lineaRelleno.repeat(CANTIDAD_LINEAS);
    expect(sql.length).toBeGreaterThan(8 * 1024 * 1024 * 0.9);

    const archivo = path.join(dir, "grande.sql.gz");
    writeFileSync(archivo, gzipSync(Buffer.from(sql, "utf-8")));

    const r = correrVerificador([archivo]);

    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(archivo)).toBe(true);
  });

  it("rechaza un archivo que no es gzip válido, sin borrarlo", () => {
    const archivo = path.join(dir, "corrupto.sql.gz");
    writeFileSync(
      archivo,
      Buffer.from("esto no es gzip, es basura\n".repeat(100)),
    );

    const r = correrVerificador([archivo]);

    expect(r.status).not.toBe(0);
    expect(existsSync(archivo)).toBe(true);
  });

  it("rechaza un archivo vacío, sin borrarlo", () => {
    const archivo = path.join(dir, "vacio.sql.gz");
    writeFileSync(archivo, Buffer.alloc(0));

    const r = correrVerificador([archivo]);

    expect(r.status).not.toBe(0);
    expect(existsSync(archivo)).toBe(true);
  });

  it("rechaza un gzip válido y de tamaño suficiente pero sin CREATE TABLE, sin borrarlo", () => {
    // Relleno con bytes al azar para que no comprima por debajo del tamaño
    // mínimo y termine cayendo en el chequeo de tamaño en vez del de
    // contenido, que es el que se quiere ejercitar acá.
    const relleno = randomBytes(4000).toString("hex");
    // Ojo: el comentario de abajo evita a propósito la cadena literal que
    // busca el verificador — usarla acá haría pasar la prueba por error.
    const sql = "-- volcado sin definiciones de esquema\n" + relleno + "\n";
    const archivo = path.join(dir, "sin-tablas.sql.gz");
    writeFileSync(archivo, gzipSync(Buffer.from(sql, "utf-8")));

    const r = correrVerificador([archivo]);

    expect(r.status).not.toBe(0);
    expect(existsSync(archivo)).toBe(true);
  });

  it("rechaza un archivo que no llega al tamaño mínimo, sin borrarlo", () => {
    const archivo = path.join(dir, "chico.sql.gz");
    writeFileSync(
      archivo,
      gzipSync(Buffer.from("CREATE TABLE x (id int);\n")),
    );

    const r = correrVerificador([archivo]);

    expect(r.status).not.toBe(0);
    expect(existsSync(archivo)).toBe(true);
  });

  it("falla con un mensaje de uso si no se le pasa ningún archivo", () => {
    const r = correrVerificador([]);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Uso:/);
  });

  it("falla si el archivo no existe", () => {
    const r = correrVerificador([path.join(dir, "no-existe.sql.gz")]);

    expect(r.status).not.toBe(0);
  });
});
