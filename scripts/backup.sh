#!/usr/bin/env bash
#
# Respaldo de la base de SBK Motorcycles CRM.
#
# Ahí viven las conversaciones y las ventas del negocio: es el dato que no se
# puede volver a generar. Corre con cron y guarda una copia comprimida por
# día, borrando las que pasen de RETENTION_DAYS.
#
#   ./scripts/backup.sh                      # usa DATABASE_URL del entorno
#   DATABASE_URL=postgres://... ./scripts/backup.sh
#   BACKUP_DIR=/var/backups/sbk ./scripts/backup.sh
#
# Restaurar: ./scripts/restore.sh <archivo.sql.gz>
#
set -euo pipefail

# Resuelto contra la ubicación del propio script, no contra el directorio de
# trabajo: este script corre por cron, que no siempre invoca desde la raíz
# del repo.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
TARGET="$BACKUP_DIR/sbk-$STAMP.sql.gz"

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
#  3. Nada de `--no-privileges`. Sin los GRANT, la base restaura todos los
#     datos pero `service_role` y `authenticated` no pueden leer nada: la
#     aplicación queda en pie contra una base que le dice que no. Se detectó
#     porque /api/health empezó a responder 503 después de restaurar.
#
#  4. Se filtran las `ALTER DEFAULT PRIVILEGES`: el rol de conexión no puede
#     cambiar los privilegios por defecto de otro rol y la restauración muere
#     con "permission denied to change default privileges". Solo afectan a
#     objetos FUTUROS; los GRANT de las tablas restauradas van aparte y esos
#     sí se conservan.
#
# `--table` y `--schema` no se combinan: al pasar `--table`, pg_dump ignora
# el `--schema`. De ahí que sean dos invocaciones.
#
# storage.objects guarda las rutas, no los archivos: el contenido del bucket
# se respalda aparte (ver docs/PRODUCCION.md).
{
  pg_dump "$DATABASE_URL" \
    --quote-all-identifiers --no-owner \
    --schema=public

  # Idempotente: si el usuario ya existe en el destino, no rompe.
  pg_dump "$DATABASE_URL" \
    --data-only --inserts --on-conflict-do-nothing --no-owner \
    --table=auth.users --table=auth.identities \
    --table=storage.buckets --table=storage.objects
} | grep -v '^ALTER DEFAULT PRIVILEGES' | gzip -9 > "$TARGET"

# La verificación (gzip íntegro, tamaño mínimo, contiene tablas) vive en
# verificar-respaldo.sh. Acá solo se decide qué hacer si falla: el 29/8/2026
# este mismo bloque hacía `rm -f "$TARGET"` sobre un respaldo que en realidad
# estaba íntegro (ver el comentario de verificar-respaldo.sh para la causa
# exacta), así que ya no se borra nada — un respaldo que el verificador
# rechaza se aparta con sufijo `.sospechoso` para que alguien lo mire antes
# de perderlo.
if ! "$SCRIPT_DIR/verificar-respaldo.sh" "$TARGET"; then
  SOSPECHOSO="$TARGET.sospechoso"
  mv "$TARGET" "$SOSPECHOSO"
  echo "ERROR: el respaldo no pasó la verificación. Se apartó SIN BORRAR en:" >&2
  echo "  $SOSPECHOSO" >&2
  echo "Revísalo a mano (gzip -t, gzip -dc | less) antes de descartarlo." >&2
  exit 1
fi

SIZE=$(wc -c < "$TARGET")
echo "Listo: $TARGET ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes"))"

DELETED=$(find "$BACKUP_DIR" -name 'sbk-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
[[ "$DELETED" -gt 0 ]] && echo "Se borraron $DELETED respaldos de más de $RETENTION_DAYS días."

exit 0
