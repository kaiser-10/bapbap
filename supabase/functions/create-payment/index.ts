import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const portions = new Map([
  ["Porción individual", 6990],
  ["Para compartir", 11990],
]);
const sauces = new Set(["Yangnyeom", "Soya ajo", "Sin salsa"]);
const extras = new Map([
  ["Kimchi casero", 1500],
  ["Bebida lata", 1800],
]);
const DELIVERY_FEE = 2990;
const OPEN_DAYS = ["Sat", "Sun"];
const OPEN_HOUR = 12;
const CLOSE_HOUR = 20;

function isStoreOpen(date = new Date()) {
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
      return response({ error: "Estamos cerrados. Solo recibimos pedidos sábado y domingo de 12:00 a 20:00 hrs." }, 400);
    }

    const body = await request.json();
    const customer = body.customer ?? {};
    const submittedItems = Array.isArray(body.items) ? body.items : [];
    if (typeof customer.name !== "string" || customer.name.trim().length < 2 || typeof customer.phone !== "string" || customer.phone.trim().length < 6 || !["Retiro", "Delivery"].includes(customer.delivery) || (customer.delivery === "Delivery" && (!customer.address || customer.address.trim().length < 5)) || submittedItems.length === 0) {
      return response({ error: "Los datos del pedido no son válidos." }, 400);
    }

    const validatedItems = submittedItems.map((item: { product?: string; sauce?: string; extras?: string[]; quantity?: number }) => {
      const portionPrice = portions.get(item.product ?? "");
      const selectedExtras = Array.isArray(item.extras) ? item.extras : [];
      const quantity = Number(item.quantity);
      if (!portionPrice || !sauces.has(item.sauce ?? "") || !Number.isInteger(quantity) || quantity < 1 || quantity > 10 || selectedExtras.some((extra) => !extras.has(extra))) {
        throw new Error("Producto no válido.");
      }
      const extrasTotal = selectedExtras.reduce((sum, extra) => sum + (extras.get(extra) ?? 0), 0);
      return { product: item.product, sauce: item.sauce, extras: selectedExtras, quantity, unit_price: portionPrice + extrasTotal };
    });

    const deliveryFee = customer.delivery === "Delivery" ? DELIVERY_FEE : 0;
    const total = validatedItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) + deliveryFee;
    const database = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: order, error: orderError } = await database.from("orders").insert({
      customer_name: customer.name.trim(),
      customer_phone: customer.phone.trim(),
      delivery_method: customer.delivery,
      delivery_address: customer.delivery === "Delivery" ? customer.address.trim() : null,
      items: validatedItems,
      total,
      payment_provider: "mercado_pago",
      payment_status: "pendiente",
    }).select("id").single();
    if (orderError) throw orderError;

    const payment = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          ...validatedItems.map((item) => ({
            title: `${item.product} · ${item.sauce}${item.extras.length ? ` · ${item.extras.join(", ")}` : ""}`,
            quantity: item.quantity,
            unit_price: item.unit_price,
            currency_id: "CLP",
          })),
          ...(deliveryFee > 0 ? [{ title: "Despacho", quantity: 1, unit_price: deliveryFee, currency_id: "CLP" }] : []),
        ],
        external_reference: order.id,
        back_urls: {
          success: `${siteUrl}/payment.html?result=success`,
          pending: `${siteUrl}/payment.html?result=pending`,
          failure: `${siteUrl}/payment.html?result=failure`,
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
