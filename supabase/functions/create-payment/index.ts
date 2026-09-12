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
  ["Kimbap", { price: 4990, hasSauce: false }],
  ["Kimari", { price: 5990, hasSauce: false }],
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

// Horario de atención. Debe coincidir con BLOCKS en src/App.jsx.
const BLOCKS = [
  { weekday: "Fri", label: "Viernes", openHour: 17, closeHour: 20 },
  { weekday: "Sat", label: "Sábado", openHour: 12, closeHour: 20 },
  { weekday: "Sun", label: "Domingo", openHour: 12, closeHour: 17 },
];
// Cada día se parte en ventanas de entrega de este largo. Debe coincidir con
// SLOT_HOURS en src/App.jsx y con las filas sembradas en slot_limits.
const SLOT_HOURS = 2;
// Lo que se le promete al cliente que pide al momento. Debe coincidir con src/App.jsx.
const ASAP_MIN = 45;
const ASAP_MAX = 55;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Pausa puntual: no se ofrece ninguna ventana anterior a esta fecha (YYYY-MM-DD,
// hora de Santiago). Debe coincidir con REOPEN_DATE en src/App.jsx.
const REOPEN_DATE = "2026-08-22";

// Fines de semana sueltos en que no se atiende (feriados, vacaciones). A
// diferencia de REOPEN_DATE, que esconde todo lo anterior a una fecha, esto
// tapa solo el rango: cierra el fin de semana que viene sin tocar el de esta
// semana. Ambos extremos incluidos. Debe coincidir con CLOSED_RANGES en
// src/App.jsx.
const CLOSED_RANGES = [
  { from: "2026-09-18", to: "2026-09-20", reason: "Fiestas Patrias" },
];

function isClosedDate(date: string) {
  return CLOSED_RANGES.some((range) => date >= range.from && date <= range.to);
}

type Now = { date: string; weekday: string; hour: number };
type Block = { weekday: string; label: string; openHour: number; closeHour: number };
type Slot = { weekday: string; label: string; date: string; startHour: number; endHour: number };
type ValidatedItem = { product: string; sauce: string | null; quantity: number; unit_price: number };

function getSantiagoNow(date = new Date()): Now {
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

// La última ventana del día se recorta al cierre, así nunca se ofrece una hora
// en la que ya no hay nadie: el viernes cierra con 19-20 y el domingo con 16-17.
function blockSlots(block: Block) {
  const slots: { startHour: number; endHour: number }[] = [];
  for (let start = block.openHour; start < block.closeHour; start += SLOT_HOURS) {
    slots.push({ startHour: start, endHour: Math.min(start + SLOT_HOURS, block.closeHour) });
  }
  return slots;
}

function nextOccurrence(block: Block, now: Now) {
  const diff = (WEEKDAY_INDEX[block.weekday] - WEEKDAY_INDEX[now.weekday] + 7) % 7;
  const alreadyClosed = diff === 0 && now.hour >= block.closeHour;
  let date = addDays(now.date, alreadyClosed ? 7 : diff);
  // Si ese día cae en un cierre, se salta a la semana siguiente, igual que en
  // la tienda: si no, el bloque desaparecería en vez de correrse.
  for (let week = 0; week < 8 && isClosedDate(date); week += 1) {
    date = addDays(date, 7);
  }
  return date;
}

// Ventanas que todavía se pueden preordenar. De hoy solo quedan las que aún no
// empiezan: para la que está en curso existe el pedido al momento.
function getUpcomingSlots(now: Now): Slot[] {
  return BLOCKS.flatMap((block) => {
    const date = nextOccurrence(block, now);
    return blockSlots(block).map((slot) => ({ ...slot, weekday: block.weekday, label: block.label, date }));
  })
    .filter((slot) => slot.date >= REOPEN_DATE)
    .filter((slot) => slot.date > now.date || slot.startHour > now.hour)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour);
}

// La ventana en curso, si la tienda está abierta en este momento. Los pedidos
// al momento también ocupan cupo: para la cocina pesan igual que una preorden.
function getLiveSlot(now: Now): Slot | null {
  if (now.date < REOPEN_DATE || isClosedDate(now.date)) return null;
  const block = BLOCKS.find((item) => item.weekday === now.weekday && now.hour >= item.openHour && now.hour < item.closeHour);
  if (!block) return null;
  const slot = blockSlots(block).find((item) => now.hour >= item.startHour && now.hour < item.endHour);
  return slot ? { ...slot, weekday: block.weekday, label: block.label, date: now.date } : null;
}

function orderLabel(slot: Slot, mode: string) {
  if (mode !== "ahora") return `${slot.label} ${formatBlockDate(slot.date)} · ${slot.startHour}:00-${slot.endHour}:00 hrs`;
  return `Ahora · ${slot.label.toLowerCase()} ${formatBlockDate(slot.date)}, llega en ${ASAP_MIN}-${ASAP_MAX} min`;
}

// Acepta el cuerpo nuevo { order: { mode, date, startHour } } y también el
// anterior { reservation: { weekday } }: una pestaña abierta desde antes del
// cambio sigue pudiendo pagar en vez de recibir un error.
function readRequest(body: { order?: { mode?: string; date?: string; startHour?: number }; reservation?: { weekday?: string } }) {
  if (body.order && typeof body.order === "object") {
    return {
      mode: body.order.mode === "ahora" ? "ahora" : "preorden",
      date: typeof body.order.date === "string" ? body.order.date : null,
      startHour: Number.isInteger(body.order.startHour) ? Number(body.order.startHour) : null,
      legacyWeekday: null as string | null,
    };
  }
  return { mode: "preorden", date: null, startHour: null, legacyWeekday: body.reservation?.weekday ?? null };
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
    const now = getSantiagoNow();
    const requested = readRequest(body);
    const soldOutDate = await getSoldOutDate(database);

    // La ventana nunca se toma del cliente: se recalcula acá y solo se acepta si
    // coincide con una que el servidor ofrecería en este mismo momento.
    let slot: Slot | null;
    if (requested.mode === "ahora") {
      slot = getLiveSlot(now);
      if (!slot) {
        return response({ error: "Ahora mismo no estamos recibiendo pedidos al momento. Puedes dejar una preorden." }, 400);
      }
    } else {
      const upcoming = getUpcomingSlots(now);
      slot = requested.legacyWeekday
        ? upcoming.find((item) => item.weekday === requested.legacyWeekday) ?? null
        : upcoming.find((item) => item.date === requested.date && item.startHour === requested.startHour) ?? null;
      if (!slot) {
        return response({ error: "Elige una ventana de entrega disponible." }, 400);
      }
    }
    if (soldOutDate && slot.date === soldOutDate) {
      return response({ error: "Ese día se agotó. Elige otra ventana, por favor." }, 400);
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

    // Un producto que no calza es culpa del pedido, no del servidor, así que
    // devuelve 400 y no 500: el 500 esconde el problema entre los errores
    // reales en los logs. Y el mensaje pide actualizar la página porque eso es
    // justo lo que lo arregla cuando la tienda va por delante del servidor.
    const validatedItems: ValidatedItem[] = [];
    for (const item of submittedItems as { product?: string; sauce?: string | null; quantity?: number }[]) {
      const name = item.product ?? "";
      const productInfo = PRODUCTS.get(name);
      const quantity = Number(item.quantity);
      const sauceOk = productInfo ? (productInfo.hasSauce ? SAUCE_CHOICES.has(item.sauce ?? "") : true) : false;
      if (!productInfo || !sauceOk || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        console.error("Producto no válido:", JSON.stringify(item));
        return response({ error: "Hay un producto de tu pedido que ya no está disponible. Actualiza la página e inténtalo de nuevo." }, 400);
      }
      validatedItems.push({ product: name, sauce: productInfo.hasSauce ? item.sauce ?? null : null, quantity, unit_price: productInfo.price });
    }

    const deliveryFee = COMUNA_FEES.get(customer.comuna) ?? 0;
    const total = validatedItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) + deliveryFee;
    const reservedLabel = orderLabel(slot, requested.mode);

    // place_order comprueba el cupo e inserta dentro de la misma transacción,
    // así dos clientes no pueden llevarse el último a la vez.
    const { data: placed, error: placeError } = await database.rpc("place_order", {
      p_customer_name: customer.name.trim(),
      p_customer_phone: customer.phone.trim(),
      p_address: customer.address.trim(),
      p_comuna: customer.comuna,
      p_reserved_date: slot.date,
      p_reserved_start: slot.startHour,
      p_reserved_end: slot.endHour,
      p_reserved_label: reservedLabel,
      p_order_mode: requested.mode,
      p_items: validatedItems,
      p_total: total,
    });
    if (placeError) {
      if (String(placeError.message ?? "").includes("SLOT_FULL")) {
        return response({ error: "Esa ventana se acaba de llenar. Elige otra, por favor." }, 409);
      }
      throw placeError;
    }
    const order = (Array.isArray(placed) ? placed[0] : placed) as { order_id: string; order_num: number } | undefined;
    if (!order) throw new Error("place_order no devolvió el pedido.");

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
        external_reference: order.order_id,
        back_urls: {
          success: `${siteUrl}/payment.html?result=success&pedido=${order.order_num}`,
          pending: `${siteUrl}/payment.html?result=pending&pedido=${order.order_num}`,
          failure: `${siteUrl}/payment.html?result=failure&pedido=${order.order_num}`,
        },
        auto_return: "approved",
      }),
    });
    const paymentData = await payment.json();
    if (!payment.ok || !paymentData.init_point) throw new Error("Mercado Pago no pudo crear el cobro.");

    await database.from("orders").update({ payment_preference_id: paymentData.id }).eq("id", order.order_id);
    return response({ checkoutUrl: paymentData.init_point });
  } catch (error) {
    console.error(error);
    return response({ error: "No se pudo iniciar el pago." }, 500);
  }
});
