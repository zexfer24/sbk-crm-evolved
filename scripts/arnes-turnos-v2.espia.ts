// ---------------------------------------------------------------------------
// El ESPÍA de solo lectura del arnés de turnos de Seba v2 (17/11/2026).
//
// El Claude del VPS corre este arnés contra la base de PRODUCCIÓN: no puede
// escribir NADA, ni siquiera por descuido de una herramienta que mañana alguien
// cambie. Por eso el cliente de Supabase que recibe el turno es un `Proxy` sobre
// el real que LANZA ante cualquier escritura (`insert`, `update`, `upsert`,
// `delete`, una `rpc` fuera de la lista corta, y las escrituras de Storage) y
// cuenta los intentos: el arnés exige al final que sean 0. Que el turno use
// `persistencia: "ninguna"` y efectos de memoria es la primera barrera; esta es
// la segunda, independiente de lo que el código del turno haga hoy.
//
// Módulo PURO (sin `server-only`, sin red propia): se prueba en la suite normal
// con un cliente falso.
// ---------------------------------------------------------------------------

/**
 * Las únicas RPC que el arnés deja pasar: las que usa la BÚSQUEDA del catálogo
 * (`tools.ts` y `catalog-correction.ts`) y que solo leen. Cualquier otra —
 * `record_handoff`, `ai_turn_lock_acquire`, las de `agent_*`… — escribe o toma un
 * candado y tiene que reventar.
 */
export const RPC_DE_SOLO_LECTURA: readonly string[] = ["buscar_productos", "corregir_terminos", "diagnosticar_terminos"];

/** Los métodos de un constructor de consultas de PostgREST que escriben. */
const ESCRITURAS_DE_TABLA = new Set(["insert", "update", "upsert", "delete"]);

/** Los métodos de Storage que escriben o borran (`getPublicUrl`, `createSignedUrl` y `download` solo leen). */
const ESCRITURAS_DE_STORAGE = new Set([
  "upload",
  "update",
  "remove",
  "move",
  "copy",
  "createSignedUploadUrl",
  "uploadToSignedUrl",
]);

export interface EspiaDeSoloLectura<T extends object> {
  /** El cliente espiado: se le pasa al turno en lugar del real. */
  cliente: T;
  /** Cuántas escrituras se intentaron (todas lanzaron). */
  intentosDeEscritura(): number;
  /** Qué se intentó, en orden («insert en messages», «rpc record_handoff»…). */
  detalleDeIntentos(): string[];
}

export class EscrituraProhibidaError extends Error {
  constructor(que: string) {
    super(`El arnés no puede escribir: se intentó «${que}».`);
    this.name = "EscrituraProhibidaError";
  }
}

function esPromesa(valor: unknown): boolean {
  return valor instanceof Promise;
}

/**
 * Envuelve un objeto de la cadena de consultas (el constructor de `from(...)`, el de
 * `rpc(...)`, el de `storage.from(...)`). Todo lo que devuelve un método y sea un objeto
 * —el siguiente eslabón de la cadena— se vuelve a envolver; una promesa se deja tal cual
 * (ya es el resultado). Los métodos se llaman SIEMPRE sobre el objeto original, no sobre el
 * `Proxy`: el cliente de Supabase usa campos privados que un `this` equivocado no encuentra.
 */
function envolverCadena<T extends object>(
  objeto: T,
  escrituras: ReadonlySet<string>,
  descripcion: string,
  registrar: (que: string) => never
): T {
  return new Proxy(objeto, {
    get(destino, propiedad) {
      const valor = Reflect.get(destino, propiedad, destino) as unknown;
      if (typeof propiedad === "string" && escrituras.has(propiedad)) {
        return () => registrar(`${propiedad} en ${descripcion}`);
      }
      if (typeof valor !== "function") return valor;
      return (...args: unknown[]) => {
        const resultado = (valor as (...a: unknown[]) => unknown).apply(destino, args);
        if (resultado === null || typeof resultado !== "object" || esPromesa(resultado)) return resultado;
        return envolverCadena(resultado as object, escrituras, descripcion, registrar);
      };
    },
  });
}

/**
 * Envuelve un cliente de Supabase. Lo único que cambia respecto del real: `from` y `rpc`
 * devuelven versiones espiadas, y `storage.from(bucket)` también. Todo lo demás (`auth`,
 * `functions`, `channel`…) pasa directo — el turno no lo usa.
 */
export function crearEspiaDeSoloLectura<T extends object>(
  clienteReal: T,
  opciones: { rpcPermitidas?: readonly string[] } = {}
): EspiaDeSoloLectura<T> {
  const rpcPermitidas = new Set(opciones.rpcPermitidas ?? RPC_DE_SOLO_LECTURA);
  const intentos: string[] = [];

  const registrar = (que: string): never => {
    intentos.push(que);
    throw new EscrituraProhibidaError(que);
  };

  const cliente = new Proxy(clienteReal, {
    get(destino, propiedad) {
      const valor = Reflect.get(destino, propiedad, destino) as unknown;

      if (propiedad === "from") {
        return (tabla: string) =>
          envolverCadena((valor as (t: string) => object).call(destino, tabla), ESCRITURAS_DE_TABLA, tabla, registrar);
      }

      if (propiedad === "rpc") {
        return (nombre: string, ...resto: unknown[]) => {
          if (!rpcPermitidas.has(nombre)) return registrar(`rpc ${nombre}`);
          return envolverCadena(
            (valor as (...a: unknown[]) => object).call(destino, nombre, ...resto),
            ESCRITURAS_DE_TABLA,
            `rpc ${nombre}`,
            registrar
          );
        };
      }

      if (propiedad === "storage" && valor !== null && typeof valor === "object") {
        return new Proxy(valor as object, {
          get(storage, metodo) {
            const hijo = Reflect.get(storage, metodo, storage) as unknown;
            if (metodo !== "from" || typeof hijo !== "function") return hijo;
            return (bucket: string) =>
              envolverCadena(
                (hijo as (b: string) => object).call(storage, bucket),
                ESCRITURAS_DE_STORAGE,
                `storage ${bucket}`,
                registrar
              );
          },
        });
      }

      return typeof valor === "function" ? (valor as (...a: unknown[]) => unknown).bind(destino) : valor;
    },
  });

  return {
    cliente,
    intentosDeEscritura: () => intentos.length,
    detalleDeIntentos: () => [...intentos],
  };
}

// ----------------------- La tasa BCV sin salir a la red ---------------------

/**
 * `buildCatalogTool` llama a `getBcvRate(supabase)` con el cliente que recibe, y
 * `getBcvRate` puede salir a la página del BCV y hacer un `upsert` en
 * `exchange_rates` (`src/lib/ai/bcv.ts`). Ni la red ni ese `upsert` caben en el arnés:
 * este envoltorio le contesta a las dos lecturas de `getBcvRate` con la tasa que el
 * arnés ya leyó de la base —y con un `fetched_at` de AHORA, para que la regla de
 * relectura por horario no toque la red—; cualquier otra tabla pasa al cliente de abajo
 * (el espía), y una escritura en `exchange_rates` también.
 */
export function conTasaFija<T extends object>(
  cliente: T,
  tasa: { usdAVes: number; fecha: string },
  ahora: () => Date = () => new Date()
): T {
  return new Proxy(cliente, {
    get(destino, propiedad) {
      const valor = Reflect.get(destino, propiedad, destino) as unknown;
      if (propiedad !== "from") return typeof valor === "function" ? (valor as (...a: unknown[]) => unknown).bind(destino) : valor;

      return (tabla: string) => {
        if (tabla !== "exchange_rates") return (valor as (t: string) => unknown).call(destino, tabla);

        let columnas = "";
        const fila = () =>
          columnas.includes("fetched_at")
            ? { fetched_at: ahora().toISOString() }
            : { rate_date: tasa.fecha, usd_to_ves: tasa.usdAVes };
        const lectura: Record<string, unknown> = {
          select(cols: string) {
            columnas = cols;
            return lectura;
          },
          order: () => lectura,
          limit: () => lectura,
          maybeSingle: async () => ({ data: fila(), error: null }),
        };
        // Cualquier escritura sobre la tabla de tasas pasa por el cliente de abajo (el espía), que la rechaza.
        const real = (valor as (t: string) => Record<string, unknown>).call(destino, tabla);
        for (const metodo of ESCRITURAS_DE_TABLA) lectura[metodo] = (...args: unknown[]) => (real[metodo] as (...a: unknown[]) => unknown)(...args);
        return lectura;
      };
    },
  });
}
