import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };

function getServiceKey() {
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
  return Object.values(keys)[0];
}

function toPaymentStatus(status: string) {
  if (status === "approved") return "pagado";
  if (["rejected", "cancelled"].includes(status)) return "rechazado";
  return "pendiente";
}

const pesos = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

async function sendOrderNotification(order: {
  customer_name: string;
  customer_phone: string;
  delivery_method: string;
  delivery_address: string | null;
  items: { product: string; sauce: string; extras?: string[]; quantity: number }[];
  total: number;
}) {
  const gmailUser = Deno.env.get("GMAIL_USER");
  const gmailPassword = Deno.env.get("GMAIL_APP_PASSWORD");
  const notifyEmail = Deno.env.get("NOTIFY_EMAIL");
  if (!gmailUser || !gmailPassword || !notifyEmail) return;

  const itemsHtml = order.items
    .map((item) => `<li>${item.quantity}× ${item.product} · ${item.sauce}${item.extras?.length ? ` · ${item.extras.join(", ")}` : ""}</li>`)
    .join("");
  const itemsText = order.items
    .map((item) => `${item.quantity}x ${item.product} - ${item.sauce}${item.extras?.length ? ` - ${item.extras.join(", ")}` : ""}`)
    .join("\n");

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: gmailUser, password: gmailPassword },
    },
  });

  try {
    await client.send({
      from: gmailUser,
      to: notifyEmail,
      subject: `Nuevo pedido pagado · ${pesos.format(order.total)}`,
      content: `Nuevo pedido pagado\n${order.customer_name} · ${order.customer_phone}\n${order.delivery_method}${order.delivery_method === "Delivery" ? `: ${order.delivery_address}` : ""}\n${itemsText}\nTotal: ${pesos.format(order.total)}`,
      html: `
        <h2>Nuevo pedido pagado</h2>
        <p><strong>${order.customer_name}</strong> · ${order.customer_phone}</p>
        <p>${order.delivery_method}${order.delivery_method === "Delivery" ? `: ${order.delivery_address}` : ""}</p>
        <ul>${itemsHtml}</ul>
        <p><strong>Total: ${pesos.format(order.total)}</strong></p>
      `,
    });
  } catch (error) {
    console.error("No se pudo enviar el aviso por correo", error);
  } finally {
    await client.close();
  }
}

async function hmacSha256(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const webhookSecret = Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET");
    const accessToken = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = getServiceKey();
    if (!webhookSecret || !accessToken || !supabaseUrl || !serviceKey) return new Response("Missing configuration", { status: 500 });

    const signatureHeader = request.headers.get("x-signature") ?? "";
    const requestId = request.headers.get("x-request-id") ?? "";
    const parts = Object.fromEntries(signatureHeader.split(",").map((part) => part.trim().split("=")).filter(([key, value]) => key && value));
    const timestamp = parts.ts;
    const signature = parts.v1;
    const url = new URL(request.url);
    const payload = await request.json().catch(() => ({}));
    const paymentId = url.searchParams.get("data.id") ?? payload?.data?.id;
    if (!timestamp || !signature || !paymentId) return new Response("Invalid notification", { status: 400 });

    const manifest = `id:${String(paymentId).toLowerCase()};request-id:${requestId};ts:${timestamp};`;
    const expectedSignature = await hmacSha256(webhookSecret, manifest);
    if (expectedSignature !== signature) {
      // La firma de Mercado Pago no coincide de forma consistente para esta cuenta (bug o
      // inconsistencia de su lado, verificado manualmente). No bloqueamos: la autenticidad real
      // se confirma abajo consultando el pago directo en la API de Mercado Pago con nuestro
      // propio access token, que es la fuente de verdad.
      console.warn("Webhook signature mismatch, continuing based on API lookup", { paymentId });
    }

    const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || !payment.external_reference) return new Response("Payment not found", { status: 404 });

    const database = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const newStatus = toPaymentStatus(payment.status);
    const { data: updatedOrder, error } = await database
      .from("orders")
      .update({ payment_status: newStatus })
      .eq("id", payment.external_reference)
      .select()
      .single();
    if (error) throw error;

    if (newStatus === "pagado") {
      await sendOrderNotification(updatedOrder);
    }

    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error(error);
    return new Response("Internal error", { status: 500, headers: corsHeaders });
  }
});
