#!/usr/bin/env bash
#
# Verifica que un respaldo de SBK Motorcycles CRM sea utilizable: que el gzip
# esté íntegro, que pese lo que pesa un volcado real y que contenga
# definiciones de tabla. Sale 0 si el respaldo está bien, distinto de 0 si no.
#
#   ./scripts/verificar-respaldo.sh backups/sbk-20260822-030000.sql.gz
#   TAMANO_MINIMO=2048 ./scripts/verificar-respaldo.sh backups/sbk-...sql.gz
#
# Solo verifica: NUNCA borra ni mueve el archivo, pase lo que pase. Eso queda
# a cargo de quien lo llama (ver scripts/backup.sh) — separar las dos cosas
# es lo que lo hace testeable sin arriesgar un respaldo real, y es la
# garantía de que este script no puede repetir el bug de más abajo aunque se
# equivoque: en el peor de los casos informa mal, nunca borra.
#
set -euo pipefail

ARCHIVO="${1:-}"
TAMANO_MINIMO="${TAMANO_MINIMO:-1024}"   # bytes; un volcado real nunca pesa menos

if [[ -z "$ARCHIVO" ]]; then
  echo "Uso: $0 <archivo.sql.gz>" >&2
  exit 1
fi

if [[ ! -f "$ARCHIVO" ]]; then
  echo "ERROR: no existe $ARCHIVO" >&2
  exit 1
fi

if ! gzip -t "$ARCHIVO" 2>/dev/null; then
  echo "ERROR: $ARCHIVO no es un gzip válido (corrupto o truncado)." >&2
  exit 1
fi

TAMANO=$(wc -c < "$ARCHIVO")
if [[ "$TAMANO" -lt "$TAMANO_MINIMO" ]]; then
  echo "ERROR: $ARCHIVO pesa $TAMANO bytes, menos que los $TAMANO_MINIMO mínimos. No parece un volcado real." >&2
  exit 1
fi

# El 29/8/2026 este mismo chequeo, escrito tal cual como
#
#   gzip -dc "$ARCHIVO" | grep -q "CREATE TABLE"
#
# borró un respaldo íntegro en el VPS. `grep -q` sale apenas encuentra la
# primera coincidencia y cierra su extremo de lectura de la tubería; `gzip`,
# que todavía estaba escribiendo, muere de SIGPIPE. El script que hacía este
# chequeo corre con `pipefail`, así que el estado del pipe pasó a ser 141 en
# vez de 0, el `if !` lo leyó como "el respaldo está corrupto", y el `rm -f`
# de al lado se llevó puesto un archivo sano. Solo se ve con volcados
# grandes: uno chico cabe entero en el buffer de la tubería (64 KB) y `gzip`
# termina de escribir antes de que `grep` cierre. Medido en el VPS con un
# volcado de 3,8 MB:
#
#   ( set -o pipefail; gzip -dc "$T" | cat > /dev/null; echo $? )        -> 0
#   ( set -o pipefail; gzip -dc "$T" | grep -q "CREATE TABLE"; echo $? ) -> 141
#
# La corrección es aislar el `pipefail` en un subshell propio para este
# chequeo puntual: con `pipefail` apagado ahí adentro, el estado de la
# tubería vuelve a ser el del último comando (`grep`), no el de `gzip`, y un
# SIGPIPE del productor deja de leerse como respaldo corrupto. La alternativa
# de drenar la tubería entera (agregar `| cat > /dev/null` antes o después)
# solo cambia el timing del cierre; esto ataca la causa, no el síntoma.
if ! (set +o pipefail; gzip -dc "$ARCHIVO" | grep -q "CREATE TABLE"); then
  echo "ERROR: $ARCHIVO no contiene definiciones de tabla." >&2
  exit 1
fi

echo "OK: $ARCHIVO parece un respaldo válido ($TAMANO bytes)."
exit 0
