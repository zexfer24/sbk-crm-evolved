import "server-only";
import https from "node:https";
import tls from "node:tls";
import { SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36 } from "@/lib/ai/bcv-intermediate-ca";

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
// contenedor. Medido: con solo raíces (120 certificados) falla; sumando el
// intermedio, responde 200.
//
// El intermedio viaja con nosotros, en `bcv-intermediate-ca.ts`, que explica de
// dónde salió y cómo repetirlo.
//
// Esto va acá y no en un flag de arranque (--use-system-ca) a propósito: Next
// atiende las peticiones en un proceso hijo, y los flags de la línea de
// comandos no se heredan — solo se heredarían por NODE_OPTIONS, que hay que
// acordarse de poner en cada entorno y con sintaxis distinta en Windows. Al
// resolverlo en el propio cliente HTTP, funciona igual en la máquina de
// desarrollo y en el contenedor, sin configuración.
//
// Se sigue verificando el certificado —cadena y nombre del host—: no se
// desactiva TLS en ningún caso.
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

/**
 * Las raíces de confianza más el intermedio que el BCV no manda.
 *
 * El intermedio va SIEMPRE, incluso si los almacenes no se pueden leer: es
 * justamente la pieza que decide si la conexión funciona. Las raíces se suman
 * para no perder la confianza normal del sistema — sin ellas, `ca` reemplazaría
 * el almacén por completo y quedaría un único ancla.
 */
function certificateAuthorities(): string[] {
  if (cachedCa) return cachedCa;

  const getCACertificates = (tls as TlsWithCACertificates).getCACertificates;
  const roots =
    typeof getCACertificates === "function"
      ? // En un runtime sin esta API se sigue con el intermedio solo: es poco,
        // pero es la pieza que falta, no la que sobra.
        safeStores(getCACertificates)
      : [];

  cachedCa = [...roots, SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36];
  return cachedCa;
}

function safeStores(getCACertificates: (store: CACertificateStore) => string[]): string[] {
  try {
    return [...getCACertificates("default"), ...getCACertificates("system")];
  } catch {
    return [];
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
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SbkMotorcyclesCRM/1.0)" },
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
