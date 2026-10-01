# Entrega "La ronda del cliente", 1/10/2026

Para el Claude del VPS. Plan aprobado: `docs/planes/2026-09-30-ronda-del-cliente.md`.

**No se pushea a `main` directo.** Un push a `main` despliega solo (Dokploy).
La rama es **`entrega/ronda-del-cliente`**, partida de `48fd9ea`.

**Antes de calcular nada, confirmar que producción está en `48fd9ea`.** Si
está en otro commit, recalcular el rango con `git log 48fd9ea..` sobre el
commit real.

## Qué hay en la rama

`git log --oneline 48fd9ea..origin/entrega/ronda-del-cliente`, del más viejo
al más nuevo:

```
6b053f9 La URL de un catálogo ya no se sale de su tarjeta en Control IA            (T1, solo CSS)
07afba5 El inventario del chat muestra primero lo que más hay y se borra con un clic (T3)
235a293 Un administrador cambia nombres y contraseñas desde Control IA               (T6, PATCH /api/agents/[id])
ec71ecc La sección «Casos» muestra los chats en un tablero Kanban por etiqueta      (T7, ruta /casos)
555583a El carrito del chat se copia o se pasa al cuadro de mensaje con un clic      (T4)
fc5a004 [migración] Los mensajes rápidos pueden tener dueño y solo él los ve         (T5a, 20261001010000)
91d634e El modal de mensajes rápidos deja de mostrar una píldora gigante al editar   (T2)
ed817df Cada asesor tiene sus propios mensajes rápidos, que nadie más ve             (T5b)
+ esta nota (punta de la rama)
```

## Commit por commit

En todos los commits: no hay variables de entorno nuevas ni cambios en el
compose. Lo que no lista una verificación propia se verifica con el paso 5 de
abajo.

**`6b053f9` (T1).** Solo CSS: una URL larga ya no se sale de la tarjeta de
catálogo en Control IA.

**`07afba5` (T3).**
- El inventario del chat ordena en SQL: activos primero, después mayor stock,
  nombre e id. «Ver más» pagina igual que antes.
- Hay un botón ✕ que borra la búsqueda y no toca el carrito.

**`235a293` (T6).**
- Ruta `PATCH /api/agents/[id]`, solo para **admin**. Un supervisor o un
  asesor reciben 403 sin que se cree el cliente admin.
- Cambia el nombre (`agents.display_name` más `user_metadata`) y la
  contraseña (`auth.admin.updateUserById`).
- La contraseña nunca va a los logs. El log que deja es `asesor_editado`, con
  los nombres de los campos.
- Usa la `service_role` que ya existe.
- **Verificar:** que la pestaña «Equipo» aparezca solo para un admin.

**`ec71ecc` (T7).**
- Ruta nueva `/casos`, con su entrada en el rail.
- Tablero de columnas por etiqueta del contacto, solo con conversaciones
  abiertas, más la columna «Sin etiqueta». Tope de 500, y si se llega al tope
  la pantalla lo dice.
- Arrastrar una tarjeta (o usar «Mover a…») cambia la etiqueta del contacto.
- No tiene migración: usa `contact_tags` como hasta ahora.

**`555583a` (T4).**
- El carrito del chat tiene los botones «Copiar» y «Enviar al chat».
- «Enviar al chat» pone el texto en el cuadro del mensaje **sin enviarlo**.
- Los precios son los vigentes (`priceCartLines`).

**`fc5a004` (T5a) — `[migración]`.**
- Agrega `quick_replies.owner_id`, nullable y con
  `on delete cascade` sobre `agents`, más su índice.
- `quick_replies_all` se reemplaza por cuatro políticas con el predicado
  `is_agent() and (owner_id is null or owner_id = auth.uid())`.
- Las filas actuales quedan en `null`, es decir, compartidas y visibles para
  todos como hasta hoy.
- Va **antes** del código, y es segura con el código viejo: ese código no pide
  `owner_id`, y lo que inserta nace en `null`.
- Sin la migración, el código nuevo da 400 al leer los mensajes rápidos.

**`91d634e` (T2).** Al editar un mensaje rápido ya no se ve una píldora
gigante detrás del modal.

**`ed817df` (T5b).**
- El modal tiene dos pestañas, «Compartidos» y «Mis mensajes».
- Al crear, el interruptor «Solo para mí» decide si el mensaje nace personal o
  compartido.
- Editar o borrar un mensaje ajeno, o uno ya borrado, da el error «Este mensaje
  rápido ya no existe o no es tuyo.» en vez de un falso «guardado».

## Pasos

1. Confirmar el SHA de la rama:

   ```bash
   git fetch origin
   git ls-remote --heads origin entrega/ronda-del-cliente
   ```

2. Aplicar la migración contra la base real:

   ```bash
   PGOPTIONS="-c lock_timeout=5s" psql -1 -v ON_ERROR_STOP=1 \
     -f supabase/migrations/20261001010000_mensajes_rapidos_personales.sql
   ```

   La migración termina con `notify pgrst` y se autoverifica: aborta si no
   quedaron las cuatro políticas. **Sin `-1` aborta a propósito**, porque
   `lock_timeout` no tendría efecto.

3. Verificar:

   ```sql
   select policyname, cmd from pg_policies where tablename = 'quick_replies';
   -- 4 filas: select, insert, update, delete; ya no existe quick_replies_all

   select count(*) filter (where owner_id is null), count(*) from quick_replies;
   -- los dos números iguales: nada cambió de dueño
   ```

4. Desplegar con el fast-forward:

   ```bash
   git checkout main
   git merge --ff-only origin/entrega/ronda-del-cliente
   git push origin main
   ```

   Después mirar el CI de `main` (la API pública de GitHub).

5. Verificar en producción:
   - Un asesor sigue viendo los mensajes rápidos de siempre en «Compartidos».
   - Puede crear uno «Solo para mí», y otro asesor no lo ve.
   - `/casos` carga.
   - Un admin ve la pestaña «Equipo»; un supervisor no la ve.

## Deuda conocida (no se toca en esta entrega)

- La política `agents_update_by_supervisor` deja que un supervisor renombre a
  cualquiera por la API directa.
- Los eventos viejos («X cerró la conversación») conservan el nombre anterior,
  porque se guardaron como texto.

## Validación en local (1/10/2026)

- Suite completa: 4559 tests en verde.
- `tsc` y lint: 0 errores.
- `rtk proxy npm run build`: compila.
- Verificación visual con Playwright sobre el build de producción: T1, T2 y T7
  pasan en claro y oscuro, a 1280/1440 y 390 px, sin desborde de página; un
  arrastre real en «Casos» cambió `contact_tags` en la base.
- Tests SQL: 34 de 34 en verde sobre la base local, incluido
  `quick_replies_personales.sql`.
- Mutación de T5: debilitar el `with check` del update es una mutación
  **equivalente**. Postgres también exige que la fila nueva de un UPDATE pase
  la política de select, así que el «regalo» a otro asesor se rechaza igual
  con `42501`.
