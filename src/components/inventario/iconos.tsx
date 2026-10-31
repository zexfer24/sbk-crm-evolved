/**
 * Íconos que `lucide-react` no trae (30/10/2026, plan «Cada repuesto con su
 * foto», T5b). Mismos trazos y mismo estilo (24x24, trazo de 2) que los de
 * lucide, para que convivan con ellos sin que se note la diferencia.
 */

/**
 * Carrito con un «+» (el `cartplus` del mockup): agrega un renglón al carrito.
 * El botón que lo contiene lleva el `aria-label`; el ícono es decorativo.
 */
export function CarritoMasIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
      <path d="M13.5 9.6v5" />
      <path d="M11 12.1h5" />
    </svg>
  );
}
