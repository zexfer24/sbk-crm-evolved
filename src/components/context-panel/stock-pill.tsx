/**
 * Pastilla de existencia de un repuesto (T9, plan "Seba encuentra, no insiste,
 * y el mostrador no deja a nadie esperando", 29/9/2026, 3.5). Hasta esta
 * corrida la existencia era un texto gris más entre los metadatos ("12 en
 * stock" / "Sin stock") y un agotado se confundía con el resto del renglón;
 * ahora se lee de un vistazo, en la búsqueda del chat, en el carrito y en el
 * buscador de «Cerrar venta».
 *
 * El color nunca es el único aviso: el texto dice lo mismo. Cero y negativos
 * (Saint puede reportar existencia negativa) son «Agotado». Un agotado se
 * puede vender igual —puede haber existencia física sin cargar—, por eso la
 * pastilla avisa pero no bloquea nada. Los colores salen de tokens del tema
 * (`.crm-stock-pill` en `crm.css`), con contraste AA en claro y oscuro.
 */
interface StockPillProps {
  quantity: number;
}

export function StockPill({ quantity }: StockPillProps) {
  const available = quantity > 0;

  return (
    <span className="crm-stock-pill lm-num" data-stock={available ? "in" : "out"}>
      {available ? `${quantity} en stock` : "Agotado"}
    </span>
  );
}
