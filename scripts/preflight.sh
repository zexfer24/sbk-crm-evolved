#!/usr/bin/env bash
#
# Comprobaciones previas al despliegue.
#
#   ./scripts/preflight.sh
#
# Revisa lo que se puede revisar sin hablar con Meta ni con OpenAI. La idea es
# que los errores salgan acá y no con clientes reales esperando respuesta.
#
# Lee .env.production si existe; si no, el entorno actual.
#
set -uo pipefail

FALLOS=0
AVISOS=0

ok()    { echo "  [ok]    $1"; }
falla() { echo "  [FALLA] $1"; FALLOS=$((FALLOS + 1)); }
aviso() { echo "  [aviso] $1"; AVISOS=$((AVISOS + 1)); }

if [[ -f .env.production ]]; then
  set -a; source .env.production; set +a
  echo "Leyendo .env.production"
else
  echo "Sin .env.production: se usa el entorno actual"
fi

echo
echo "── Variables ─────────────────────────────────────────────"

for v in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  [[ -n "${!v:-}" ]] && ok "$v" || falla "$v sin definir"
done

# Sin esta, el webhook responde 503 en producción y no procesa nada.
[[ -n "${WHATSAPP_APP_SECRET:-}" ]] && ok "WHATSAPP_APP_SECRET" \
  || falla "WHATSAPP_APP_SECRET sin definir — el webhook rechazará todo en producción"

[[ -n "${WHATSAPP_ACCESS_TOKEN:-}" ]] && ok "WHATSAPP_ACCESS_TOKEN" \
  || aviso "WHATSAPP_ACCESS_TOKEN sin definir — no se podrá enviar por WhatsApp"

[[ -n "${CRON_SECRET:-}" ]] && ok "CRON_SECRET" \
  || aviso "CRON_SECRET sin definir — la cola no tendrá red de seguridad"

if [[ -z "${OPENAI_API_KEY:-}" && -z "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]]; then
  aviso "Sin clave de OpenAI ni de Google — la IA no podrá responder"
else
  ok "Clave del proveedor de IA"
fi

echo
echo "── Coherencia ────────────────────────────────────────────"

# La anon key en el lugar del service role es un error que no avisa: la app
# arranca y falla al escribir, ya en producción.
if [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" && "${SUPABASE_SERVICE_ROLE_KEY:-}" == "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ]]; then
  falla "SUPABASE_SERVICE_ROLE_KEY es igual a la anon key — están cruzadas"
else
  ok "Las claves de Supabase son distintas entre sí"
fi

if [[ "${NEXT_PUBLIC_SUPABASE_URL:-}" == *"127.0.0.1"* || "${NEXT_PUBLIC_SUPABASE_URL:-}" == *"localhost"* ]]; then
  falla "NEXT_PUBLIC_SUPABASE_URL apunta a localhost — es la instancia de desarrollo"
else
  ok "La URL de Supabase no es local"
fi

if [[ -n "${CRON_SECRET:-}" && ${#CRON_SECRET} -lt 24 ]]; then
  aviso "CRON_SECRET tiene ${#CRON_SECRET} caracteres — conviene 32 o más"
fi

echo
echo "── Código ────────────────────────────────────────────────"

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
[[ "$NODE_MAJOR" -ge 22 ]] && ok "Node $NODE_MAJOR" \
  || falla "Node $NODE_MAJOR — hace falta 22 o más (whatwg-url lo exige)"

# La contraseña de demo llegó a estar en el bundle: se comprueba que no vuelva.
if grep -rq "Liminal123" src/ 2>/dev/null; then
  falla "La contraseña de demo aparece en src/ — no puede viajar al navegador"
else
  ok "Sin credenciales de demo en el código"
fi

echo
echo "──────────────────────────────────────────────────────────"
if [[ "$FALLOS" -gt 0 ]]; then
  echo "$FALLOS fallas y $AVISOS avisos. No despliegues hasta resolver las fallas."
  exit 1
fi

echo "Todo en orden ($AVISOS avisos)."
echo "Falta lo que solo se comprueba con el servicio arriba: el handshake de"
echo "Meta, un mensaje real llegando a la bandeja y la restauración de un"
echo "respaldo. Está en la lista final de docs/PRODUCCION.md."
exit 0
