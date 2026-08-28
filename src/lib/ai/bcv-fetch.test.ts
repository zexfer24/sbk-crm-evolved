// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36 as INTERMEDIO_BCV } from "@/lib/ai/bcv-intermediate-ca";

// ---------------------------------------------------------------------------
// Caracterización de bcv-fetch.ts, sin red.
//
// El módulo cachea las CAs en una variable de módulo (`cachedCa`), así que
// cada escenario necesita el módulo recién importado: `vi.resetModules()` en
// `beforeEach`, y dentro de cada test `vi.doMock("node:https" | "node:tls")`
// seguido de `import("@/lib/ai/bcv-fetch")` dinámico. Son módulos nativos con
// import por default (esModuleInterop): el mock tiene que traer tanto
// `default` como los exports nombrados, si no `import https from "node:https"`
// recibe `undefined` y todo revienta antes de llegar al escenario.
//
// El doble de ClientRequest es un EventEmitter con `end` y `destroy` propios.
// `destroy(err)` EMITE "error" con ese err, tal como hace el ClientRequest
// real: el módulo depende de eso para convertir el timeout en un reject vía
// `request.on("error", reject)`. Si el doble no lo emitiera, ese test se
// colgaría hasta que Vitest lo corte por su propio timeout, no por los 10 s
// simulados.
//
// La respuesta también es un EventEmitter (`statusCode`, `resume`, eventos
// `data`/`end`), disparado a mano desde el test — nunca por un temporizador
// real.
// ---------------------------------------------------------------------------

const URL_BCV = "https://www.bcv.org.ve/";

type RequestFalso = EventEmitter & {
  end: () => void;
  destroy: (err?: Error) => void;
};

type RespuestaFalsa = EventEmitter & {
  statusCode: number;
  resume: () => void;
};

function crearRequestFalso(): RequestFalso {
  const req = new EventEmitter() as RequestFalso;
  req.end = vi.fn();
  // El ClientRequest real dispara "error" cuando se lo destruye con una
  // causa; así es como el módulo se entera de que el timeout pasó.
  req.destroy = vi.fn((err?: Error) => {
    if (err) req.emit("error", err);
  });
  return req;
}

function crearRespuestaFalsa(statusCode: number): RespuestaFalsa {
  const res = new EventEmitter() as RespuestaFalsa;
  res.statusCode = statusCode;
  res.resume = vi.fn();
  return res;
}

/**
 * Monta el doble de `node:https`. El mock de `request` lanza si recibe una
 * URL que el test no pidió — ninguna prueba de este archivo debe poder
 * llegar a la red de verdad, ni siquiera por accidente.
 */
function mockearHttps() {
  let request: RequestFalso | undefined;
  let opciones: Record<string, unknown> | undefined;
  let callback: ((res: RespuestaFalsa) => void) | undefined;

  const requestMock = vi.fn(
    (url: string, opts: Record<string, unknown>, cb: (res: RespuestaFalsa) => void) => {
      if (url !== URL_BCV) {
        throw new Error(`Doble de node:https recibió una URL inesperada: ${url}`);
      }
      opciones = opts;
      callback = cb;
      request = crearRequestFalso();
      return request;
    }
  );

  vi.doMock("node:https", () => ({
    default: { request: requestMock },
    request: requestMock,
  }));

  return {
    requestMock,
    ultimoRequest: (): RequestFalso => {
      if (!request) throw new Error("https.request no fue llamado todavía");
      return request;
    },
    ultimasOpciones: (): Record<string, unknown> => {
      if (!opciones) throw new Error("https.request no fue llamado todavía");
      return opciones;
    },
    /** Invoca el callback de respuesta guardado por https.request(). */
    dispararRespuesta: (statusCode: number): RespuestaFalsa => {
      if (!callback) throw new Error("https.request no fue llamado todavía");
      const res = crearRespuestaFalsa(statusCode);
      callback(res);
      return res;
    },
  };
}

interface OpcionesTls {
  /** Raíces devueltas por store ("default" / "system"). Si se omite, getCACertificates lanza. */
  raicesPorStore?: Record<string, string[]>;
  /** Simula un runtime sin la función (Node < 22.15). */
  sinGetCACertificates?: boolean;
}

function mockearTls(opciones: OpcionesTls) {
  const getCACertificatesMock = vi.fn((store: string) => {
    if (!opciones.raicesPorStore) throw new Error("almacén de CAs no disponible");
    return opciones.raicesPorStore[store] ?? [];
  });

  vi.doMock("node:tls", () => {
    if (opciones.sinGetCACertificates) {
      // Sin la propiedad: `typeof tls.getCACertificates === "function"` da
      // false, igual que en un Node anterior a la 22.15.
      return { default: {} };
    }
    return {
      default: { getCACertificates: getCACertificatesMock },
      getCACertificates: getCACertificatesMock,
    };
  });

  return { getCACertificatesMock };
}

async function importarBcvFetch() {
  return await import("@/lib/ai/bcv-fetch");
}

beforeEach(() => {
  vi.resetModules();
});

describe("fetchBcvHtml", () => {
  it("manda el intermedio del BCV junto con las raíces del almacén", async () => {
    mockearTls({ raicesPorStore: { default: ["RAIZ_DEFAULT"], system: ["RAIZ_SYSTEM"] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);

    expect(https.ultimasOpciones().ca).toEqual(["RAIZ_DEFAULT", "RAIZ_SYSTEM", INTERMEDIO_BCV]);
  });

  it("si el almacén de CAs no se puede leer, ca queda solo con el intermedio", async () => {
    mockearTls({}); // sin raicesPorStore -> getCACertificates lanza (camino safeStores)
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);

    expect(https.ultimasOpciones().ca).toEqual([INTERMEDIO_BCV]);
  });

  it("en un runtime sin getCACertificates, ca también queda solo con el intermedio", async () => {
    mockearTls({ sinGetCACertificates: true });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);

    expect(https.ultimasOpciones().ca).toEqual([INTERMEDIO_BCV]);
  });

  it("nunca desactiva la verificación del certificado (rejectUnauthorized no es false)", async () => {
    mockearTls({ raicesPorStore: { default: [], system: [] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);

    expect(https.ultimasOpciones().rejectUnauthorized).not.toBe(false);
  });

  it("arma el cuerpo UTF-8 aunque un carácter multibyte quede partido entre dos chunks", async () => {
    mockearTls({ raicesPorStore: { default: [], system: [] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    const promesa = fetchBcvHtml(URL_BCV);
    const res = https.dispararRespuesta(200);

    // "Bolívar" en UTF-8: la í son los bytes 0xC3 0xAD. Se corta el buffer
    // justo en medio de ese carácter para probar que la unión se hace sobre
    // bytes (Buffer.concat) y no sobre texto ya decodificado a medias chunk
    // por chunk, que rompería el carácter partido.
    const cuerpo = Buffer.from("Precio del Bolívar hoy", "utf8");
    const puntoDeCorte = cuerpo.indexOf(0xc3) + 1; // justo después del primer byte de "í"
    res.emit("data", cuerpo.subarray(0, puntoDeCorte));
    res.emit("data", cuerpo.subarray(puntoDeCorte));
    res.emit("end");

    await expect(promesa).resolves.toBe("Precio del Bolívar hoy");
  });

  it("con estado 500 rechaza mencionando el código y consume la respuesta", async () => {
    mockearTls({ raicesPorStore: { default: [], system: [] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    const promesa = fetchBcvHtml(URL_BCV);
    const res = https.dispararRespuesta(500);

    await expect(promesa).rejects.toThrow(/500/);
    expect(res.resume).toHaveBeenCalledTimes(1);
  });

  it("si se cumple el timeout, rechaza mencionando los segundos y destruye la petición", async () => {
    mockearTls({ raicesPorStore: { default: [], system: [] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    const promesa = fetchBcvHtml(URL_BCV);
    const req = https.ultimoRequest();
    req.emit("timeout");

    await expect(promesa).rejects.toThrow(/10 s/);
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  it("un error de socket (cadena sin verificar) se propaga sin tragarse", async () => {
    mockearTls({ raicesPorStore: { default: [], system: [] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    const promesa = fetchBcvHtml(URL_BCV);
    const req = https.ultimoRequest();
    const errorDeSocket = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    req.emit("error", errorDeSocket);

    await expect(promesa).rejects.toBe(errorDeSocket);
  });

  it("manda el User-Agent y el timeout de producción", async () => {
    mockearTls({ raicesPorStore: { default: [], system: [] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);

    const opciones = https.ultimasOpciones();
    expect(opciones.headers).toEqual({ "User-Agent": "Mozilla/5.0 (compatible; SbkMotorcyclesCRM/1.0)" });
    expect(opciones.timeout).toBe(10_000);
  });

  it("lee el almacén de CAs una sola vez aunque se pidan dos páginas", async () => {
    const { getCACertificatesMock } = mockearTls({
      raicesPorStore: { default: ["R"], system: ["S"] },
    });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);
    const res1 = https.dispararRespuesta(200);
    res1.emit("data", Buffer.from("uno"));
    res1.emit("end");

    fetchBcvHtml(URL_BCV);
    const res2 = https.dispararRespuesta(200);
    res2.emit("data", Buffer.from("dos"));
    res2.emit("end");

    // Dos páginas pedidas, pero getCACertificates solo se llama para
    // "default" y "system" en la primera: cachedCa evita releer el almacén.
    expect(getCACertificatesMock).toHaveBeenCalledTimes(2);
  });
});
