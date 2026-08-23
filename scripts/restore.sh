#!/usr/bin/env bash
#
# Restaura un respaldo de SBK Motorcycles CRM.
#
#   ./scripts/restore.sh backups/sbk-20260822-030000.sql.gz
#
# SOBRESCRIBE la base de destino. Pide confirmación escrita salvo que se pase
# --yes, para que no se ejecute de memoria contra la base equivocada.
#
# Un respaldo que nunca se restauró no es un respaldo: prueba esto contra una
# base de repuesto antes de necesitarlo de verdad.
#
set -euo pipefail

ARCHIVE="${1:-}"
ASSUME_YES=false
[[ "${2:-}" == "--yes" || "${1:-}" == "--yes" ]] && ASSUME_YES=true

if [[ -z "$ARCHIVE" || "$ARCHIVE" == "--yes" ]]; then
  echo "Uso: $0 <archivo.sql.gz> [--yes]" >&2
  exit 1
fi

[[ -f "$ARCHIVE" ]] || { echo "ERROR: no existe $ARCHIVE" >&2; exit 1; }

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: falta DATABASE_URL (la base DESTINO, la que se va a sobrescribir)." >&2
  exit 1
fi

command -v psql >/dev/null 2>&1 || { echo "ERROR: psql no está instalado." >&2; exit 1; }

# Se valida el archivo antes de tocar nada: descubrir que el respaldo estaba
# corrupto a mitad de la restauración es la peor forma de enterarse.
gzip -t "$ARCHIVE" || { echo "ERROR: el archivo está corrupto." >&2; exit 1; }

# Se oculta la contraseña al mostrar contra qué base se va a restaurar.
SAFE_URL=$(echo "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]+(@)#\1****\2#')

echo "Se va a RESTAURAR $ARCHIVE"
echo "SOBRE la base:   $SAFE_URL"
echo "Todo lo que haya ahí ahora se pierde."

if [[ "$ASSUME_YES" != true ]]; then
  read -r -p 'Escribe "restaurar" para continuar: ' ANSWER
  [[ "$ANSWER" == "restaurar" ]] || { echo "Cancelado."; exit 1; }
fi

# El esquema se tira acá y no con el `--clean` de pg_dump: ese DROP falla
# sobre funciones de las que dependen triggers de `auth`, y aborta a mitad
# dejando la base peor que antes. Un `drop schema ... cascade` se lleva todo
# de una vez, dependencias incluidas.
#
# Se tira pero NO se recrea: el propio volcado trae su `CREATE SCHEMA public`
# y chocaría con uno ya existente.
echo "Vaciando el esquema public ..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --quiet \
  -c 'drop schema if exists public cascade;'

echo "Restaurando ..."
gzip -dc "$ARCHIVE" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --quiet

echo "Restauración terminada. Comprueba que la base quedó como esperabas:"
echo "  select count(*) from public.conversations;"
echo "  select count(*) from public.messages;"
echo "  select count(*) from auth.users;"
