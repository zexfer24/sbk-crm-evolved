// Arma el SQL que carga (y borra) el catálogo de prueba de la Entrega A2.
// Vive en src/ y no en scripts/ porque lo importa `casos-a2.test.ts`, y el
// build de Docker no copia scripts/ (.dockerignore): `next build` chequea los
// tipos de todo src/ y falló con TS2307 el 30/9/2026. El CLI que escribe los
// .sql sigue en `scripts/fixture-a2-sql.ts`.
import { PREFIJO_CODIGO_A2, type ProductoA2 } from "./catalogo-a2";

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
