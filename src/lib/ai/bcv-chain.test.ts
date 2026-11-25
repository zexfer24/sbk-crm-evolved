// @vitest-environment node
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import {
  AIA_HOSTS_PERMITIDOS,
  sha256Legible,
  urlsAiaPermitidas,
  verificarIntermedio,
} from "@/lib/ai/bcv-chain";
import {
  BCV_EMBEDDED_INTERMEDIATES,
  SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36,
  SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_OV_R36,
} from "@/lib/ai/bcv-intermediate-ca";

// ---------------------------------------------------------------------------
// Armado de la cadena TLS del BCV, sin red (21/11/2026). Los certificados de
// prueba los genera scripts/generar-certs-prueba-bcv.sh con fechas fijas: nada
// de lo que se prueba acá depende del reloj de la máquina salvo el caso de
// "vencido", que usa un intermedio que caducó en 2021.
// ---------------------------------------------------------------------------

const DIR = join(__dirname, "__fixtures__", "bcv-certs");
const cargar = (nombre: string) => new X509Certificate(readFileSync(join(DIR, nombre)));

const raiz = cargar("raiz.pem");
const hoja = cargar("hoja.pem");
const hojaAiaFuera = cargar("hoja-aia-fuera.pem");
const intermedio = cargar("intermedio.pem");
const AHORA = new Date("2026-11-21T12:00:00Z");

describe("verificarIntermedio", () => {
  it("acepta un intermedio que firma la hoja, es CA, está vigente y encadena a una raíz", () => {
    expect(verificarIntermedio(intermedio, hoja, [raiz], AHORA)).toEqual({ ok: true });
  });

  it("rechaza con no_firma_la_hoja un intermedio con otra llave (mismo subject)", () => {
    const r = verificarIntermedio(cargar("intermedio-otra-llave.pem"), hoja, [raiz], AHORA);
    expect(r).toMatchObject({ ok: false, motivo: "no_firma_la_hoja" });
    if (!r.ok) expect(r.detalle).toContain("Intermedio de Prueba");
  });

  it("rechaza con no_es_ca un intermedio que no es CA", () => {
    const r = verificarIntermedio(cargar("intermedio-no-ca.pem"), hoja, [raiz], AHORA);
    expect(r).toMatchObject({ ok: false, motivo: "no_es_ca" });
  });

  it("rechaza con vencido un intermedio fuera de su vigencia", () => {
    const r = verificarIntermedio(cargar("intermedio-vencido.pem"), hoja, [raiz], AHORA);
    expect(r).toMatchObject({ ok: false, motivo: "vencido" });
  });

  it("rechaza con no_encadena_a_raiz un intermedio firmado por una raíz que no es de confianza", () => {
    const r = verificarIntermedio(cargar("intermedio-sin-raiz.pem"), hoja, [raiz], AHORA);
    expect(r).toMatchObject({ ok: false, motivo: "no_encadena_a_raiz" });
  });

  it("sin ninguna raíz tampoco encadena", () => {
    const r = verificarIntermedio(intermedio, hoja, [], AHORA);
    expect(r).toMatchObject({ ok: false, motivo: "no_encadena_a_raiz" });
  });

  it("el intermedio que aún no empieza su vigencia cuenta como vencido", () => {
    const r = verificarIntermedio(intermedio, hoja, [raiz], new Date("2019-01-01T00:00:00Z"));
    expect(r).toMatchObject({ ok: false, motivo: "vencido" });
  });
});

describe("urlsAiaPermitidas", () => {
  it("devuelve la URL del AIA de la hoja cuando el host está permitido", () => {
    expect(urlsAiaPermitidas(hoja)).toEqual({
      permitidas: ["http://crt.sectigo.com/IntermedioPrueba.crt"],
      rechazadas: [],
    });
  });

  it("rechaza un AIA fuera de la lista de hosts", () => {
    expect(urlsAiaPermitidas(hojaAiaFuera)).toEqual({
      permitidas: [],
      rechazadas: ["http://crt.ejemplo-malicioso.com/x.crt"],
    });
  });

  it("un host que solo CONTIENE el sufijo no pasa (sectigo.com.evil.com)", () => {
    const falsa = { infoAccess: "CA Issuers - URI:http://sectigo.com.evil.com/x" } as X509Certificate;
    expect(urlsAiaPermitidas(falsa)).toEqual({
      permitidas: [],
      rechazadas: ["http://sectigo.com.evil.com/x"],
    });
  });

  it("acepta https, ignora OCSP, respeta el orden y compara el host en minúsculas", () => {
    const falsa = {
      infoAccess: [
        "OCSP - URI:http://ocsp.sectigo.com",
        "CA Issuers - URI:https://CRT.USERTRUST.COM/a.crt",
        "CA Issuers - URI:http://crt.sectigo.com/b.crt",
      ].join("\n"),
    } as X509Certificate;
    expect(urlsAiaPermitidas(falsa).permitidas).toEqual([
      "https://CRT.USERTRUST.COM/a.crt",
      "http://crt.sectigo.com/b.crt",
    ]);
  });

  it("rechaza esquemas que no son http(s) y URLs inválidas", () => {
    const falsa = {
      infoAccess: ["CA Issuers - URI:ldap://x.sectigo.com/a", "CA Issuers - URI:no es una url"].join("\n"),
    } as X509Certificate;
    const r = urlsAiaPermitidas(falsa);
    expect(r.permitidas).toEqual([]);
    expect(r.rechazadas).toHaveLength(2);
  });

  it("una hoja sin infoAccess no da ninguna URL", () => {
    expect(urlsAiaPermitidas({ infoAccess: undefined } as X509Certificate)).toEqual({
      permitidas: [],
      rechazadas: [],
    });
  });

  it("la lista de hosts es exactamente la acordada", () => {
    expect([...AIA_HOSTS_PERMITIDOS]).toEqual([".sectigo.com", ".usertrust.com", ".comodoca.com"]);
  });
});

describe("intermedios embebidos", () => {
  const dv = new X509Certificate(SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36);
  const ov = new X509Certificate(SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_OV_R36);

  it("los dos PEM parsean y son CA con el nombre esperado", () => {
    expect(dv.subject).toContain("CN=Sectigo Public Server Authentication CA DV R36");
    expect(ov.subject).toContain("CN=Sectigo Public Server Authentication CA OV R36");
    expect(dv.ca).toBe(true);
    expect(ov.ca).toBe(true);
  });

  it("el OV es exactamente el certificado verificado contra el AIA de la hoja nueva", () => {
    expect(ov.fingerprint256).toBe(
      "65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30"
    );
    expect(sha256Legible(ov)).toBe(ov.fingerprint256);
  });

  it("BCV_EMBEDDED_INTERMEDIATES lista DV y OV", () => {
    expect([...BCV_EMBEDDED_INTERMEDIATES]).toEqual([
      SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36,
      SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_OV_R36,
    ]);
  });

  const raicesNode = tls.rootCertificates.map((pem) => new X509Certificate(pem));
  const r46 = raicesNode.find((c) => c.subject.includes("Sectigo Public Server Authentication Root R46"));

  // Si la versión de Node que corre esto no trae la raíz R46 (Sectigo la
  // sumó en Node 22.x tardío), el caso se salta y queda dicho en el reporte.
  it.skipIf(!r46)("el OV embebido encadena a la raíz R46 del almacén de Node", () => {
    const ahora = new Date("2026-11-21T12:00:00Z");
    expect(ov.checkIssued(r46!) && ov.verify(r46!.publicKey)).toBe(true);
    expect(ov.validFrom && new Date(ov.validFrom) <= ahora && ahora <= new Date(ov.validTo)).toBe(true);
  });
});
