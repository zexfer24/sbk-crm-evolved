-- Tokens de entrada servidos desde el caché de prompts del proveedor.
--
-- Se separan de input_tokens porque se facturan mucho más barato: sin esta
-- columna el panel de costos cobra todo a precio completo y sobrestima el
-- gasto real del agente.
--
-- Es además la única señal de que el prefijo estático del prompt sigue
-- cacheando. El caché exige que el prefijo se repita byte por byte; si
-- alguien edita SYSTEM_PROMPT y mete algo antes, deja de cachear en silencio
-- y esta columna cae a cero. Nada más lo delataría.
--
-- Nullable y sin default: las filas anteriores a esta migración se quedan en
-- null, que es lo correcto — no es que no cachearan, es que no se medía.

alter table public.agent_turns
  add column if not exists cached_input_tokens integer;

comment on column public.agent_turns.cached_input_tokens is
  'Parte de input_tokens servida desde el caché de prompts del proveedor. null en turnos anteriores a que se midiera.';
