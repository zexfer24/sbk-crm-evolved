#!/usr/bin/env bash
#
# Despliegue a un servidor propio por SSH.
#
#   ./scripts/deploy.sh usuario@servidor
#   ./scripts/deploy.sh usuario@servidor /opt/sbk-motorcycles-crm    # ruta destino
#
# Qué hace, en orden:
#   1. Valida .env.production acá, antes de tocar el servidor.
#   2. Comprueba que el servidor tenga Docker y que el dominio le resuelva.
#   3. Copia el proyecto (sin node_modules, sin .git, sin respaldos).
#   4. Levanta el stack y espera a que el CRM responda sano.
#   5. Comprueba el TLS y deja dicho qué falta hacer a mano.
#
# Es idempotente: volver a correrlo actualiza el despliegue.
#
set -uo pipefail

HOST="${1:-}"
REMOTE_DIR="${2:-/opt/sbk-motorcycles-crm}"

if [[ -z "$HOST" ]]; then
  echo "Uso: $0 usuario@servidor [ruta-destino]" >&2
  exit 1
fi

paso()  { echo; echo "── $1"; }
falla() { echo "  ERROR: $1" >&2; exit 1; }

# ---------------------------------------------------------------------------
paso "1/5 · Validando la configuración local"

[[ -f .env.production ]] || falla ".env.production no existe. Copia .env.production.example y complétalo."

./scripts/preflight.sh || falla "preflight no pasó. Corrige lo de arriba antes de desplegar."

set -a; source .env.production; set +a
[[ -n "${DOMAIN:-}" ]] || falla "DOMAIN sin definir en .env.production."

# ---------------------------------------------------------------------------
paso "2/5 · Comprobando el servidor"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null \
  || falla "No se pudo entrar por SSH a $HOST. ¿Está tu clave autorizada allá?"
echo "  [ok]    SSH"

ssh "$HOST" 'command -v docker >/dev/null' \
  || falla "El servidor no tiene Docker. Instálalo: curl -fsSL https://get.docker.com | sh"
echo "  [ok]    Docker"

ssh "$HOST" 'docker compose version >/dev/null 2>&1' \
  || falla "El servidor no tiene el plugin de Compose (docker compose)."
echo "  [ok]    Docker Compose"

# El certificado TLS no se emite si el dominio todavía no apunta acá, y Caddy
# reintenta hasta que Let's Encrypt lo limita. Mejor saberlo ahora.
SERVER_IP=$(ssh "$HOST" 'curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null' || echo "")
DOMAIN_IP=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || echo "")

if [[ -z "$DOMAIN_IP" ]]; then
  echo "  [aviso] $DOMAIN todavía no resuelve. Caddy no podrá sacar el certificado."
elif [[ -n "$SERVER_IP" && "$DOMAIN_IP" != "$SERVER_IP" ]]; then
  echo "  [aviso] $DOMAIN apunta a $DOMAIN_IP y el servidor es $SERVER_IP."
else
  echo "  [ok]    $DOMAIN apunta a este servidor"
fi

# ---------------------------------------------------------------------------
paso "3/5 · Copiando el proyecto a $HOST:$REMOTE_DIR"

ssh "$HOST" "mkdir -p '$REMOTE_DIR'" || falla "No se pudo crear $REMOTE_DIR."

# --delete deja el destino igual al origen; los excluidos se conservan porque
# rsync no borra lo que no mira.
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git \
  --exclude backups --exclude '.env.local' \
  ./ "$HOST:$REMOTE_DIR/" || falla "Falló la copia."

# El .env va aparte y con permisos cerrados: lleva las llaves del negocio.
scp -q .env.production "$HOST:$REMOTE_DIR/.env.production" || falla "No se pudo copiar .env.production."
ssh "$HOST" "chmod 600 '$REMOTE_DIR/.env.production'"
echo "  [ok]    Proyecto copiado"

# ---------------------------------------------------------------------------
paso "4/5 · Levantando el stack (la primera vez compila, tarda)"

ssh "$HOST" "cd '$REMOTE_DIR' && docker compose --env-file .env.production up -d --build" \
  || falla "El stack no levantó. Mira: ssh $HOST 'cd $REMOTE_DIR && docker compose logs'"

echo "  Esperando a que el CRM responda sano ..."
SANO=false
for _ in $(seq 1 30); do
  ESTADO=$(ssh "$HOST" "cd '$REMOTE_DIR' && docker compose --env-file .env.production ps --format json app 2>/dev/null | head -1" || echo "")
  if echo "$ESTADO" | grep -q '"Health":"healthy"'; then SANO=true; break; fi
  sleep 5
done

if [[ "$SANO" != true ]]; then
  echo "  [aviso] El contenedor no llegó a 'healthy' en 2,5 minutos."
  echo "          Casi siempre es la base: revisa SUPABASE_SERVICE_ROLE_KEY."
  ssh "$HOST" "cd '$REMOTE_DIR' && docker compose --env-file .env.production logs --tail 30 app"
  exit 1
fi
echo "  [ok]    El CRM responde sano"

# ---------------------------------------------------------------------------
paso "5/5 · Comprobando desde fuera"

sleep 5
CODIGO=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/api/health" 2>/dev/null || echo "000")

if [[ "$CODIGO" == "200" ]]; then
  echo "  [ok]    https://$DOMAIN/api/health responde 200, con TLS válido"
else
  echo "  [aviso] https://$DOMAIN/api/health devolvió $CODIGO."
  echo "          Si el dominio acaba de apuntar acá, dale unos minutos a Caddy."
fi

echo
echo "─────────────────────────────────────────────────────────"
echo "Desplegado en https://$DOMAIN"
echo
echo "Falta hacer a mano, una sola vez:"
echo "  1. Migraciones:  supabase link --project-ref <ref> && supabase db push"
echo "  2. Webhook en Meta: https://$DOMAIN/api/webhooks/whatsapp"
echo "  3. Crear los usuarios del equipo y darles su rol"
echo "  4. Registrar el canal en whatsapp_channels con status='connected'"
echo "  5. Revisar las respuestas de la IA y ponerle tope de gasto"
echo
echo "El detalle de cada uno está en docs/PRODUCCION.md."
