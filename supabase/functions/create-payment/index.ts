import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// hasSauce debe coincidir con el campo del mismo nombre en src/App.jsx: solo el
// pollo pregunta la salsa, los demás productos no.
const PRODUCTS = new Map([
  ["Media porción", { price: 11990, hasSauce: true }],
  ["Porción (2 a 3 personas)", { price: 19990, hasSauce: true }],
  ["Bibimbap", { price: 8990, hasSauce: false }],
  ["Coca-Cola en lata", { price: 1500, hasSauce: false }],
  ["Porción de arroz", { price: 2000, hasSauce: false }],
]);
// Preferencia de servido, sin costo. Debe coincidir con SAUCE_CHOICES en src/App.jsx.
const SAUCE_CHOICES = new Set(["Con salsa", "Sin salsa", "Salsa aparte"]);
const DELIVERY_FEE = 2990;
const COMUNAS = new Set(["Puente Alto", "San Bernardo", "El Bosque", "La Pintana"]);
const OPEN_DAYS = ["Sat", "Sun"];
const OPEN_HOUR = 12;
const CLOSE_HOUR = 17;

// Pausa puntual: no hay venta hasta esta fecha (YYYY-MM-DD, hora de Santiago).
// Debe coincidir con REOPEN_DATE en src/App.jsx.
const REOPEN_DATE = "2026-08-22";

function isOnBreak(date = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return today < REOPEN_DATE;
}

function isStoreOpen(date = new Date()) {
  // TEMP: prueba real antes de partir, revertir después
  if (true) return true;
  if (isOnBreak(date)) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value) % 24;
  return OPEN_DAYS.includes(weekday ?? "") && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

// El panel de admin marca "agotado" guardando la fecha del día. Si la consulta
// falla, seguimos vendiendo: un error de lectura no debe cortar las ventas.
async function isSoldOut(database: ReturnType<typeof createClient>) {
  try {
    const { data, error } = await database
      .from("store_settings")
      .select("sold_out_on")
      .maybeSingle();
    if (error) return false;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Santiago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return data?.sold_out_on === today;
  } catch {
    return false;
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getServiceKey() {
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
  return Object.values(keys)[0];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response({ error: "Método no permitido" }, 405);

  try {
    const accessToken = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = getServiceKey();
    const siteUrl = Deno.env.get("SITE_URL");
    if (!accessToken || !supabaseUrl || !serviceKey || !siteUrl) {
      return response({ error: "Falta configurar un secreto del pago." }, 500);
    }

    if (!isStoreOpen()) {
      return response({
        error: isOnBreak()
          ? "Este fin de semana no hay venta. Volvemos el sábado 22 de agosto."
          : "Estamos cerrados. Solo recibimos pedidos sábado y domingo de 12:00 a 17:00 hrs.",
      }, 400);
    }

    const body = await request.json();
    const customer = body.customer ?? {};
    const submittedItems = Array.isArray(body.items) ? body.items : [];
    if (
      typeof customer.name !== "string" || customer.name.trim().length < 2 || customer.name.trim().length > 100 ||
      typeof customer.phone !== "string" || customer.phone.trim().length < 6 || customer.phone.trim().length > 30 ||
      !COMUNAS.has(customer.comuna) ||
      typeof customer.address !== "string" || customer.address.trim().length < 5 || customer.address.trim().length > 200 ||
      submittedItems.length === 0 || submittedItems.length > 20
    ) {
      return response({ error: "Los datos del pedido no son válidos." }, 400);
    }

    const validatedItems = submittedItems.map((item: { product?: string; sauce?: string | null; quantity?: number }) => {
      const productInfo = PRODUCTS.get(item.product ?? "");
      const quantity = Number(item.quantity);
      const sauceOk = productInfo ? (productInfo.hasSauce ? SAUCE_CHOICES.has(item.sauce ?? "") : true) : false;
      if (!productInfo || !sauceOk || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        throw new Error("Producto no válido.");
      }
      const sauce = productInfo.hasSauce ? item.sauce : null;
      return { product: item.product, sauce, quantity, unit_price: productInfo.price };
    });

    const total = validatedItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) + DELIVERY_FEE;
    const database = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    // Se comprueba antes de insertar, para no dejar pedidos huérfanos si está agotado.
    if (await isSoldOut(database)) {
      return response({ error: "Se nos acabó el stock por hoy. ¡Te esperamos en el próximo servicio!" }, 400);
    }

    const { data: order, error: orderError } = await database.from("orders").insert({
      customer_name: customer.name.trim(),
      customer_phone: customer.phone.trim(),
      delivery_method: "Delivery",
      delivery_address: customer.address.trim(),
      comuna: customer.comuna,
      items: validatedItems,
      total,
      payment_provider: "mercado_pago",
      payment_status: "pendiente",
    }).select("id, order_number").single();
    if (orderError) throw orderError;

    const payment = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          ...validatedItems.map((item) => ({
            title: [item.product, item.sauce].filter(Boolean).join(" · "),
            quantity: item.quantity,
            unit_price: item.unit_price,
            currency_id: "CLP",
          })),
          { title: "Despacho", quantity: 1, unit_price: DELIVERY_FEE, currency_id: "CLP" },
        ],
        external_reference: order.id,
        back_urls: {
          success: `${siteUrl}/payment.html?result=success&pedido=${order.order_number}`,
          pending: `${siteUrl}/payment.html?result=pending&pedido=${order.order_number}`,
          failure: `${siteUrl}/payment.html?result=failure&pedido=${order.order_number}`,
        },
        auto_return: "approved",
      }),
    });
    const paymentData = await payment.json();
    if (!payment.ok || !paymentData.init_point) throw new Error("Mercado Pago no pudo crear el cobro.");

    await database.from("orders").update({ payment_preference_id: paymentData.id }).eq("id", order.id);
    return response({ checkoutUrl: paymentData.init_point });
  } catch (error) {
    console.error(error);
    return response({ error: "No se pudo iniciar el pago." }, 500);
  }
});
