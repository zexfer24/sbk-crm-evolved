// @vitest-environment node
import { X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36 as DV_BCV,
  SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_OV_R36 as OV_BCV,
} from "@/lib/ai/bcv-intermediate-ca";

// ---------------------------------------------------------------------------
// Caracterización de bcv-fetch.ts, sin red.
//
// El módulo cachea las raíces en una variable de módulo, así que
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

// El log real escribe a stderr; acá se espía. `errorText` se reimplementa mínimo
// (el verdadero vive en lib/log.ts y tiene su propio test).
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({
  log: logMock,
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

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

// 29/8/2026: el primer test pagaba la transformación y carga en frío del
// grafo dentro de su propio presupuesto y bajo carga se quedaba sin tiempo.
// Este import solo calienta la caché de transformación (vi.resetModules la
// deja intacta); cada test sigue reevaluando el módulo con su propio doMock.
beforeAll(async () => {
  await import("@/lib/ai/bcv-fetch");
}, 30_000);

beforeEach(() => {
  vi.resetModules();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe("fetchBcvHtml", () => {
  it("manda los intermedios embebidos del BCV junto con las raíces del almacén", async () => {
    mockearTls({ raicesPorStore: { default: ["RAIZ_DEFAULT"], system: ["RAIZ_SYSTEM"] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);

    expect(https.ultimasOpciones().ca).toEqual(["RAIZ_DEFAULT", "RAIZ_SYSTEM", DV_BCV, OV_BCV]);
  });

  it("si el almacén de CAs no se puede leer, ca queda solo con los intermedios embebidos", async () => {
    mockearTls({}); // sin raicesPorStore -> getCACertificates lanza (camino safeStores)
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);

    expect(https.ultimasOpciones().ca).toEqual([DV_BCV, OV_BCV]);
  });

  it("en un runtime sin getCACertificates, ca también queda solo con los intermedios embebidos", async () => {
    mockearTls({ sinGetCACertificates: true });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    fetchBcvHtml(URL_BCV);

    expect(https.ultimasOpciones().ca).toEqual([DV_BCV, OV_BCV]);
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

  it("un error de cadena que no se puede armar por AIA lanza en español y conserva el error original", async () => {
    mockearTls({ raicesPorStore: { default: [], system: [] } });
    const https = mockearHttps();
    const { fetchBcvHtml } = await importarBcvFetch();

    const promesa = fetchBcvHtml(URL_BCV);
    const req = https.ultimoRequest();
    const errorDeSocket = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    req.emit("error", errorDeSocket);

    // El doble de node:tls de este bloque no trae `connect`: leer la hoja falla,
    // y eso tiene que salir como motivo, no como un TypeError suelto.
    const error = await promesa.then(
      () => null,
      (e: unknown) => e as Error & { cause?: unknown }
    );
    expect(error?.message).toMatch(/la cadena TLS no verifica \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\).*AIA/);
    expect(error?.cause).toBe(errorDeSocket);
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

// ---------------------------------------------------------------------------
// Armado de la cadena por AIA (21/11/2026). Aquí el doble de node:https /
// node:http / node:tls es AUTOMÁTICO: cada petición se resuelve sola en una
// microtarea según un guion, sin red. Los certificados son los de
// __fixtures__/bcv-certs (los genera scripts/generar-certs-prueba-bcv.sh).
// ---------------------------------------------------------------------------

const DIR_CERTS = join(__dirname, "__fixtures__", "bcv-certs");
const pem = (n: string) => readFileSync(join(DIR_CERTS, n), "utf8");
const x509 = (n: string) => new X509Certificate(readFileSync(join(DIR_CERTS, n)));
const RAIZ_PEM = pem("raiz.pem");
const HUELLA_INTERMEDIO = x509("intermedio.pem").fingerprint256;
const URL_AIA = "http://crt.sectigo.com/IntermedioPrueba.crt";

const errorDeCadena = () =>
  Object.assign(new Error("unable to verify the first certificate"), {
    code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  });

type Resultado = { error: Error } | { status: number; body: string };

type GuionAia = { status?: number; body?: Buffer; error?: Error; bytes?: number };

interface Entorno {
  /** Opciones de CADA llamada a https.request, en orden. */
  requestOpciones: Record<string, unknown>[];
  connectMock: ReturnType<typeof vi.fn>;
  httpGetMock: ReturnType<typeof vi.fn>;
  /** Huellas de los certificados que viajaron en `ca` de la llamada n (los que parsean). */
  huellasDeCa: (n: number) => string[];
}

let entornoActual: Entorno | undefined;

function huellas(ca: unknown): string[] {
  const salida: string[] = [];
  for (const c of (ca ?? []) as string[]) {
    try {
      salida.push(new X509Certificate(c).fingerprint256);
    } catch {
      // raíz falsa de un test: no parsea y no importa
    }
  }
  return salida;
}

/**
 * @param gets   guion de https.request: lo que devuelve la llamada n (0, 1, …)
 * @param hoja   certificado que entrega tls.connect (o un error de conexión)
 * @param aia    guion de http.get por URL
 */
function montar(opts: {
  gets: (n: number) => Resultado;
  hoja?: string | Error;
  aia?: Record<string, GuionAia>;
}): Entorno {
  const requestOpciones: Record<string, unknown>[] = [];
  const connect = vi.fn((conexion: Record<string, unknown>) => {
    void conexion;
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      getPeerCertificate: () => { raw: Buffer };
    };
    socket.destroy = vi.fn();
    const hoja = opts.hoja ?? "hoja.pem";
    socket.getPeerCertificate = () => ({ raw: x509(hoja as string).raw });
    queueMicrotask(() => {
      if (hoja instanceof Error) socket.emit("error", hoja);
      else socket.emit("secureConnect");
    });
    return socket;
  });
  const httpGet = vi.fn((url: string, o: unknown, cb: (r: RespuestaFalsa) => void) => {
    void o;
    const guion = opts.aia?.[url];
    if (!guion) throw new Error(`http.get inesperado: ${url}`);
    const req = crearRequestFalso();
    queueMicrotask(() => {
      if (guion.error) {
        req.emit("error", guion.error);
        return;
      }
      const res = crearRespuestaFalsa(guion.status ?? 200);
      cb(res);
      if (guion.bytes) res.emit("data", Buffer.alloc(guion.bytes, 1));
      else if (guion.body) res.emit("data", guion.body);
      res.emit("end");
    });
    return req;
  });

  vi.doMock("node:tls", () => {
    const getCACertificates = vi.fn(() => [RAIZ_PEM]);
    return { default: { getCACertificates, connect }, getCACertificates, connect };
  });

  vi.doMock("node:https", () => {
    const request = vi.fn((url: string, o: Record<string, unknown>, cb: (r: RespuestaFalsa) => void) => {
      void url;
      const n = requestOpciones.length;
      requestOpciones.push(o);
      const req = crearRequestFalso();
      req.end = vi.fn(() => {
        queueMicrotask(() => {
          const r = opts.gets(n);
          if ("error" in r) {
            req.emit("error", r.error);
            return;
          }
          const res = crearRespuestaFalsa(r.status);
          cb(res);
          res.emit("data", Buffer.from(r.body));
          res.emit("end");
        });
      });
      return req;
    });
    const get = vi.fn((url: string) => {
      throw new Error(`https.get inesperado: ${url}`);
    });
    return { default: { request, get }, request, get };
  });

  vi.doMock("node:http", () => ({ default: { get: httpGet }, get: httpGet }));

  const entorno: Entorno = {
    requestOpciones,
    connectMock: connect,
    httpGetMock: httpGet,
    huellasDeCa: (n) => huellas(requestOpciones[n]?.ca),
  };
  entornoActual = entorno;
  return entorno;
}

afterEach(() => {
  // Regla de oro: el GET de la tasa NUNCA baja la verificación, pase lo que pase.
  for (const o of entornoActual?.requestOpciones ?? []) {
    expect(o.rejectUnauthorized).not.toBe(false);
    expect(o).not.toHaveProperty("checkServerIdentity");
  }
  entornoActual = undefined;
  vi.useRealTimers();
});

const OK: Resultado = { status: 200, body: "<html>tasa</html>" };
const DER_BUENO = readFileSync(join(DIR_CERTS, "intermedio.der"));

describe("fetchBcvHtml: cadena armada por AIA", () => {
  it("si el primer GET anda, no lee la hoja ni baja nada, y ofrece DV y OV", async () => {
    const e = montar({ gets: () => OK });
    const { fetchBcvHtml } = await importarBcvFetch();

    await expect(fetchBcvHtml(URL_BCV)).resolves.toBe("<html>tasa</html>");

    expect(e.connectMock).not.toHaveBeenCalled();
    expect(e.httpGetMock).not.toHaveBeenCalled();
    expect(e.requestOpciones).toHaveLength(1);
    expect(e.requestOpciones[0].ca).toEqual(expect.arrayContaining([DV_BCV, OV_BCV]));
  });

  it("con error de cadena descarga el intermedio del AIA, lo verifica y reintenta UNA vez", async () => {
    const e = montar({
      gets: (n) => (n === 0 ? { error: errorDeCadena() } : OK),
      aia: { [URL_AIA]: { body: DER_BUENO } },
    });
    const { fetchBcvHtml } = await importarBcvFetch();

    await expect(fetchBcvHtml(URL_BCV)).resolves.toBe("<html>tasa</html>");

    expect(e.requestOpciones).toHaveLength(2);
    expect(e.huellasDeCa(0)).not.toContain(HUELLA_INTERMEDIO);
    expect(e.huellasDeCa(1)).toContain(HUELLA_INTERMEDIO);
    // La lectura de la hoja es la ÚNICA conexión sin verificar y no manda HTTP.
    expect(e.connectMock).toHaveBeenCalledTimes(1);
    expect(e.connectMock.mock.calls[0][0]).toMatchObject({
      host: "www.bcv.org.ve",
      port: 443,
      rejectUnauthorized: false,
    });
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith(
      "bcv_intermedio_descargado",
      expect.objectContaining({ sha256: HUELLA_INTERMEDIO, url: URL_AIA })
    );
  });

  it("una vez descargado, las llamadas siguientes lo usan y no vuelven a buscar", async () => {
    const e = montar({
      gets: (n) => (n === 0 ? { error: errorDeCadena() } : OK),
      aia: { [URL_AIA]: { body: DER_BUENO } },
    });
    const { fetchBcvHtml } = await importarBcvFetch();

    await fetchBcvHtml(URL_BCV);
    await fetchBcvHtml(URL_BCV);

    expect(e.requestOpciones).toHaveLength(3);
    expect(e.huellasDeCa(2)).toContain(HUELLA_INTERMEDIO);
    expect(e.connectMock).toHaveBeenCalledTimes(1);
    expect(e.httpGetMock).toHaveBeenCalledTimes(1);
  });

  it("si el intermedio descargado deja de servir, vuelve a buscar y lo reemplaza", async () => {
    // Llamadas: 0 falla (busca), 1 ok, 2 falla otra vez (renovó la hoja), 3 ok.
    const e = montar({
      gets: (n) => (n === 0 || n === 2 ? { error: errorDeCadena() } : OK),
      aia: { [URL_AIA]: { body: DER_BUENO } },
    });
    const { fetchBcvHtml } = await importarBcvFetch();

    await fetchBcvHtml(URL_BCV);
    await fetchBcvHtml(URL_BCV);

    expect(e.connectMock).toHaveBeenCalledTimes(2);
    expect(e.huellasDeCa(3)).toContain(HUELLA_INTERMEDIO);
    // Mismo certificado dos veces: el aviso sale una sola vez por huella.
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["intermedio-otra-llave.pem", "no_firma_la_hoja"],
    ["intermedio-no-ca.pem", "no_es_ca"],
    ["intermedio-vencido.pem", "vencido"],
    ["intermedio-sin-raiz.pem", "no_encadena_a_raiz"],
  ])("rechaza %s (%s), nombra el motivo y no reintenta dentro de 5 minutos", async (archivo, motivo) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const e = montar({
      gets: () => ({ error: errorDeCadena() }),
      aia: { [URL_AIA]: { body: readFileSync(join(DIR_CERTS, archivo)) } },
    });
    const { fetchBcvHtml } = await importarBcvFetch();

    const fallo = async () => (await fetchBcvHtml(URL_BCV).catch((x: Error) => x)) as Error;

    const primero = await fallo();
    expect(primero.message).toContain(motivo);
    expect(primero.message).toMatch(
      /la cadena TLS no verifica \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\) y no se pudo armar con el AIA/
    );
    expect((primero as Error & { cause?: Error }).cause?.message).toMatch(/unable to verify/);
    expect(e.connectMock).toHaveBeenCalledTimes(1);
    expect(e.requestOpciones).toHaveLength(1); // sin reintento del GET: el intermedio no sirvió

    // Dentro de los 5 minutos: mismo motivo, sin tocar la red.
    vi.setSystemTime(Date.now() + 4 * 60_000);
    const segundo = await fallo();
    expect(segundo.message).toContain(motivo);
    expect(e.connectMock).toHaveBeenCalledTimes(1);
    expect(e.httpGetMock).toHaveBeenCalledTimes(1);

    // Pasados los 5 minutos: vuelve a buscar.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await fallo();
    expect(e.connectMock).toHaveBeenCalledTimes(2);
  });

  it("un AIA fuera de la lista de hosts no se visita y el error nombra la URL", async () => {
    const e = montar({ gets: () => ({ error: errorDeCadena() }), hoja: "hoja-aia-fuera.pem" });
    const { fetchBcvHtml } = await importarBcvFetch();

    const error = (await fetchBcvHtml(URL_BCV).catch((x: Error) => x)) as Error;

    expect(e.httpGetMock).not.toHaveBeenCalled();
    expect(error.message).toContain("AIA fuera de la lista de hosts permitidos");
    expect(error.message).toContain("crt.ejemplo-malicioso.com");
  });

  it("un error que no es de cadena (ECONNRESET) se propaga sin buscar nada", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const e = montar({ gets: () => ({ error: reset }) });
    const { fetchBcvHtml } = await importarBcvFetch();

    await expect(fetchBcvHtml(URL_BCV)).rejects.toBe(reset);

    expect(e.connectMock).not.toHaveBeenCalled();
    expect(e.httpGetMock).not.toHaveBeenCalled();
  });

  it("un error con el TEXTO de cadena pero sin code no dispara la búsqueda (se mira el code)", async () => {
    const sinCode = new Error("unable to verify the first certificate");
    const e = montar({ gets: () => ({ error: sinCode }) });
    const { fetchBcvHtml } = await importarBcvFetch();

    await expect(fetchBcvHtml(URL_BCV)).rejects.toBe(sinCode);

    expect(e.connectMock).not.toHaveBeenCalled();
  });

  it("los otros dos códigos de cadena (issuer local y issuer) también disparan la búsqueda", async () => {
    for (const code of ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT"]) {
      vi.resetModules();
      const e = montar({
        gets: (n) => (n === 0 ? { error: Object.assign(new Error("x"), { code }) } : OK),
        aia: { [URL_AIA]: { body: DER_BUENO } },
      });
      const { fetchBcvHtml } = await importarBcvFetch();
      await expect(fetchBcvHtml(URL_BCV)).resolves.toBe("<html>tasa</html>");
      expect(e.connectMock).toHaveBeenCalledTimes(1);
    }
  });

  it("acepta el intermedio también en PEM", async () => {
    montar({
      gets: (n) => (n === 0 ? { error: errorDeCadena() } : OK),
      aia: { [URL_AIA]: { body: Buffer.from(pem("intermedio.pem")) } },
    });
    const { fetchBcvHtml } = await importarBcvFetch();
    await expect(fetchBcvHtml(URL_BCV)).resolves.toBe("<html>tasa</html>");
  });

  it("rechaza una descarga de más de 64 KB", async () => {
    montar({
      gets: () => ({ error: errorDeCadena() }),
      aia: { [URL_AIA]: { bytes: 70 * 1024 } },
    });
    const { fetchBcvHtml } = await importarBcvFetch();

    const error = (await fetchBcvHtml(URL_BCV).catch((x: Error) => x)) as Error;

    expect(error.message).toContain("64 KB");
  });

  it("un AIA que no responde 200 (redirección incluida) se rechaza sin seguirla", async () => {
    montar({
      gets: () => ({ error: errorDeCadena() }),
      aia: { [URL_AIA]: { status: 302 } },
    });
    const { fetchBcvHtml } = await importarBcvFetch();

    const error = (await fetchBcvHtml(URL_BCV).catch((x: Error) => x)) as Error;

    expect(error.message).toContain("302");
  });

  it("si lo descargado no es un certificado, lo dice", async () => {
    montar({
      gets: () => ({ error: errorDeCadena() }),
      aia: { [URL_AIA]: { body: Buffer.from("esto no es un certificado") } },
    });
    const { fetchBcvHtml } = await importarBcvFetch();

    const error = (await fetchBcvHtml(URL_BCV).catch((x: Error) => x)) as Error;

    expect(error.message).toContain("formato no reconocido");
  });

  it("si no se puede leer la hoja (la conexión falla), lo dice y no baja nada", async () => {
    const e = montar({ gets: () => ({ error: errorDeCadena() }), hoja: new Error("ECONNREFUSED") });
    const { fetchBcvHtml } = await importarBcvFetch();

    const error = (await fetchBcvHtml(URL_BCV).catch((x: Error) => x)) as Error;

    expect(error.message).toContain("ECONNREFUSED");
    expect(e.httpGetMock).not.toHaveBeenCalled();
  });
});

describe("simularArmadoPorAia", () => {
  it("hace el primer GET con DV y SIN OV, arma por AIA y no guarda nada en el módulo", async () => {
    const e = montar({
      gets: (n) => (n === 0 ? { error: errorDeCadena() } : OK),
      aia: { [URL_AIA]: { body: DER_BUENO } },
    });
    const { simularArmadoPorAia, fetchBcvHtml } = await importarBcvFetch();

    const r = await simularArmadoPorAia(URL_BCV);

    expect(r).toEqual({
      ok: true,
      armadoPorAia: true,
      intermedio: expect.objectContaining({ sha256: HUELLA_INTERMEDIO, url: URL_AIA }),
    });
    const ca0 = e.requestOpciones[0].ca as string[];
    expect(ca0).toContain(DV_BCV);
    expect(ca0).not.toContain(OV_BCV);
    expect(e.huellasDeCa(1)).toContain(HUELLA_INTERMEDIO);
    expect(logMock.info).toHaveBeenCalledWith(
      "bcv_simulacro_aia",
      expect.objectContaining({ ok: true, armadoPorAia: true })
    );
    expect(logMock.warn).not.toHaveBeenCalled();

    // Nada quedó en memoria: un fetch normal ofrece DV y OV y NO el descargado.
    await fetchBcvHtml(URL_BCV);
    expect(e.huellasDeCa(2)).not.toContain(HUELLA_INTERMEDIO);
    expect(e.requestOpciones[2].ca).toContain(OV_BCV);
  });

  it("si el primer GET ya anda, armadoPorAia es false y no busca nada", async () => {
    const e = montar({ gets: () => OK });
    const { simularArmadoPorAia } = await importarBcvFetch();

    await expect(simularArmadoPorAia(URL_BCV)).resolves.toEqual({
      ok: true,
      armadoPorAia: false,
      intermedio: null,
    });
    expect(e.connectMock).not.toHaveBeenCalled();
  });

  it("nunca lanza: un intermedio malo sale como ok:false con el motivo", async () => {
    montar({
      gets: () => ({ error: errorDeCadena() }),
      aia: { [URL_AIA]: { body: readFileSync(join(DIR_CERTS, "intermedio-vencido.pem")) } },
    });
    const { simularArmadoPorAia } = await importarBcvFetch();

    const r = await simularArmadoPorAia(URL_BCV);

    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.motivo).toContain("vencido");
  });

  it("nunca lanza: un error que no es de cadena también sale como ok:false", async () => {
    montar({ gets: () => ({ error: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }) });
    const { simularArmadoPorAia } = await importarBcvFetch();

    const r = await simularArmadoPorAia(URL_BCV);

    expect(r.ok).toBe(false);
  });

  it("ignora el caché de fallos y no lo ensucia", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const e = montar({
      gets: () => ({ error: errorDeCadena() }),
      aia: { [URL_AIA]: { body: readFileSync(join(DIR_CERTS, "intermedio-no-ca.pem")) } },
    });
    const { fetchBcvHtml, simularArmadoPorAia } = await importarBcvFetch();

    await fetchBcvHtml(URL_BCV).catch(() => undefined); // deja un fallo guardado
    expect(e.connectMock).toHaveBeenCalledTimes(1);

    await simularArmadoPorAia(URL_BCV); // busca igual, con el fallo vigente
    expect(e.connectMock).toHaveBeenCalledTimes(2);

    await fetchBcvHtml(URL_BCV).catch(() => undefined); // el fallo de antes sigue vigente
    expect(e.connectMock).toHaveBeenCalledTimes(2);
  });
});
