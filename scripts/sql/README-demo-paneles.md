# Datos demo de los paneles (solo base local)

1. Cargar (como postgres, abre su propia transacción; idempotente, borra lo demo previo): `docker exec -i supabase_db_Liminal_CRM psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/sql/demo-paneles.sql`
2. Borrar (deja la base como antes; imprime ceros): mismo comando con `scripts/sql/demo-paneles-borrar.sql`. Lo demo se reconoce por `profile_name = 'DEMO-PANELES'`, `nota = 'DEMO-PANELES'`, `saint_code 'DEMO-%'` y `source = 'demo-paneles'`.
3. Qué crea: 30 días de actividad: 180 conversaciones/contactos, ~870 mensajes, 13 productos `DEMO-xxx`, 121 envíos a SAINT por `enviar_borrador_saint` (116 creado, 3 pendiente, 2 error, 1 posible duplicado, 3 sin monto) y 10 presupuestos/carritos activos sin enviar.
4. Cifras esperadas en `panel_ventas(now()-30 días, now())` como jose: online 69 envíos / ~5.975 $ (ticket ~89 $), tienda 46 / ~3.695 $; 1 genérico excluido, 3 en tránsito (~332 $), 2 en error. `panel_cola()`: 4 pendientes (2 con dueño) + las abandonadas (1 demo de 20 días).
5. Perilla: `v_factor` en la sección 2 de la carga multiplica las cantidades (a 5–6 el avance se acerca a la meta diaria del seed, 2.600 $ online / 1.800 $ tienda). Las cifras se desplazan con la fecha de la corrida; no usar contra producción.
