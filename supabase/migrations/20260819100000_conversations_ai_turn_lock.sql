-- Lock atómico por conversación para el turno de la IA: evita que dos
-- webhooks casi simultáneos para la misma conversación disparen dos turnos
-- en paralelo (doble respuesta al cliente, doble costo de LLM, posible doble
-- escalamiento). Se adquiere con un UPDATE ... WHERE condicional -- atómico
-- a nivel de Postgres incluso con múltiples instancias del proceso Node.
alter table conversations
  add column if not exists ai_turn_running boolean not null default false;
