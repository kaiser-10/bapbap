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
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;
// El despacho depende de la comuna. Debe coincidir con COMUNA_GROUPS en src/App.jsx.
const COMUNA_FEES = new Map([
  ["Puente Alto", 2990],
  ["San Bernardo", 2990],
  ["El Bosque", 2990],
  ["La Pintana", 2990],
  ["La Florida", 4490],
  ["La Granja", 4490],
  ["San Ramón", 4490],
  ["La Cisterna", 4490],
]);

// Bloques de entrega de la semana. Debe coincidir con BLOCKS en src/App.jsx.
const BLOCKS = [
  { weekday: "Fri", label: "Viernes", openHour: 17, closeHour: 20 },
  { weekday: "Sat", label: "Sábado", openHour: 12, closeHour: 20 },
  { weekday: "Sun", label: "Domingo", openHour: 12, closeHour: 17 },
];
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Pausa puntual: no se ofrece ningún bloque anterior a esta fecha (YYYY-MM-DD,
// hora de Santiago). Debe coincidir con REOPEN_DATE en src/App.jsx.
const REOPEN_DATE = "2026-08-22";

function getSantiagoNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    hour: Number(get("hour")) % 24,
  };
}

function addDays(dateStr: string, days: number) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatBlockDate(dateStr: string) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return new Intl.DateTimeFormat("es-CL", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function nextOccurrence(block: { weekday: string; closeHour: number }, now: { date: string; weekday: string; hour: number }) {
  const diff = (WEEKDAY_INDEX[block.weekday] - WEEKDAY_INDEX[now.weekday] + 7) % 7;
  const alreadyClosed = diff === 0 && now.hour >= block.closeHour;
  return addDays(now.date, alreadyClosed ? 7 : diff);
}

function getUpcomingBlocks(now = getSantiagoNow()) {
  return BLOCKS.map((block) => ({ ...block, date: nextOccurrence(block, now) }))
    .filter((block) => block.date >= REOPEN_DATE)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// El panel de admin marca "agotado" guardando la fecha del bloque sin stock.
// Si la consulta falla, seguimos vendiendo: un error de lectura no debe cortar
// las ventas.
async function getSoldOutDate(database: ReturnType<typeof createClient>) {
  try {
    const { data, error } = await database.from("store_settings").select("sold_out_on").maybeSingle();
    if (error) return null;
    return (data?.sold_out_on as string | null) ?? null;
  } catch {
    return null;
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

    const database = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    // Corta intentos en bucle antes de gastar nada en Mercado Pago. Si la consulta
    // falla, dejamos pasar: un problema de red no debe bloquear a clientes reales.
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const windowStart = new Date(Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS).toISOString();
    const { data: attempts, error: rateError } = await database.rpc("increment_rate_limit", { p_ip: clientIp, p_window: windowStart });
    if (!rateError && attempts > RATE_LIMIT_MAX) {
      return response({ error: "Demasiados intentos. Espera un momento e inténtalo de nuevo." }, 429);
    }

    const body = await request.json();

    let blocks = getUpcomingBlocks();
    const soldOutDate = await getSoldOutDate(database);
    if (soldOutDate) blocks = blocks.filter((block) => block.date !== soldOutDate);

    const block = blocks.find((item) => item.weekday === body.reservation?.weekday);
    if (!block) {
      return response({ error: "Elige un horario de entrega disponible." }, 400);
    }

    const customer = body.customer ?? {};
    const submittedItems = Array.isArray(body.items) ? body.items : [];
    if (
      typeof customer.name !== "string" || customer.name.trim().length < 2 || customer.name.trim().length > 100 ||
      typeof customer.phone !== "string" || customer.phone.trim().length < 6 || customer.phone.trim().length > 30 ||
      !COMUNA_FEES.has(customer.comuna) ||
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

    const deliveryFee = COMUNA_FEES.get(customer.comuna) ?? 0;
    const total = validatedItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) + deliveryFee;
    const reservedLabel = `${block.label} ${formatBlockDate(block.date)} · ${block.openHour}:00-${block.closeHour}:00 hrs`;

    const { data: order, error: orderError } = await database.from("orders").insert({
      customer_name: customer.name.trim(),
      customer_phone: customer.phone.trim(),
      delivery_method: "Delivery",
      delivery_address: customer.address.trim(),
      comuna: customer.comuna,
      reserved_date: block.date,
      reserved_label: reservedLabel,
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
          { title: `Despacho · ${reservedLabel}`, quantity: 1, unit_price: deliveryFee, currency_id: "CLP" },
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
