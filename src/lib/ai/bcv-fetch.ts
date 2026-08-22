import "server-only";
import https from "node:https";
import tls from "node:tls";

// ---------------------------------------------------------------------------
// Descarga de bcv.org.ve
//
// El sitio del BCV sirve su certificado sin la cadena intermedia. Los
// navegadores la reconstruyen solos; Node no, y `fetch` falla con
// UNABLE_TO_VERIFY_LEAF_SIGNATURE contra su lista de CAs compilada (120
// certificados). El almacén del sistema operativo sí suele tener ese
// intermedio, así que se usan las dos listas juntas.
//
// Esto va acá y no en un flag de arranque (--use-system-ca) a propósito: Next
// atiende las peticiones en un proceso hijo, y los flags de la línea de
// comandos no se heredan — solo se heredarían por NODE_OPTIONS, que hay que
// acordarse de poner en cada entorno y con sintaxis distinta en Windows. Al
// resolverlo en el propio cliente HTTP, funciona igual en la máquina de
// desarrollo y en el contenedor, sin configuración.
//
// Se sigue verificando el certificado: no se desactiva TLS en ningún caso.
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

/**
 * Leer el almacén del sistema cuesta (son cientos de certificados), y no
 * cambia mientras el proceso vive.
 */
let cachedCa: string[] | null = null;

function certificateAuthorities(): string[] | undefined {
  if (cachedCa) return cachedCa;

  const getCACertificates = (tls as TlsWithCACertificates).getCACertificates;
  // En un runtime más viejo se sigue adelante sin CAs extra: fallará como
  // antes y se usará la última tasa guardada.
  if (typeof getCACertificates !== "function") return undefined;

  try {
    cachedCa = [...getCACertificates("default"), ...getCACertificates("system")];
    return cachedCa;
  } catch {
    return undefined;
  }
}

const TIMEOUT_MS = 10_000;

/** GET a una página del BCV, devuelto como texto. Lanza si no se pudo leer. */
export function fetchBcvHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        ca: certificateAuthorities(),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LiminalCRM/1.0)" },
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
