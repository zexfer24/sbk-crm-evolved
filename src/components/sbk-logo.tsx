import Image from "next/image";

/**
 * El logo original de SBK Motors —el arte con la moto sobre las letras— tal
 * cual lo usa la empresa. Vive en public/logo-sbk.jpg y es la misma fuente de
 * la que scripts/generar-iconos.mjs saca el favicon y los íconos de la app:
 * si el logo cambia, se reemplaza ese archivo y se corre el script, y la
 * pestaña y la interfaz cambian juntas.
 *
 * Decorativo por defecto (alt vacío + aria-hidden): siempre aparece al lado
 * de un texto que ya dice "SBK". Un lector de pantalla no gana nada oyéndolo
 * dos veces.
 *
 * El radio va en proporción al tamaño —la misma curva que le pone el script a
 * los íconos— para que la placa se vea igual a 32px en el rail que a 56px en
 * el login.
 */
export function SbkMark({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/logo-sbk.jpg"
      alt=""
      width={size}
      height={size}
      className={className}
      style={{ borderRadius: Math.round(size * 0.22) }}
      aria-hidden="true"
    />
  );
}
