#!/usr/bin/env bash
#
# Respaldo de la base de Liminal CRM.
#
# Ahí viven las conversaciones y las ventas del negocio: es el dato que no se
# puede volver a generar. Corre con cron y guarda una copia comprimida por
# día, borrando las que pasen de RETENTION_DAYS.
#
#   ./scripts/backup.sh                      # usa DATABASE_URL del entorno
#   DATABASE_URL=postgres://... ./scripts/backup.sh
#   BACKUP_DIR=/var/backups/liminal ./scripts/backup.sh
#
# Restaurar: ./scripts/restore.sh <archivo.sql.gz>
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: falta DATABASE_URL." >&2
  echo "  Local:      postgresql://postgres:postgres@127.0.0.1:54322/postgres" >&2
  echo "  Producción: la cadena de conexión de tu instancia." >&2
  exit 1
fi

command -v pg_dump >/dev/null 2>&1 || { echo "ERROR: pg_dump no está instalado." >&2; exit 1; }

mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/liminal-$STAMP.sql.gz"

echo "Respaldando en $TARGET ..."

# Dos volcados en un mismo archivo. Los dos detalles de abajo salieron de
# restaurar de verdad contra una base, no de leer la documentación:
#
#  1. Volcar los esquemas `auth` o `storage` completos falla: traen tablas
#     internas de la plataforma (storage.vector_indexes) cuyo dueño no es el
#     rol de conexión, y la restauración muere con "must be owner of table".
#     Por eso de esos esquemas se sacan solo las tablas con datos nuestros.
#
#  2. Nada de `--clean`. El DROP de public.handle_new_agent() falla porque un
#     trigger de auth.users depende de ella, y la restauración aborta a mitad
#     dejando la base peor que antes. Limpiar es tarea de restore.sh, que
#     rehace el esquema entero de una vez.
#
# `--table` y `--schema` no se combinan: al pasar `--table`, pg_dump ignora
# el `--schema`. De ahí que sean dos invocaciones.
#
# storage.objects guarda las rutas, no los archivos: el contenido del bucket
# se respalda aparte (ver docs/PRODUCCION.md).
{
  pg_dump "$DATABASE_URL" \
    --quote-all-identifiers --no-owner --no-privileges \
    --schema=public

  # Idempotente: si el usuario ya existe en el destino, no rompe.
  pg_dump "$DATABASE_URL" \
    --data-only --inserts --on-conflict-do-nothing --no-owner --no-privileges \
    --table=auth.users --table=auth.identities \
    --table=storage.buckets --table=storage.objects
} | gzip -9 > "$TARGET"

# Un archivo vacío o truncado no es un respaldo: se verifica que el gzip esté
# íntegro y que el volcado tenga contenido antes de dar el paso por bueno.
gzip -t "$TARGET"
SIZE=$(wc -c < "$TARGET")
if [[ "$SIZE" -lt 1024 ]]; then
  echo "ERROR: el respaldo pesa $SIZE bytes, algo falló." >&2
  rm -f "$TARGET"
  exit 1
fi

if ! gzip -dc "$TARGET" | grep -q "CREATE TABLE"; then
  echo "ERROR: el respaldo no contiene definiciones de tabla." >&2
  rm -f "$TARGET"
  exit 1
fi

echo "Listo: $TARGET ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes"))"

DELETED=$(find "$BACKUP_DIR" -name 'liminal-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
[[ "$DELETED" -gt 0 ]] && echo "Se borraron $DELETED respaldos de más de $RETENTION_DAYS días."

exit 0
