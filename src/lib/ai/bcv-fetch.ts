import "server-only";
import { X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { sha256Legible, urlsAiaPermitidas, verificarIntermedio } from "@/lib/ai/bcv-chain";
import {
  BCV_EMBEDDED_INTERMEDIATES,
  SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36,
} from "@/lib/ai/bcv-intermediate-ca";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Descarga de bcv.org.ve
//
// El sitio del BCV sirve su certificado sin la cadena intermedia. Los
// navegadores la reconstruyen solos yendo a buscarla; Node no, y falla con
// UNABLE_TO_VERIFY_LEAF_SIGNATURE.
//
// Este fichero decía antes que el almacén del sistema "suele tener ese
// intermedio" y por eso juntaba `default` + `system`. Era falso: los almacenes
// de CAs guardan RAÍCES, y un intermedio no está ahí. Sumar dos listas de
// raíces no puede aportar un eslabón que ninguna contiene, así que la tasa
// quedó congelada tres días en producción con este código puesto. En Windows
// funcionaba de casualidad —el almacén del sistema acumula los intermedios que
// el propio sistema ya bajó—, y por eso pasó en desarrollo y falló en el
// contenedor.
//
// El segundo golpe fue el 19/11/2026: el BCV renovó su hoja y la firmó otro
// intermedio (Sectigo OV R36; teníamos embebido solo el DV R36). Todo volvió a
// fallar con `unable to verify the first certificate` y la tasa quedó vieja dos
// días sin que nadie se enterara. Por eso ya no basta con embeber el intermedio
// de turno: ahora la cadena se ARMA SOLA.
//
// Cómo (21/11/2026):
//   1. Los intermedios conocidos viajan embebidos (`bcv-intermediate-ca.ts`) y
//      es el camino normal: un solo GET, sin red extra.
//   2. Si el GET falla con un error de CADENA (`err.code`, nunca el texto), se
//      lee la hoja del BCV, se baja el intermedio de su AIA ("CA Issuers") y se
//      reintenta UNA vez con él sumado a las CAs.
//   3. Lo descargado NO se acepta por venir de donde viene: `bcv-chain.ts`
//      comprueba que firma la hoja, que es CA, que está vigente y que encadena
//      a una raíz de confianza. Y solo se visitan URLs de hosts de la propia
//      Sectigo (lista cerrada), para que un certificado raro no nos haga hacer
//      peticiones a donde se le antoje.
//   4. Si no se pudo, se recuerda el fallo 5 minutos para no martillar el AIA
//      en cada carga de la bandeja, y el error dice por qué.
//
// LA ÚNICA EXCEPCIÓN A "SIEMPRE SE VERIFICA" es `leerHojaSinVerificar`: abre una
// conexión TLS con `rejectUnauthorized: false` SOLO para leer el certificado
// público que el servidor ofrece (es justo lo que no podemos verificar todavía:
// nos falta el intermedio). No envía ni recibe HTTP, no usa nada de lo que el
// servidor diga salvo esos bytes, y lo que se baje con ellos se verifica
// criptográficamente antes de usarse. El GET que trae la tasa va SIEMPRE con la
// verificación completa de cadena y de nombre del host: no se desactiva TLS en
// ningún caso.
//
// Esto va acá y no en un flag de arranque (--use-system-ca) a propósito: Next
// atiende las peticiones en un proceso hijo, y los flags de la línea de
// comandos no se heredan — solo se heredarían por NODE_OPTIONS, que hay que
// acordarse de poner en cada entorno y con sintaxis distinta en Windows. Al
// resolverlo en el propio cliente HTTP, funciona igual en la máquina de
// desarrollo y en el contenedor, sin configuración.
// ---------------------------------------------------------------------------

/**
 * `tls.getCACertificates` existe desde Node 22.15 y el proyecto ya exige 22.14+
 * (ver `engines` en package.json), pero @types/node está en la línea 20 y
 * todavía no la declara. Se tipa acá lo justo que se usa, en vez de arrastrar
 * una subida de tipos que toca todo el repositorio.
 */
type CACertificateStore = "default" | "system" | "bundled" | "extra";
type TlsWithCACertificates = typeof tls & {
  getCACertificates?: (store: CACertificateStore) => string[];
};

const TIMEOUT_MS = 10_000;
/** Un certificado de CA pesa ~2 KB; 64 KB ya es una respuesta que no es lo que se pidió. */
const MAX_BYTES_AIA = 64 * 1024;
/** Tras un fallo de AIA no se vuelve a buscar durante este tiempo. */
export const BCV_AIA_FALLO_TTL_MS = 5 * 60_000;

/**
 * Códigos de error de Node/OpenSSL que significan "no pude armar la cadena". Se
 * mira `err.code`, nunca el texto: el texto cambia entre versiones de Node y de
 * OpenSSL, y un mensaje parecido sin código (un proxy, un error propio) no es
 * motivo para ir a buscar certificados.
 */
export const ERRORES_DE_CADENA = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
]);

function esErrorDeCadena(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERRORES_DE_CADENA.has(code);
}

// --- Estado del módulo (todo se limpia en resetBcvFetchForTests) ------------

/**
 * Leer el almacén del sistema cuesta (son cientos de certificados), y no
 * cambia mientras el proceso vive.
 */
let raicesPem: string[] | null = null;
let raicesX509: X509Certificate[] | null = null;

/** El intermedio bajado del AIA y verificado; se ofrece a Node junto con los embebidos. */
let intermedioDescargado: string | null = null;
/** Último fallo al armar por AIA; mientras sea reciente no se vuelve a intentar. */
let falloAia: { at: number; motivo: string } | null = null;
/** Huellas ya avisadas, para que `bcv_intermedio_descargado` salga una vez por certificado. */
const huellasAvisadas = new Set<string>();
/** Búsqueda en curso: dos cargas simultáneas comparten una sola. */
let busquedaEnCurso: Promise<void> | null = null;

/** Solo para tests: deja el módulo como recién importado. */
export function resetBcvFetchForTests(): void {
  raicesPem = null;
  raicesX509 = null;
  intermedioDescargado = null;
  falloAia = null;
  huellasAvisadas.clear();
  busquedaEnCurso = null;
}

function raices(): string[] {
  if (raicesPem) return raicesPem;
  const getCACertificates = (tls as TlsWithCACertificates).getCACertificates;
  raicesPem =
    typeof getCACertificates === "function"
      ? // En un runtime sin esta API se sigue con los intermedios solos: es poco,
        // pero es la pieza que falta, no la que sobra.
        safeStores(getCACertificates)
      : [];
  return raicesPem;
}

/** Las mismas raíces ya parseadas, para verificar con `bcv-chain`. Las que no parsean se ignoran. */
function raicesParseadas(): X509Certificate[] {
  if (raicesX509) return raicesX509;
  raicesX509 = [];
  for (const pem of raices()) {
    try {
      raicesX509.push(new X509Certificate(pem));
    } catch {
      // Un almacén con un certificado ilegible no tumba la verificación del resto.
    }
  }
  return raicesX509;
}

function safeStores(getCACertificates: (store: CACertificateStore) => string[]): string[] {
  try {
    return [...getCACertificates("default"), ...getCACertificates("system")];
  } catch {
    return [];
  }
}

/**
 * Las raíces de confianza más los intermedios que el BCV no manda: los
 * embebidos SIEMPRE (incluso si los almacenes no se pueden leer: son la pieza
 * que decide si la conexión funciona) y, si hay, el que se bajó del AIA. Las
 * raíces se suman para no perder la confianza normal del sistema — sin ellas,
 * `ca` reemplazaría el almacén por completo y quedaría un único ancla.
 *
 * El arreglo se arma en cada llamada y no se cachea: si se cacheara con el
 * descargado adentro, un intermedio reemplazado quedaría viejo.
 */
function certificateAuthorities(): string[] {
  return [
    ...raices(),
    ...BCV_EMBEDDED_INTERMEDIATES,
    ...(intermedioDescargado ? [intermedioDescargado] : []),
  ];
}

// --- GET de la tasa (siempre con verificación completa) ---------------------

const USER_AGENT = "Mozilla/5.0 (compatible; SbkMotorcyclesCRM/1.0)";

function getUnaVez(url: string, ca: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        ca,
        headers: { "User-Agent": USER_AGENT },
        timeout: TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`bcv.org.ve respondió ${status} al pedir la tasa.`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      }
    );

    // Sin esto, un BCV que acepta la conexión y no contesta dejaría colgada la
    // carga de la bandeja hasta el timeout del servidor.
    request.on("timeout", () => {
      request.destroy(new Error(`bcv.org.ve no respondió en ${TIMEOUT_MS / 1000} s.`));
    });
    request.on("error", reject);
    request.end();
  });
}

/** GET a una página del BCV, devuelto como texto. Lanza si no se pudo leer. */
export async function fetchBcvHtml(url: string): Promise<string> {
  try {
    return await getUnaVez(url, certificateAuthorities());
  } catch (err) {
    // Cualquier otro error (red, 5xx, timeout) se propaga como siempre: solo un
    // problema de cadena justifica ir a buscar certificados.
    if (!esErrorDeCadena(err)) throw err;

    await asegurarIntermedioPorAia(new URL(url).hostname, err);
    // UNA sola repetición, ya con las CAs actualizadas. Si sigue fallando, es
    // el error real el que sale.
    return await getUnaVez(url, certificateAuthorities());
  }
}

// --- Armado de la cadena por AIA --------------------------------------------

type Armado = { ok: true; cert: X509Certificate; url: string } | { ok: false; motivo: string };

/**
 * Busca (o recuerda que no se pudo) el intermedio de la hoja del host y, si lo
 * consigue, lo deja en memoria para el próximo `certificateAuthorities()`.
 * Lanza el error en español si no pudo.
 */
async function asegurarIntermedioPorAia(host: string, errorOriginal: unknown): Promise<void> {
  const codigo = (errorOriginal as { code?: string }).code;
  const lanzar = (motivo: string): never => {
    throw new Error(
      `bcv.org.ve: la cadena TLS no verifica (${codigo}) y no se pudo armar con el AIA: ${motivo}`,
      { cause: errorOriginal }
    );
  };

  // Sin esto, cada carga de la bandeja repetiría las tres peticiones (hoja,
  // AIA, GET) mientras el BCV siga mal.
  if (falloAia && Date.now() - falloAia.at < BCV_AIA_FALLO_TTL_MS) {
    lanzar(falloAia.motivo);
  }

  busquedaEnCurso ??= (async () => {
    const resultado = await buscarIntermedioPorAia(host);
    if (!resultado.ok) {
      falloAia = { at: Date.now(), motivo: resultado.motivo };
      log.warn("bcv_aia_fallo", { host, motivo: resultado.motivo });
      return;
    }
    falloAia = null;
    intermedioDescargado = resultado.cert.toString();
    const sha256 = sha256Legible(resultado.cert);
    if (!huellasAvisadas.has(sha256)) {
      huellasAvisadas.add(sha256);
      // warn y no info: es la señal de que el intermedio vigente ya no está
      // embebido y conviene sumarlo a bcv-intermediate-ca.ts en el próximo commit.
      log.warn("bcv_intermedio_descargado", {
        subject: resultado.cert.subject.replace(/\n/g, ", "),
        sha256,
        url: resultado.url,
      });
    }
  })().finally(() => {
    busquedaEnCurso = null;
  });

  await busquedaEnCurso;
  // Si la búsqueda (propia o la de otra carga simultánea) falló, se informa acá.
  if (falloAia) lanzar(falloAia.motivo);
}

/**
 * Lee la hoja del host, filtra las URLs del AIA, baja el intermedio y lo
 * verifica. No toca el estado del módulo: la usan tanto la lectura real como el
 * simulacro. Nunca lanza.
 */
async function buscarIntermedioPorAia(host: string): Promise<Armado> {
  let hoja: X509Certificate;
  try {
    hoja = new X509Certificate(await leerHojaSinVerificar(host));
  } catch (err) {
    return { ok: false, motivo: `no se pudo leer el certificado de ${host}: ${errorText(err)}` };
  }

  const { permitidas, rechazadas } = urlsAiaPermitidas(hoja);
  if (permitidas.length === 0) {
    return {
      ok: false,
      motivo: rechazadas.length
        ? `AIA fuera de la lista de hosts permitidos: ${rechazadas.join(", ")}`
        : "la hoja no trae ninguna URL de AIA (CA Issuers)",
    };
  }

  const fallas: string[] = [];
  for (const url of permitidas) {
    try {
      const candidato = parsearCertificado(await descargarAia(url));
      const veredicto = verificarIntermedio(candidato, hoja, raicesParseadas(), new Date());
      if (veredicto.ok) return { ok: true, cert: candidato, url };
      fallas.push(`${url} (${veredicto.motivo}): ${veredicto.detalle}`);
    } catch (err) {
      fallas.push(`${url}: ${errorText(err)}`);
    }
  }
  return { ok: false, motivo: fallas.join("; ") };
}

function parsearCertificado(bytes: Buffer): X509Certificate {
  try {
    // Acepta DER (lo que sirve el AIA) y PEM.
    return new X509Certificate(bytes);
  } catch {
    throw new Error("formato no reconocido: lo descargado no es un certificado X.509");
  }
}

/**
 * ÚNICA EXCEPCIÓN a la verificación TLS de este módulo. Abre una conexión con
 * `rejectUnauthorized: false` para leer el certificado de hoja que el servidor
 * ofrece, lo copia y cierra: no envía HTTP ni usa nada más de la respuesta. Hace
 * falta porque la verificación normal es justo lo que falla (falta el
 * intermedio) y la hoja es pública. Lo que se descargue a partir de ella se
 * verifica criptográficamente en `verificarIntermedio`; el GET de la tasa nunca
 * pasa por acá.
 */
function leerHojaSinVerificar(host: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false });
    const temporizador = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host} no respondió en ${TIMEOUT_MS / 1000} s al pedir su certificado.`));
    }, TIMEOUT_MS);
    temporizador.unref?.();

    socket.once("secureConnect", () => {
      clearTimeout(temporizador);
      const raw = socket.getPeerCertificate().raw;
      socket.destroy();
      if (raw) resolve(raw);
      else reject(new Error(`${host} no presentó ningún certificado.`));
    });
    socket.once("error", (err) => {
      clearTimeout(temporizador);
      reject(err);
    });
  });
}

/**
 * Baja un certificado del AIA: solo 200, sin seguir redirecciones (una
 * redirección es otro host que la lista no vio) y con tope de tamaño.
 */
function descargarAia(url: string): Promise<Buffer> {
  const cliente = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = cliente.get(
      url,
      { timeout: TIMEOUT_MS, headers: { "User-Agent": USER_AGENT } },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          reject(new Error(`respondió ${status} (no se siguen redirecciones)`));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BYTES_AIA) {
            request.destroy();
            reject(new Error(`la descarga pasa de ${MAX_BYTES_AIA / 1024} KB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`no respondió en ${TIMEOUT_MS / 1000} s`));
    });
    request.on("error", reject);
  });
}

// --- Simulacro para el VPS ---------------------------------------------------

type Simulacro =
  | { ok: true; armadoPorAia: boolean; intermedio: { subject: string; sha256: string; url: string } | null }
  | { ok: false; motivo: string };

/**
 * Ensayo del armado por AIA: ¿funcionaría ahora, de cero? Hace el GET solo con
 * las raíces y el DV R36 (sin el OV embebido ni el intermedio que ya hubiera en
 * memoria), ignora el caché de fallos y NO guarda nada en el estado del módulo,
 * así que se puede correr en producción sin alterar la lectura real. Si el GET
 * falla por cadena, busca el intermedio por AIA y reintenta. Nunca lanza.
 *
 * Existe para poder comprobar en el VPS, antes de la próxima renovación del
 * certificado, que el camino del AIA anda de punta a punta.
 */
export async function simularArmadoPorAia(url: string): Promise<Simulacro> {
  const resultado = await ensayar(url);
  log.info("bcv_simulacro_aia", {
    ok: resultado.ok,
    armadoPorAia: resultado.ok ? resultado.armadoPorAia : undefined,
    sha256: resultado.ok ? resultado.intermedio?.sha256 : undefined,
    url: resultado.ok ? resultado.intermedio?.url : undefined,
    motivo: resultado.ok ? undefined : resultado.motivo,
  });
  return resultado;
}

async function ensayar(url: string): Promise<Simulacro> {
  try {
    const base = [...raices(), SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36];
    try {
      await getUnaVez(url, base);
      return { ok: true, armadoPorAia: false, intermedio: null };
    } catch (err) {
      if (!esErrorDeCadena(err)) {
        return { ok: false, motivo: `el GET falló sin ser un error de cadena: ${errorText(err)}` };
      }
      const armado = await buscarIntermedioPorAia(new URL(url).hostname);
      if (!armado.ok) return { ok: false, motivo: armado.motivo };
      try {
        await getUnaVez(url, [...base, armado.cert.toString()]);
      } catch (err2) {
        return {
          ok: false,
          motivo: `el intermedio verificó pero el GET reintentado falló: ${errorText(err2)}`,
        };
      }
      return {
        ok: true,
        armadoPorAia: true,
        intermedio: {
          subject: armado.cert.subject.replace(/\n/g, ", "),
          sha256: sha256Legible(armado.cert),
          url: armado.url,
        },
      };
    }
  } catch (err) {
    return { ok: false, motivo: errorText(err) };
  }
}
