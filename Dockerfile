# =============================================================================
# Imagen de producción de Liminal CRM.
#
#   docker build -t liminal-crm .
#   docker run -p 3000:3000 --env-file .env.production liminal-crm
#
# Tres etapas para que la imagen final no cargue con el código fuente ni con
# las dependencias de compilación.
# =============================================================================

# --- Dependencias -----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# Solo los manifiestos: mientras no cambien, Docker reutiliza esta capa y no
# vuelve a instalar nada.
COPY package.json package-lock.json* ./
RUN npm ci

# --- Compilación ------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Las NEXT_PUBLIC_* se incrustan en el bundle al compilar, así que tienen que
# estar acá y no solo al arrancar. No son secretos: la anon key de Supabase
# está pensada para viajar al navegador, protegida por RLS.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_CRM_TIME_ZONE=America/Caracas
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_CRM_TIME_ZONE=$NEXT_PUBLIC_CRM_TIME_ZONE

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- Ejecución --------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Usuario sin privilegios: si alguien logra ejecutar algo dentro del
# contenedor, que no sea como root.
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# El build standalone ya trae las dependencias que hacen falta.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# El orquestador reinicia el contenedor si el CRM deja de alcanzar la base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
