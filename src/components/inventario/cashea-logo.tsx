/**
 * Logo de Cashea: el cuadrado amarillo con la «C» negra (30/10/2026, plan
 * «Cada repuesto con su foto», T5b). Antes el botón de Cashea usaba el ícono de
 * una calculadora; con el logo el asesor reconoce el botón sin leer. Es un SVG
 * propio (no una imagen) para no depender de red ni de un archivo en `public`,
 * y se comparte entre la tarjeta de la cuadrícula y la ficha del repuesto.
 */
export function CasheaLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="6" fill="#FFF83D" />
      <path d="M12 6A6 6 0 1 0 18 12H15A3 3 0 1 1 12 9Z" fill="#000" />
    </svg>
  );
}
