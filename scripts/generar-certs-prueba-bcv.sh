#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Genera los certificados de PRUEBA de bcv-chain.test.ts / bcv-fetch.test.ts.
# (21/11/2026, plan "La cadena TLS del BCV se arma sola".)
#
# Por qué existen: el armado de la cadena por AIA (bcv-chain.ts) se prueba sin
# red y sin depender de los certificados reales de Sectigo, que caducan. Estos
# son sintéticos, con fechas fijas, y cubren cada motivo de rechazo.
#
# Requisitos: bash + openssl >= 3.4 (usa `openssl x509 -not_before/-not_after`,
# que llegó en 3.4; con una versión anterior habría que pasar a `openssl ca`
# con -startdate/-enddate). Probado con OpenSSL 3.5.6. Claves EC P-256.
#
# Las llaves privadas se generan en un directorio temporal y se BORRAN al
# terminar: en el repo solo quedan los .pem de certificados (públicos).
# Uso:  bash scripts/generar-certs-prueba-bcv.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# Git Bash en Windows reescribe los argumentos que empiezan con "/" (como
# -subj "/CN=..."); esto lo apaga.
export MSYS_NO_PATHCONV=1

RAIZ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SALIDA="$RAIZ_DIR/src/lib/ai/__fixtures__/bcv-certs"
TMP="$(mktemp -d)"
# El openssl de Windows no entiende el /tmp de Git Bash: se le pasa la ruta en
# formato Windows, igual que la carpeta de salida (cygpath no existe fuera de Git Bash/MSYS, de ahí el if).
if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; SALIDA="$(cygpath -m "$SALIDA")"; fi
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$SALIDA"
rm -f "$SALIDA"/*.pem "$SALIDA"/*.der

DESDE="20200101000000Z"
HASTA="20991231235959Z"

llave() { openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/$1.key"; }

# autofirmado <nombre> <CN>
autofirmado() {
  cat > "$TMP/$1.ext" <<EXT
basicConstraints=critical,CA:true
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
EXT
  openssl req -new -key "$TMP/$1.key" -subj "/C=VE/O=Prueba BCV/CN=$2" -out "$TMP/$1.csr"
  openssl x509 -req -in "$TMP/$1.csr" -signkey "$TMP/$1.key" -extfile "$TMP/$1.ext" \
    -not_before "$DESDE" -not_after "$HASTA" -out "$SALIDA/$1.pem"
}

# firmar <nombre> <llave-del-sujeto> <CN> <ca-firmante> <extensiones> <desde> <hasta>
firmar() {
  local nombre="$1" llave_sujeto="$2" cn="$3" firmante="$4" ext="$5" desde="$6" hasta="$7"
  printf '%s\n' "$ext" > "$TMP/$nombre.ext"
  openssl req -new -key "$TMP/$llave_sujeto.key" -subj "/C=VE/O=Prueba BCV/CN=$cn" -out "$TMP/$nombre.csr"
  openssl x509 -req -in "$TMP/$nombre.csr" -CA "$SALIDA/$firmante.pem" -CAkey "$TMP/$firmante.key" \
    -CAcreateserial -CAserial "$TMP/serial" -extfile "$TMP/$nombre.ext" \
    -not_before "$desde" -not_after "$hasta" -out "$SALIDA/$nombre.pem"
}

EXT_CA=$'basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always'
EXT_NO_CA=$'basicConstraints=critical,CA:false\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always'
ext_hoja() {
  printf '%s\n' "basicConstraints=critical,CA:false" "subjectAltName=DNS:www.bcv.org.ve" \
    "subjectKeyIdentifier=hash" "authorityKeyIdentifier=keyid:always" \
    "authorityInfoAccess=caIssuers;URI:$1"
}

for k in raiz raiz-ajena intermedio intermedio-otra hoja; do llave "$k"; done

autofirmado raiz "Raiz de Prueba"
autofirmado raiz-ajena "Raiz Ajena de Prueba"

# El intermedio bueno, y cuatro variantes con el MISMO subject (así el nombre
# del emisor de la hoja calza con todas y lo que las distingue es solo el
# motivo de rechazo que se quiere probar).
firmar intermedio              intermedio       "Intermedio de Prueba" raiz        "$EXT_CA"    "$DESDE" "$HASTA"
firmar intermedio-otra-llave   intermedio-otra  "Intermedio de Prueba" raiz        "$EXT_CA"    "$DESDE" "$HASTA"
firmar intermedio-sin-raiz     intermedio       "Intermedio de Prueba" raiz-ajena  "$EXT_CA"    "$DESDE" "$HASTA"
firmar intermedio-vencido      intermedio       "Intermedio de Prueba" raiz        "$EXT_CA"    "$DESDE" "20210101000000Z"
firmar intermedio-no-ca        intermedio       "Intermedio de Prueba" raiz        "$EXT_NO_CA" "$DESDE" "$HASTA"

firmar hoja            hoja "www.bcv.org.ve" intermedio "$(ext_hoja http://crt.sectigo.com/IntermedioPrueba.crt)"      "$DESDE" "$HASTA"
firmar hoja-aia-fuera  hoja "www.bcv.org.ve" intermedio "$(ext_hoja http://crt.ejemplo-malicioso.com/x.crt)" "$DESDE" "$HASTA"

# DER del intermedio bueno: el AIA real sirve DER, así que se prueba ese parseo.
openssl x509 -in "$SALIDA/intermedio.pem" -outform DER -out "$SALIDA/intermedio.der"

echo "Certificados de prueba generados en $SALIDA"
ls "$SALIDA"
