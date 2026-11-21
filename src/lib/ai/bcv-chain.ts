import { X509Certificate } from "node:crypto";

// ---------------------------------------------------------------------------
// Armado de la cadena TLS del BCV: las decisiones, sin red (21/11/2026).
//
// El BCV sirve solo su hoja; el intermedio que la firma hay que traerlo del AIA
// ("CA Issuers") de esa misma hoja. Esto es lo que se decide ACÁ, puro y
// probable sin red, para que `bcv-fetch.ts` solo haga la E/S:
//
//   1. ¿A qué URLs se acepta ir? Solo http(s) y solo a hosts de la propia
//      Sectigo (y sus dominios hermanos de Comodo/USERTrust). La hoja la sirve
//      un servidor remoto: si su AIA apuntara a un host cualquiera, el CRM
//      haría peticiones salientes a donde el certificado dijera (SSRF).
//   2. ¿Lo descargado sirve? Se acepta SOLO si firma la hoja, es CA, está
//      vigente y encadena a una raíz de confianza. Lo descargado no es de fiar
//      por venir de una URL "permitida": se verifica criptográficamente.
//
// Ojo con la API de Node, que se lee al revés de lo que parece:
// `a.checkIssued(b)` es "¿a fue emitido por b?". Por eso "el intermedio firma
// la hoja" es `hoja.checkIssued(intermedio)` (más la firma real con
// `hoja.verify(intermedio.publicKey)`, porque checkIssued solo compara nombres
// y extensiones, no criptografía).
// ---------------------------------------------------------------------------

/** Sufijos de host a los que se acepta ir a buscar un intermedio. */
export const AIA_HOSTS_PERMITIDOS = [".sectigo.com", ".usertrust.com", ".comodoca.com"] as const;

/**
 * URLs "CA Issuers - URI" del infoAccess de la hoja que son http/https y cuyo
 * host termina en un sufijo permitido, en el orden en que vienen. Las demás se
 * devuelven aparte para poder nombrarlas en el error.
 *
 * `infoAccess` es texto tipo "CA Issuers - URI:http://...\nOCSP - URI:http://..."
 * y puede faltar. El host se compara en minúsculas y sobre `URL.hostname`, no
 * sobre el texto: "http://sectigo.com.evil.com/x" no puede colarse por contener
 * el sufijo en medio.
 */
export function urlsAiaPermitidas(hoja: X509Certificate): { permitidas: string[]; rechazadas: string[] } {
  const permitidas: string[] = [];
  const rechazadas: string[] = [];

  for (const linea of (hoja.infoAccess ?? "").split("\n")) {
    const m = /^CA Issuers - URI:(.+)$/.exec(linea.trim());
    if (!m) continue;
    const url = m[1].trim();
    if (hostPermitido(url)) permitidas.push(url);
    else rechazadas.push(url);
  }
  return { permitidas, rechazadas };
}

function hostPermitido(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return AIA_HOSTS_PERMITIDOS.some((sufijo) => host.endsWith(sufijo));
}

export type MotivoRechazo = "no_firma_la_hoja" | "no_es_ca" | "vencido" | "no_encadena_a_raiz";

/**
 * ¿Sirve este certificado descargado como intermedio de la hoja? Los chequeos
 * van en este orden y se corta en el primero que falle; el orden fija qué motivo
 * se reporta cuando fallan varios.
 */
export function verificarIntermedio(
  candidato: X509Certificate,
  hoja: X509Certificate,
  raices: readonly X509Certificate[],
  ahora: Date
): { ok: true } | { ok: false; motivo: MotivoRechazo; detalle: string } {
  const quien = `«${candidato.subject.replace(/\n/g, ", ")}»`;

  if (!(hoja.checkIssued(candidato) && firmaValida(hoja, candidato))) {
    return { ok: false, motivo: "no_firma_la_hoja", detalle: `${quien} no firma la hoja del BCV` };
  }
  if (candidato.ca !== true) {
    return { ok: false, motivo: "no_es_ca", detalle: `${quien} no es una autoridad certificadora` };
  }
  if (ahora < new Date(candidato.validFrom) || ahora > new Date(candidato.validTo)) {
    return {
      ok: false,
      motivo: "vencido",
      detalle: `${quien} está fuera de su vigencia (${candidato.validFrom} a ${candidato.validTo})`,
    };
  }
  if (!raices.some((r) => candidato.checkIssued(r) && firmaValida(candidato, r))) {
    return { ok: false, motivo: "no_encadena_a_raiz", detalle: `${quien} no encadena a ninguna raíz de confianza` };
  }
  return { ok: true };
}

/** `verify` lanza con llaves de un tipo raro o certificados corruptos: eso es "no verifica". */
function firmaValida(certificado: X509Certificate, firmante: X509Certificate): boolean {
  try {
    return certificado.verify(firmante.publicKey);
  } catch {
    return false;
  }
}

/** Huella SHA-256 en el formato de openssl (AA:BB:...), la que se compara a ojo con la del VPS. */
export function sha256Legible(cert: X509Certificate): string {
  return cert.fingerprint256;
}
