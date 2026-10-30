export function calculateOrderAmounts(items, { flatRate, freeShippingThreshold }) {
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const shipping = subtotal >= freeShippingThreshold ? 0 : flatRate;
  return { subtotal, shipping, total: subtotal + shipping };
}
