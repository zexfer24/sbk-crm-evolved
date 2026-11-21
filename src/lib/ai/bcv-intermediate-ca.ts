import "server-only";

// ---------------------------------------------------------------------------
// El eslabón que el BCV no manda
//
// bcv.org.ve sirve SOLO su certificado de hoja, sin el intermedio que lo firma.
// Los navegadores lo resuelven yendo a buscarlo (AIA chasing); Node no lo hace,
// y la verificación se corta con UNABLE_TO_VERIFY_LEAF_SIGNATURE.
//
// Los almacenes de CAs —el compilado de Node y el del sistema— guardan RAÍCES.
// Un intermedio no vive ahí, así que sumar almacenes no puede aportarlo: por eso
// el intento anterior (juntar `default` + `system`) no arreglaba nada en el
// contenedor. En Windows sí funcionaba de casualidad, porque el almacén del
// sistema acumula los intermedios que el propio sistema ya descargó — de ahí que
// pasara en desarrollo y fallara en producción.
//
// Se le da a Node de dos maneras: los intermedios conocidos viajan embebidos acá
// (camino rápido, sin red), y si la hoja trae uno que no conocemos,
// `bcv-fetch.ts` lo descarga del AIA de la propia hoja y lo VERIFICA antes de
// usarlo (`bcv-chain.ts`). Son certificados públicos de una CA pública; no son
// un secreto ni una llave.
//
// SEGURIDAD: esto NO baja la verificación. Se sigue comprobando la cadena y el
// nombre del host. Lo único que cambia es que la cadena ya puede armarse. Nunca
// usar `rejectUnauthorized: false` en el GET de la tasa: esta tasa decide
// precios.
//
// ---------------------------------------------------------------------------
// PROCEDENCIA — cómo se obtuvo cada uno, para poder repetirlo
//
//   1. El AIA ("CA Issuers") de la hoja del BCV apunta al intermedio.
//   2. curl -o inter.der <esa URL>
//      openssl x509 -inform DER -in inter.der -out inter.pem
//   3. Verificado antes de comitear:
//      - subject del intermedio == issuer de la hoja del BCV
//      - `openssl verify inter.pem` -> OK (encadena a una raíz de confianza)
//      - `openssl verify -untrusted inter.pem leaf.pem` -> OK
//
// DV R36 (hoja vigente hasta el 20/11/2026)
//   AIA: http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt
//   subject: C=GB, O=Sectigo Limited,
//            CN=Sectigo Public Server Authentication CA DV R36
//   issuer:  C=GB, O=Sectigo Limited,
//            CN=Sectigo Public Server Authentication Root R46
//   vigencia: 2021-03-22 .. 2036-03-21
//   SHA-256:
//     8C:54:C3:34:B6:6B:A4:E4:26:77:2A:F4:A3:F9:13:6C:
//     19:A1:AE:C7:29:FD:B2:8C:53:5C:07:A5:A4:EF:22:E0
//
// OV R36 (hoja `*.bcv.org.ve` vigente 2026-11-13 .. 2027-05-30; la firma este)
//   AIA: http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt
//   subject: C=GB, O=Sectigo Limited,
//            CN=Sectigo Public Server Authentication CA OV R36
//   issuer:  C=GB, O=Sectigo Limited,
//            CN=Sectigo Public Server Authentication Root R46
//   vigencia: 2021-03-22 .. 2036-03-21
//   SHA-256:
//     65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:
//     A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30
//   Verificado en el VPS el 21/11/2026: `openssl verify ov.pem` -> OK y
//   `openssl verify -untrusted ov.pem hoja.pem` -> OK.
//
// ---------------------------------------------------------------------------
// CUÁNDO ESTO SE ROMPE (y por qué ya no hace falta tocar código)
//
// El 19/11/2026 el BCV renovó su hoja y la firmó otro intermedio (OV R36, no el
// DV R36 que teníamos embebido): toda lectura en vivo pasó a fallar con
// `unable to verify the first certificate` y el CRM siguió sirviendo la última
// tasa guardada SIN que nadie se enterara durante dos días — el único síntoma
// era una tasa vieja que parecía normal.
//
// Desde el 21/11/2026 una renovación así no rompe nada: `fetchBcvHtml` descarga
// el intermedio del AIA de la hoja, comprueba que de verdad la firma, que es CA,
// que está vigente y que encadena a una raíz de confianza, y reintenta. Lo que
// avisa es el log `bcv_intermedio_descargado` (nivel warn, una vez por
// certificado): quiere decir que el intermedio vigente ya no está embebido acá y
// conviene sumarlo a `BCV_EMBEDDED_INTERMEDIATES` en el próximo commit (la
// procedencia de arriba dice cómo). Y si la descarga falla, el estado de la
// lectura queda visible en el CRM (otra pieza de la misma entrega), para no
// volver a enterarse dos días tarde.
// ---------------------------------------------------------------------------

export const SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36 = `-----BEGIN CERTIFICATE-----
MIIGTDCCBDSgAwIBAgIQOXpmzCdWNi4NqofKbqvjsTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgRFYgUjM2MIIBojANBgkqhkiG9w0B
AQEFAAOCAY8AMIIBigKCAYEAljZf2HIz7+SPUPQCQObZYcrxLTHYdf1ZtMRe7Yeq
RPSwygz16qJ9cAWtWNTcuICc++p8Dct7zNGxCpqmEtqifO7NvuB5dEVexXn9RFFH
12Hm+NtPRQgXIFjx6MSJcNWuVO3XGE57L1mHlcQYj+g4hny90aFh2SCZCDEVkAja
EMMfYPKuCjHuuF+bzHFb/9gV8P9+ekcHENF2nR1efGWSKwnfG5RawlkaQDpRtZTm
M64TIsv/r7cyFO4nSjs1jLdXYdz5q3a4L0NoabZfbdxVb+CUEHfB0bpulZQtH1Rv
38e/lIdP7OTTIlZh6OYL6NhxP8So0/sht/4J9mqIGxRFc0/pC8suja+wcIUna0HB
pXKfXTKpzgis+zmXDL06ASJf5E4A2/m+Hp6b84sfPAwQ766rI65mh50S0Di9E3Pn
2WcaJc+PILsBmYpgtmgWTR9eV9otfKRUBfzHUHcVgarub/XluEpRlTtZudU5xbFN
xx/DgMrXLUAPaI60fZ6wA+PTAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk
lfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQUaMASFhgOr872h6YyV6NGUV3LBycw
DgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI
KwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgEw
VAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv
UHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH
AQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp
Z29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF
BzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA
YtOC9Fy+TqECFw40IospI92kLGgoSZGPOSQXMBqmsGWZUQ7rux7cj1du6d9rD6C8
ze1B2eQjkrGkIL/OF1s7vSmgYVafsRoZd/IHUrkoQvX8FZwUsmPu7amgBfaY3g+d
q1x0jNGKb6I6Bzdl6LgMD9qxp+3i7GQOnd9J8LFSietY6Z4jUBzVoOoz8iAU84OF
h2HhAuiPw1ai0VnY38RTI+8kepGWVfGxfBWzwH9uIjeooIeaosVFvE8cmYUB4TSH
5dUyD0jHct2+8ceKEtIoFU/FfHq/mDaVnvcDCZXtIgitdMFQdMZaVehmObyhRdDD
4NQCs0gaI9AAgFj4L9QtkARzhQLNyRf87Kln+YU0lgCGr9HLg3rGO8q+Y4ppLsOd
unQZ6ZxPNGIfOApbPVf5hCe58EZwiWdHIMn9lPP6+F404y8NNugbQixBber+x536
WrZhFZLjEkhp7fFXf9r32rNPfb74X/U90Bdy4lzp3+X1ukh1BuMxA/EEhDoTOS3l
7ABvc7BYSQubQ2490OcdkIzUh3ZwDrakMVrbaTxUM2p24N6dB+ns2zptWCva6jzW
r8IWKIMxzxLPv5Kt3ePKcUdvkBU/smqujSczTzzSjIoR5QqQA6lN1ZRSnuHIWCvh
JEltkYnTAH41QJ6SAWO66GrrUESwN/cgZzL4JLEqz1Y=
-----END CERTIFICATE-----
`;

export const SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_OV_R36 = `-----BEGIN CERTIFICATE-----
MIIGTDCCBDSgAwIBAgIQLBo8dulD3d3/GRsxiQrtcTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgT1YgUjM2MIIBojANBgkqhkiG9w0B
AQEFAAOCAY8AMIIBigKCAYEApkMtJ3R06jo0fceI0M52B7K+TyMeGcv2BQ5AVc3j
lYt76TvHIu/nNe22W/RJXX9rWUD/2GE6GF5x0V4bsY7K3IeJ8E7+KzG/TGboySfD
u+F52jqQBbY62ofhYjMeiAbLI02+FqwHeM8uIrUtcX8b2RCxF358TB0NHVccAXZc
FYgZndZCeXxjuca7pJJ20LLUnXtgXcjAE1vY4WvbReW0W6mkeZyNGdmpTcFs5Y+s
yy6LtE5Zocji9J9NlNnReox2RWVyEXpA1ChZ4gqN+ZpVSIQ0HBorVFbBKyhdZyEX
gZgNSNtBRwxqwIzJePJhYd4ZUhO1vk+/uP3nwDk0p95q/j7naXNCSvESnrHPypaB
WRK066nKfPRPi9m9kIOhMdYfS8giFRTcdgL24Ycilj7ecAK9Trh0VbjwouJ4WH+x
bt47u68ZFCD/ac55I0DNHkCpaPruj6e9Rmr7K46wZDAYXuEAqB7tGG/jd6JAA+H2
O44CV98NRsU213f1kScIZntNAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk
lfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQU42Z0u3BojSxdTg6mSo+bNyKcgpIw
DgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI
KwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgIw
VAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv
UHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH
AQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp
Z29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF
BzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA
BZXWDHWC3cubb/e1I1kzi8lPFiK/ZUoH09ufmVOrc5ObYH/XKkWUexSPqRkwKFKr
7r8OuG+p7VNB8rifX6uopqKAgsvZtZsq7iAFw04To6vNcxeBt1Eush3cQ4b8nbQR
MQLChgEAqwhuXp9P48T4QEBSksYav7+aFjNySsLYlPzNqVM3RNwvBdvp6vgDtGwc
xlKQZVuuNVIaoYyls8swhxDeSHKpRdxRauTLZ+pl+wGvy0pnrLEJGSz9mOEmfbod
e/XopR2NGqaHJ6bIjyxPu6UtyQGI26En7UAEozACrHz06Nx2jTAY9E6NeB6XuobE
wLK025ZRmvglcURG1BrV24tGHHTgxCe8M3oGlpUSMTKQ2dkgljZVYt+gKdFtWELZ
MuRdi+X3XsrR8LFz+aLUiDRfQqhmw3RxjIyVKvvu9UPYY1nsvxYmFnUSeM+2q1z/
iPUry+xDY9MC6+IhleKT094VKdFVp7LXH42+wvU+17lRolQ2mK2N/nBLVBwaIhib
QXw4VYKwB86Bc6eS6iqsc94KEgD/U4VsjmgfhK+Xp4NM+VYzTTa3QeV3p8xOM0cw
q1p8oZFA+OBcz3FYWpDIe5j0NWKlw9hXsTyPY/HeZUV59akskSOSRSmDfe8wJDPX
58uB9/7lud0G3x0pxQAcffP0ayKavNwDTw4UfJ34cEw=
-----END CERTIFICATE-----
`;

/**
 * Intermedios embebidos, en el orden en que se ofrecen a Node junto con las
 * raíces. Sobran los que no firmen la hoja vigente: Node usa solo los que
 * necesita para armar la cadena.
 */
export const BCV_EMBEDDED_INTERMEDIATES = [
  SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_DV_R36,
  SECTIGO_PUBLIC_SERVER_AUTHENTICATION_CA_OV_R36,
] as const;
