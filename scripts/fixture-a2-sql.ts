// ---------------------------------------------------------------------------
// Genera el SQL que carga (y borra) el catálogo de prueba de la Entrega A2
// (30/9/2026, plan "Seba no cotiza lo que no es", T1).
//
//   npx tsx scripts/fixture-a2-sql.ts
//
// escribe, junto a este archivo:
//
//   scripts/sql/fixture-catalogo-a2.sql         carga (borra antes cualquier carga anterior)
//   scripts/sql/fixture-catalogo-a2-borrar.sql  borrado
//
// y se corren con psql COMO postgres, porque `products` es de solo lectura para
// la app (CLAUDE.md, "products es de solo lectura…", migración 20260925010000:
// el trigger BEFORE deja pasar únicamente a postgres y supabase_admin):
//
//   docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres \
//     -v ON_ERROR_STOP=1 -1 -f - < scripts/sql/fixture-catalogo-a2.sql
//
// Decisiones:
//
//   - El código `A2FIX-####` viaja en `description`, NO en `saint_code`. Una
//     fila con `saint_code` está "vinculada" a Saint: donde exista una fuente
//     (`saint.saprod`/`public.saprod`), `saint.sync_products()` la daría de baja
//     por ausencia al minuto de cargarla. Con `saint_code = null` el cron nunca
//     la toca. El costo: la base no garantiza unicidad del código; por eso la
//     carga empieza borrando cualquier carga anterior (idempotente).
//   - Un solo INSERT multi-fila, en el orden del catálogo: el ruido primero, así
//     el orden físico de inserción no favorece a las filas correctas (CLAUDE.md,
//     "Un test SQL de orden tiene que insertar el ruido ANTES que la fila
//     correcta").
//   - Sin `begin`/`commit` propios: `psql -1` abre la transacción; una carga
//     que falla a mitad no deja nada.
//   - Este archivo es la ÚNICA fuente: no se edita el .sql a mano.
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATALOGO_A2, PREFIJO_CODIGO_A2, type ProductoA2 } from "../src/lib/ai/__fixtures__/catalogo-a2";

const CABECERA = `-- GENERADO por scripts/fixture-a2-sql.ts -- no editar a mano.
-- Catalogo de prueba de la Entrega A2 ("Seba no cotiza lo que no es").
-- Correr con psql como postgres (products es de solo lectura para la app):
--   docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 -f - < <este archivo>
-- No abre transaccion propia: psql -1 la abre.
`;

/** Un literal de texto de SQL: comillas simples duplicadas. */
function literal(texto: string): string {
  return `'${texto.replace(/'/g, "''")}'`;
}

/** El borrado de las filas del fixture (y solo ellas: las reconoce el prefijo en `description`). */
const BORRAR = `delete from public.products where description like '${PREFIJO_CODIGO_A2}%';`;

export function armarSqlBorrado(): string {
  return `${CABECERA}
${BORRAR}
`;
}

export function armarSqlCarga(productos: readonly ProductoA2[]): string {
  const filas = productos.map(
    (p) =>
      `  (${literal(p.nombre)}, null, ${p.precioBs.toFixed(2)}, ${literal(p.currency)}, ${p.stock}, ${literal(
        `${p.codigo} - fixture del arnes A2 (no es Saint)`
      )}, true)`
  );

  return `${CABECERA}
-- Una carga anterior se borra primero: correr esto dos veces no duplica nada.
${BORRAR}

-- ${productos.length} productos. El ruido va PRIMERO (orden fisico de insercion).
insert into public.products (name, brand, price, currency, stock_quantity, description, is_active) values
${filas.join(",\n")};
`;
}

function main(): void {
  const carpetaSql = join(dirname(process.argv[1] ?? "."), "sql");
  mkdirSync(carpetaSql, { recursive: true });
  writeFileSync(join(carpetaSql, "fixture-catalogo-a2.sql"), armarSqlCarga(CATALOGO_A2), "utf8");
  writeFileSync(join(carpetaSql, "fixture-catalogo-a2-borrar.sql"), armarSqlBorrado(), "utf8");
  console.log(`fixture A2: ${CATALOGO_A2.length} productos -> ${carpetaSql}`);
}

// Solo corre como script (`npx tsx scripts/fixture-a2-sql.ts`), no al importarlo desde un test.
if ((process.argv[1] ?? "").replace(/\\/g, "/").endsWith("scripts/fixture-a2-sql.ts")) main();
