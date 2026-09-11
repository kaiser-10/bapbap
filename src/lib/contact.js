// Datos de contacto público, en un solo lugar para que la tienda y la página
// de pago no los repitan. El número va solo en dígitos, con código de país
// (56 = Chile), que es el formato que espera wa.me.
export const WHATSAPP_NUMBER = "56922486677";
export const INSTAGRAM_URL = "https://www.instagram.com/bapbap.cl?igsh=MTRocjYzY2NydWZhdA==";

// Abre WhatsApp con un chat hacia el negocio. El texto es opcional y llega ya
// escrito en la caja del mensaje; el cliente solo aprieta enviar.
export function whatsappUrl(text) {
  const base = `https://wa.me/${WHATSAPP_NUMBER}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}
