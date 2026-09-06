-- ============================================================================
-- Frente B (plan "El reloj dice la verdad", 5/9/2026) — B1
--
-- El horario de la tienda no existe en el sistema: solo vive como texto en
-- una respuesta rápida del seed y en lo que haya escrito en la biblioteca.
-- `escalate.ts` elige "asesor activo" por `agents.is_active` (cuenta
-- habilitada), no por turno, y la despedida al escalar sin asesores no puede
-- decirle al cliente cuándo lo atienden porque no hay dónde leer cuándo abre
-- la tienda. Esta migración le da al agente de IA (y al futuro tablero, que
-- lo usará para medir el atasco de "Con asesor" con horas laborales en vez
-- de horas de pared) un lugar único donde vive ese horario.
--
-- Forma elegida: un jsonb con las siete llaves de la semana en inglés corto
-- (mon..sun), cada una una lista de franjas [inicio, fin] en formato "HH:MM".
-- La lista vacía es "cerrado" ese día; más de una franja permite horario
-- partido (ej. mañana y tarde) sin cambiar la forma. Las horas son LOCALES de
-- America/Caracas -- la zona horaria del equipo vive en
-- `src/lib/time-zone.ts`, no acá; esta columna no la duplica.
--
-- El default reproduce el supuesto del orquestador: lunes a viernes 08:00 a
-- 18:00, sábado y domingo cerrado (es lo que ya dice el seed en prosa).
-- ============================================================================

alter table public.agent_settings
  add column business_hours jsonb not null default
    '{"mon":[["08:00","18:00"]],"tue":[["08:00","18:00"]],"wed":[["08:00","18:00"]],"thu":[["08:00","18:00"]],"fri":[["08:00","18:00"]],"sat":[],"sun":[]}'::jsonb;

alter table public.agent_settings
  add constraint agent_settings_business_hours_object
  check (jsonb_typeof(business_hours) = 'object');

comment on column public.agent_settings.business_hours is
  'Horario de la tienda: objeto jsonb con llaves mon..sun, cada una una lista de franjas [inicio, fin] en "HH:MM" (lista vacía = cerrado ese día; más de una franja permite horario partido). Horas LOCALES de America/Caracas (la zona vive en src/lib/time-zone.ts, no acá). La IA lo lee en cada turno para saber si está dentro o fuera de horario, y el tablero lo usa para medir el atasco de "Con asesor" en horas laborales. RLS sin cambios: agent_settings_update (20260820050000) ya exige supervisor/admin; lectura abierta a cualquier agente.';
