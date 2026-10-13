// Identificador de despliegue para la protección contra desfase de versiones
// (`deploymentId` de next.config.ts). Función pura: no lee `process.env` ni el
// reloj por su cuenta, para poder probarla.
//
// Historia (13/10/2026): tras cada despliegue, una pestaña abierta con el
// JavaScript viejo seguía llamando Server Actions con los ids de la versión
// anterior y en producción aparecía `Server Reference ID did not match`. Con
// un `deploymentId` Next marca los assets con `?dpl=` y compara el id del
// cliente con el del servidor: si difieren, hace una navegación dura (recarga
// completa) en vez de mezclar versiones.

// Solo estos caracteres viajan en `?dpl=` y en cabeceras sin escapes raros.
const VALIDO = /^[A-Za-z0-9_-]+$/;

// Largo con el que se recorta un hash de commit.
const LARGO_COMMIT = 12;

function limpio(valor: string | undefined, recortar: boolean): string | null {
  if (valor === undefined) return null;
  const texto = recortar ? valor.slice(0, LARGO_COMMIT) : valor;
  // Vacío, solo espacios o con espacios/símbolos adentro cuenta como ausente.
  return VALIDO.test(texto) ? texto : null;
}

function marcaDeTiempo(ahora: Date): string {
  const dos = (n: number) => String(n).padStart(2, "0");
  return (
    `build-${ahora.getUTCFullYear()}${dos(ahora.getUTCMonth() + 1)}${dos(ahora.getUTCDate())}` +
    `${dos(ahora.getUTCHours())}${dos(ahora.getUTCMinutes())}${dos(ahora.getUTCSeconds())}`
  );
}

/**
 * Prioridad: `NEXT_DEPLOYMENT_ID` tal cual; luego el hash de commit
 * (`SOURCE_COMMIT`, `GIT_COMMIT_SHA`, `COMMIT_SHA`) recortado a 12 caracteres;
 * y si no hay nada, `build-YYYYMMDDHHmmss` en UTC. Cada versión necesita un id
 * distinto: por eso nunca devuelve algo constante.
 */
export function deploymentIdDesde(
  env: Record<string, string | undefined>,
  ahora: Date,
): string {
  const explicito = limpio(env.NEXT_DEPLOYMENT_ID, false);
  if (explicito) return explicito;

  for (const clave of ["SOURCE_COMMIT", "GIT_COMMIT_SHA", "COMMIT_SHA"]) {
    const commit = limpio(env[clave], true);
    if (commit) return commit;
  }

  return marcaDeTiempo(ahora);
}
