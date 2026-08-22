# Liminal CRM

CRM multiagente para ventas por WhatsApp con automatización de IA. Bandeja de
entrada compartida, control de la ventana de 24h de WhatsApp, plantillas de
reapertura, mensajes rápidos administrables, citar mensajes (con reply nativo
de WhatsApp), multimedia (imágenes/audio/video con galería), modo supervisor,
ficha de cliente (incluye cédula/estado/ciudad/dirección) y cierre de venta.
Ya conectado de verdad a la WhatsApp Cloud API de Meta (webhook + envío).

## Stack

- **Next.js 16** (App Router, Turbopack) + TypeScript
- **HeroUI v3** (`@heroui/react`) + Tailwind CSS v4 + Framer Motion
- **Supabase** self-hosted vía Docker (Postgres, Auth, Realtime, Storage) —
  corre localmente ahora, mismo stack que se despliega luego a un VPS
- **lucide-react** para iconografía

## Requisitos

- Node.js 20+
- Docker Desktop corriendo (para la instancia local de Supabase)
- No hace falta instalar la CLI de Supabase globalmente: se usa vía `npx`

## Arranque rápido

```bash
# 1. Instalar dependencias (si no lo has hecho)
npm install

# 2. Levantar Supabase local (Postgres + Auth + Realtime + Storage + Studio)
npx supabase start

# 3. Aplicar el schema + datos de prueba
npx supabase db reset

# 4. Arrancar la app
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000). Te redirige a `/login`.

### Usuarios de prueba

| Correo | Contraseña | Rol |
|---|---|---|
| `jose@liminal.test` | `Liminal123!` | supervisor |
| `maria@liminal.test` | `Liminal123!` | agent (aparece como "ASESOR 2") |
| `carlos@liminal.test` | `Liminal123!` | agent (aparece como "ASESOR 3") |

Los datos de prueba (`supabase/seed.sql`) incluyen 5 conversaciones ya armadas
para poder probar cada caso sin tener la conexión real a Meta:

- **Ana Torres** — dentro de la ventana de 24h, 2 mensajes sin leer, venta en curso.
- **Carlos Mendoza** — sin asignar, 1 mensaje sin leer.
- **Laura Fernández** — **fuera** de la ventana de 24h (demuestra el bloqueo del
  input y el aviso de plantillas), IA pausada por el supervisor.
- **Roberto Nuñez** — venta ya cerrada.
- **Diana López** — sin asignar, 3 mensajes sin leer.

Otras herramientas útiles:

- Supabase Studio (inspeccionar/editar tablas): http://127.0.0.1:54323
- Mailpit (correos de auth capturados localmente): http://127.0.0.1:54324
- `npx supabase status` — muestra URLs y claves de conexión
- `npx supabase stop` — apaga los contenedores

## Estructura del schema (`supabase/migrations/`)

- `agents` — perfil de cada agente/supervisor (1:1 con `auth.users`, se crea
  automáticamente al registrarse vía Supabase Auth)
- `whatsapp_channels` — buzones/números de WhatsApp Business (Meta Cloud API),
  soporta **multi-buzón** desde el diseño
- `contacts` / `tags` / `contact_tags` — clientes y su categorización
- `conversations` — un hilo = un contacto + un buzón; guarda `ai_enabled`,
  `unread_count`, `assigned_agent_id`, `deal_status`, y
  `last_customer_message_at` (base de la ventana de 24h)
- `messages` — mensajes reales **y** eventos de sistema (`sender_type='system'`)
  para el rastro de auditoría en la burbuja de chat; `is_internal_note` marca
  mensajes que no salen por WhatsApp
- `notes` — notas internas del contacto
- `templates` — plantillas preaprobadas por Meta para reabrir chats
- `quick_replies` — mensajes predefinidos que se cargan (editables) en el
  composer, compartidos entre todos los agentes
- `contacts` también guarda `cedula_type`/`cedula_number` (V/E), `state`
  (los 24 estados de Venezuela, con check constraint), `city` y `address` —
  se completan desde el modal que abre el botón "Cerrar venta"
- `messages` también guarda `reply_to_message_id` (citar un mensaje, cliente
  o nuestro, en cualquier dirección)
- bucket de Storage `whatsapp-media` (público) para las fotos/audios/videos
  que entran y salen por WhatsApp

RLS está activo en todas las tablas: cualquier agente autenticado (con fila en
`public.agents`) puede leer/escribir todo — es un CRM interno compartido, no
multi-tenant. `messages`, `conversations` y `quick_replies` están publicadas
en `supabase_realtime` para que la bandeja se sincronice en vivo entre agentes.

## Conexión real con Meta (WhatsApp Cloud API)

Ya está implementada y conectada (ver `.env.local`: `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`,
`WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`):

- `src/app/api/webhooks/whatsapp/route.ts` — recibe mensajes entrantes
  (texto y multimedia, con reply nativo) y actualizaciones de estado
  (sent/delivered/read/failed) de Meta, y los escribe en Supabase con la
  service role key (sin sesión de usuario).
- `src/app/api/messages/send/route.ts` — ruta que usa el composer para
  enviar: si el canal de la conversación está `connected`, llama a la Cloud
  API de verdad (el access token nunca toca el navegador); si no, solo
  simula el envío en la base (canales de demo).
- `src/lib/whatsapp/meta-client.ts` — cliente server-only de la Graph API
  (texto, plantillas, multimedia por link, reply/context, descarga de media).

Para conectar un canal nuevo: agrega su `phone_number_id`/`waba_id` real en
`whatsapp_channels` y ponle `status='connected'`. El access token hoy es
global (una sola variable de entorno) — si necesitas tokens distintos por
número, hay que extender `whatsapp_channels` para guardar la referencia al
secreto de cada uno.

El webhook necesita una URL pública para que Meta le llegue (no funciona con
`localhost` a secas) — en desarrollo se puede usar un túnel temporal como
`cloudflared tunnel --url http://localhost:3000`.

### `WHATSAPP_APP_SECRET` es obligatoria en producción

El webhook verifica la firma `X-Hub-Signature-256` de cada request contra
esta variable (el "app secret" de la app de Meta, en Configuración >
Básica). **Si no está definida, el webhook acepta cualquier POST** — se
deja pasar a propósito para que funcione en local, donde Meta nunca llega
a llamar el endpoint, y queda avisado en consola.

Desplegar sin ella significa que cualquiera que descubra la URL del
webhook puede inyectar mensajes falsos, hacer que la IA le responda a
clientes inventados y gastar la cuota del modelo. Configúrala antes de
apuntar Meta a producción.

## Desplegar en un VPS (self-hosted)

Esta primera entrega corre Supabase local vía `supabase start` (Docker). Para
producción en un VPS se usa el mismo schema de migraciones contra el
`docker-compose.yml` oficial de [self-hosting de
Supabase](https://supabase.com/docs/guides/self-hosting/docker), o contra una
instancia remota con `supabase db push`. Es infraestructura pendiente, fuera
del alcance de esta entrega (ver conversación de diseño).
