import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./lib/supabase";
import "./admin.css";

const statusLabels = {
  nuevo: "Nuevo",
  confirmado: "Confirmado",
  preparando: "Preparando",
  enviado: "Enviado",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

const pesos = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

function formatTime(date) {
  return date.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(date) {
  return new Date(date).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}

// Mensaje sugerido según en qué va el pedido. El botón solo abre el chat con el
// texto escrito: enviarlo sigue siendo una decisión manual.
const whatsappMessages = {
  nuevo: (name, n) => `Hola ${name} 👋 Recibimos tu pedido #${n} y ya lo estamos preparando.`,
  confirmado: (name, n) => `Hola ${name} 👋 Confirmamos tu pedido #${n}, ya lo estamos preparando.`,
  preparando: (name, n) => `Hola ${name} 👋 Tu pedido #${n} está en preparación, te avisamos cuando salga.`,
  enviado: (name, n) => `Hola ${name} 👋 Tu pedido #${n} ya va en camino 🐔`,
  entregado: (name, n) => `Hola ${name} 👋 ¡Gracias por tu compra! Esperamos que hayas disfrutado tu pedido #${n}.`,
  cancelado: (name, n) => `Hola ${name} 👋 Te escribimos por tu pedido #${n}.`,
};

// Los clientes escriben el teléfono de muchas formas ("+56 9 ...", "9 1234 5678"),
// así que se deja solo en dígitos y se antepone el código de país.
function whatsappLink(order) {
  const digits = String(order.customer_phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const number = digits.startsWith("56") ? digits : `56${digits}`;
  const build = whatsappMessages[order.status] ?? whatsappMessages.nuevo;
  return `https://wa.me/${number}?text=${encodeURIComponent(build(order.customer_name, order.order_number))}`;
}

// Horario de atención. Debe coincidir con BLOCKS en src/App.jsx.
const BLOCKS = [
  { weekday: "Fri", label: "Viernes", openHour: 17, closeHour: 20 },
  { weekday: "Sat", label: "Sábado", openHour: 12, closeHour: 20 },
  { weekday: "Sun", label: "Domingo", openHour: 12, closeHour: 17 },
];
// Debe coincidir con SLOT_HOURS en src/App.jsx y con las filas de slot_limits.
const SLOT_HOURS = 2;
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function blockSlots(block) {
  const slots = [];
  for (let start = block.openHour; start < block.closeHour; start += SLOT_HOURS) {
    slots.push({ startHour: start, endHour: Math.min(start + SLOT_HOURS, block.closeHour) });
  }
  return slots;
}

function getSantiagoNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday"), hour: Number(get("hour")) % 24 };
}

function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextOccurrence(block, now) {
  const diff = (WEEKDAY_INDEX[block.weekday] - WEEKDAY_INDEX[now.weekday] + 7) % 7;
  const alreadyClosed = diff === 0 && now.hour >= block.closeHour;
  return addDays(now.date, alreadyClosed ? 7 : diff);
}

// El "agotado" se guarda como la fecha del bloque de entrega más próximo (el
// que se está por preparar), en hora de Santiago: así la tienda se reactiva
// sola apenas pase ese bloque.
function nextBlockDate() {
  const now = getSantiagoNow();
  return BLOCKS.map((block) => nextOccurrence(block, now)).sort()[0];
}

// Encabeza cada jornada de entrega. Se arma sobre mediodía UTC para que la
// fecha no se corra un día al formatear.
function formatDate(dateStr, options) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return new Intl.DateTimeFormat("es-CL", { ...options, timeZone: "UTC" }).format(date);
}

const formatGroupDate = (dateStr) => formatDate(dateStr, { weekday: "long", day: "numeric", month: "short" });
// Sin el día de la semana: en el panel de cupos ya va como título.
const formatShortDate = (dateStr) => formatDate(dateStr, { day: "numeric", month: "short" });

function startOfDay(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function startOfWeek(date) {
  const start = startOfDay(date);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

function sumSince(orders, since) {
  return orders.filter((order) => new Date(order.created_at) >= since).reduce((sum, order) => sum + order.total, 0);
}

// Lo que hay que cocinar para un bloque, sumado entre todos sus pedidos. Va en
// la cabecera del grupo para no tener que abrir pedido por pedido e ir anotando.
function summarizeItems(orders) {
  const counts = new Map();
  for (const order of orders) {
    for (const item of order.items) {
      counts.set(item.product, (counts.get(item.product) ?? 0) + item.quantity);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([product, quantity]) => `${quantity}× ${product}`)
    .join(" · ");
}

// La ventana de entrega del pedido, corta para la fila: "16-18" o "AHORA".
// Los pedidos anteriores a las ventanas no tienen hora y no muestran nada.
function slotChip(order) {
  if (order.order_mode === "ahora") return "AHORA";
  if (order.reserved_start == null) return null;
  return `${order.reserved_start}-${order.reserved_end}`;
}

// Agrupa por jornada de entrega (no por cuándo se hizo el pedido), para que el
// panel muestre de una qué hay que preparar cada día, y dentro de cada jornada
// ordena por ventana: así la lista va en el orden en que hay que cocinar. Los
// pedidos sin reserva (de antes de esta función) quedan aparte al final.
function groupByReservation(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = order.reserved_date ?? "sin-reserva";
    if (!groups.has(key)) groups.set(key, { date: order.reserved_date, orders: [] });
    groups.get(key).orders.push(order);
  }
  for (const group of groups.values()) {
    group.orders.sort((a, b) => (a.reserved_start ?? 99) - (b.reserved_start ?? 99) || a.created_at.localeCompare(b.created_at));
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useAlertSound() {
  const contextRef = useRef(null);

  useEffect(() => {
    // Los navegadores bloquean el audio hasta que hay un gesto del usuario:
    // preparamos (y despertamos) el contexto con cualquier clic o tecla.
    function prime() {
      const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!contextRef.current) contextRef.current = new AudioCtx();
      if (contextRef.current.state === "suspended") contextRef.current.resume();
    }
    window.addEventListener("pointerdown", prime);
    window.addEventListener("keydown", prime);
    return () => {
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("keydown", prime);
    };
  }, []);

  return useCallback(() => {
    const context = contextRef.current;
    if (!context) return;
    if (context.state === "suspended") context.resume();
    [0, 0.32, 0.64].forEach((offset) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      const start = context.currentTime + offset;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.26);
      oscillator.start(start);
      oscillator.stop(start + 0.3);
    });
  }, []);
}

function Admin() {
  const now = useClock();
  const [session, setSession] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("todos");
  const [unseen, setUnseen] = useState(0);
  const [soldOut, setSoldOut] = useState(false);
  const [savingSoldOut, setSavingSoldOut] = useState(false);
  // Los cupos van plegados: se tocan de vez en cuando y el panel es para
  // despachar pedidos, no para configurarlos.
  const [showSlots, setShowSlots] = useState(false);
  // Sube cada vez que se recargan los pedidos, para que los cupos tomados se
  // actualicen con el mismo aviso de realtime y no haya que recargar la página.
  const [ordersVersion, setOrdersVersion] = useState(0);
  const knownOrderIds = useRef(null);
  const playAlert = useAlertSound();

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  // silent: las recargas por realtime no deben vaciar la pantalla mientras se preparan pedidos.
  async function loadOrders({ silent = false } = {}) {
    if (!silent) setLoading(true);
    setError("");
    const { data, error: requestError } = await supabase.from("orders").select("*").eq("payment_status", "pagado").order("created_at", { ascending: false });
    if (requestError) setError("No fue posible cargar los pedidos. Revisa el permiso de administrador en Supabase.");
    else {
      const known = knownOrderIds.current;
      if (known) {
        const arrived = data.filter((order) => !known.has(order.id));
        if (arrived.length) { playAlert(); setUnseen((count) => count + arrived.length); }
      }
      knownOrderIds.current = new Set(data.map((order) => order.id));
      setOrdersVersion((version) => version + 1);
      setOrders(data);
      setSelected((current) => (current ? data.find((order) => order.id === current.id) ?? null : current));
    }
    if (!silent) setLoading(false);
  }

  async function loadSoldOut() {
    const { data } = await supabase.from("store_settings").select("sold_out_on").maybeSingle();
    setSoldOut(data?.sold_out_on === nextBlockDate());
  }

  async function toggleSoldOut() {
    const next = soldOut ? null : nextBlockDate();
    const aviso = next
      ? "¿Marcar el próximo bloque como AGOTADO? Dejará de aparecer como opción de reserva."
      : "¿Reactivar ese bloque? Volverá a aparecer como opción de reserva.";
    if (!window.confirm(aviso)) return;

    setSavingSoldOut(true);
    const { error: requestError } = await supabase
      .from("store_settings")
      .update({ sold_out_on: next, updated_at: new Date().toISOString() })
      .eq("id", true);
    setSavingSoldOut(false);

    if (requestError) { setError("No pudimos cambiar la disponibilidad. Inténtalo otra vez."); return; }
    setError("");
    setSoldOut(Boolean(next));
  }

  useEffect(() => { if (session) { loadOrders(); loadSoldOut(); } }, [session]);

  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel("orders-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => loadOrders({ silent: true }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session]);

  // El contador viaja al título para verlo aunque la pestaña esté en segundo plano.
  useEffect(() => {
    document.title = unseen > 0 ? `(${unseen}) ¡Pedido nuevo! · bapbap` : "Pedidos | bapbap";
  }, [unseen]);

  async function updateStatus(order, status) {
    const { error: requestError } = await supabase.from("orders").update({ status }).eq("id", order.id);
    if (requestError) { setError("No pudimos actualizar el estado."); return; }
    setOrders((current) => current.map((item) => item.id === order.id ? { ...item, status } : item));
    setSelected((current) => current?.id === order.id ? { ...current, status } : current);
  }

  if (!supabase) return <main className="admin-shell"><p>Falta configurar Supabase.</p></main>;
  if (!session) return <Login onSuccess={() => setError("")} />;

  const visibleOrders = filter === "todos" ? orders : orders.filter((order) => order.status === filter);
  const newCount = orders.filter((order) => order.status === "nuevo").length;
  const salesToday = sumSince(orders, startOfDay(now));
  const salesWeek = sumSince(orders, startOfWeek(now));

  return <main className="admin-shell">
    {unseen > 0 && <button className="new-order-alert" onClick={() => setUnseen(0)}>🔔 {unseen === 1 ? "1 pedido nuevo" : `${unseen} pedidos nuevos`} · toca para silenciar</button>}
    {soldOut && <p className="sold-out-notice">🛑 El próximo bloque de entrega está marcado como <strong>agotado</strong> y no aparece para reservar. Se reactiva solo apenas pase ese bloque.</p>}
    <header className="admin-header"><a className="brand" href="/"><strong>bapbap</strong></a><div><span className="admin-clock">{formatTime(now)}</span><span className="admin-email">{session.user.email}</span><button className="link-button" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button></div></header>
    <section className="admin-intro"><div><p className="eyebrow">ADMINISTRACIÓN</p><h1>Pedidos</h1><p>Revisa, confirma y prepara cada pedido desde un solo lugar.</p></div><div className="admin-actions"><button className={soldOut ? "sold-out-button active" : "sold-out-button"} onClick={toggleSoldOut} disabled={savingSoldOut}>{savingSoldOut ? "Guardando…" : soldOut ? "✅ Reactivar ventas" : "🛑 Marcar agotado"}</button><button className={showSlots ? "refresh-button active" : "refresh-button"} onClick={() => setShowSlots((open) => !open)}>🗓️ Cupos</button><button className="refresh-button" onClick={playAlert}>🔔 Probar sonido</button><button className="refresh-button" onClick={() => loadOrders()}>↻ Actualizar</button></div></section>
    {showSlots && <SlotLimits onError={setError} ordersVersion={ordersVersion} />}
    <section className="admin-stats"><span>Hoy <strong>{pesos.format(salesToday)}</strong></span><span>Semana <strong>{pesos.format(salesWeek)}</strong></span><span>Total <strong>{orders.length}</strong></span><span>Nuevos <strong className="highlight">{newCount}</strong></span><span>Preparando <strong>{orders.filter((order) => order.status === "preparando").length}</strong></span></section>
    <div className="filters">{["todos", "nuevo", "confirmado", "preparando", "enviado", "entregado"].map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item === "todos" ? "Todos" : statusLabels[item]}</button>)}</div>
    {error && <p className="admin-error">{error}</p>}
    {loading ? <p className="loading">Cargando pedidos…</p> : <section className="order-layout"><div className="order-list">{visibleOrders.length === 0 ? <p className="empty-orders">No hay pedidos en esta lista.</p> : groupByReservation(visibleOrders).map((group) => <div key={group.date ?? "sin-reserva"}><div className="order-group-header"><p className="order-group-title">{group.date ? formatGroupDate(group.date) : "Sin reserva"} · {group.orders.length} {group.orders.length === 1 ? "pedido" : "pedidos"}</p><p className="order-group-summary">{summarizeItems(group.orders)}</p></div>{group.orders.map((order) => <button className={`order-row ${selected?.id === order.id ? "selected" : ""}`} onClick={() => setSelected(order)} key={order.id}><div><span className={`status ${order.status}`}>{statusLabels[order.status]}</span>{slotChip(order) ? <span className={order.order_mode === "ahora" ? "slot-chip now" : "slot-chip"}>{slotChip(order)}</span> : null}<strong>#{order.order_number} · {order.customer_name}</strong></div><b>{pesos.format(order.total)}</b></button>)}</div>)}</div><OrderDetail order={selected} onStatusChange={updateStatus} /></section>}
  </main>;
}

function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  async function submit(event) { event.preventDefault(); setSubmitting(true); setError(""); const { error: loginError } = await supabase.auth.signInWithPassword({ email, password }); setSubmitting(false); if (loginError) setError("Correo o contraseña incorrectos."); }
  return <main className="login-page"><form className="login-card" onSubmit={submit}><a className="brand" href="/"><strong>bapbap</strong></a><p className="eyebrow">PANEL PRIVADO</p><h1>Ingresa a tus pedidos.</h1><label>Correo administrador<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Contraseña<input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="admin-error">{error}</p>}<button className="login-button" disabled={submitting}>{submitting ? "Ingresando…" : "Ingresar"}</button></form></main>;
}

// Los cupos viven en la base para poder cambiarlos sin volver a desplegar. Al
// lado de cada tope va lo que ya se tomó en la próxima ocurrencia de ese día,
// que es el número con el que se decide si abrir o cerrar una hora. Un tope en
// 0 cierra esa ventana sin tocar el resto del día.
function SlotLimits({ onError, ordersVersion }) {
  const [rows, setRows] = useState(null);
  const [usage, setUsage] = useState(new Map());
  const [saving, setSaving] = useState("");

  const readUsage = useCallback(async () => {
    const { data, error } = await supabase.rpc("slot_load");
    if (error) return;
    setUsage(new Map((data ?? []).map((row) => [`${row.slot_date}|${row.start_hour}`, row.taken])));
  }, []);

  // Los topes se leen al abrir el panel: solo cambian desde acá.
  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase.from("slot_limits").select("weekday, start_hour, end_hour, capacity");
      if (!active) return;
      if (error) { onError("No pudimos cargar los cupos por ventana."); return; }
      setRows(data ?? []);
    })();
    return () => { active = false; };
  }, [onError]);

  // Los cupos tomados sí cambian solos, así que se refrescan al entrar un
  // pedido y cada medio minuto por si el realtime se cae. Se actualiza únicamente
  // el conteo, nunca los topes: hacerlo borraría lo que se esté escribiendo.
  useEffect(() => {
    readUsage();
    const id = setInterval(readUsage, 30000);
    return () => clearInterval(id);
  }, [readUsage, ordersVersion]);

  // Se guarda al salir del campo, no en cada tecla: escribir "12" no debe pasar
  // primero por un tope de 1.
  async function save(row) {
    const key = `${row.weekday}|${row.start_hour}`;
    const capacity = Math.min(99, Math.max(0, Number(row.capacity) || 0));
    setSaving(key);
    const { error } = await supabase.from("slot_limits")
      .update({ capacity, updated_at: new Date().toISOString() })
      .eq("weekday", row.weekday).eq("start_hour", row.start_hour);
    setSaving("");
    if (error) { onError("No pudimos guardar el cupo. Inténtalo otra vez."); return; }
    onError("");
    setRows((current) => current.map((item) => item.weekday === row.weekday && item.start_hour === row.start_hour ? { ...item, capacity } : item));
  }

  function edit(row, value) {
    setRows((current) => current.map((item) => item.weekday === row.weekday && item.start_hour === row.start_hour ? { ...item, capacity: value } : item));
  }

  if (!rows) return <p className="loading">Cargando cupos…</p>;
  const now = getSantiagoNow();

  return <section className="slot-limits">
    <p className="slot-limits-note">Cuántos pedidos acepta cada ventana. Al llenarse deja de aparecer para reservar. En <strong>0</strong> la ventana queda cerrada.</p>
    <div className="slot-days">
      {BLOCKS.map((block) => {
        const date = nextOccurrence(block, now);
        return <div className="slot-day" key={block.weekday}>
          <h3>{block.label} <small>{formatShortDate(date)}</small></h3>
          {blockSlots(block).map((slot) => {
            const row = rows.find((item) => item.weekday === block.weekday && item.start_hour === slot.startHour);
            const taken = usage.get(`${date}|${slot.startHour}`) ?? 0;
            const full = row != null && taken >= Number(row.capacity);
            return <label className="slot-row" key={slot.startHour}>
              <span>{slot.startHour}:00 – {slot.endHour}:00</span>
              <b className={full ? "full" : ""}>{full ? "lleno" : `${taken} ${taken === 1 ? "tomado" : "tomados"}`}</b>
              <input type="number" min="0" max="99" value={row?.capacity ?? ""} disabled={!row || saving === `${block.weekday}|${slot.startHour}`}
                onChange={(event) => edit(row, event.target.value)} onBlur={() => save(row)} />
            </label>;
          })}
        </div>;
      })}
    </div>
  </section>;
}

function OrderDetail({ order, onStatusChange }) {
  if (!order) return <aside className="order-detail placeholder"><p>Selecciona un pedido para ver sus detalles.</p></aside>;
  // El despacho no se guarda aparte: es lo que resta del total una vez descontados los productos,
  // así cada pedido muestra el valor que se le cobró aunque la tarifa cambie después.
  const itemsTotal = order.items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const deliveryFee = order.total - itemsTotal;
  return <aside className="order-detail"><div className="detail-heading"><div><span className={`status ${order.status}`}>{statusLabels[order.status]}</span><h2>#{order.order_number} · {order.customer_name}</h2><small>{formatDateTime(order.created_at)}</small></div><strong>{pesos.format(order.total)}</strong></div>{order.reserved_label ? <section><h3>Reservado para</h3><p>{order.reserved_label}</p></section> : null}<section><h3>Contacto</h3><p>{order.customer_phone}</p>{whatsappLink(order) ? <a className="whatsapp-button" href={whatsappLink(order)} target="_blank" rel="noreferrer">💬 Escribir por WhatsApp</a> : null}</section><section><h3>Delivery</h3><p>{order.comuna}</p><p>{order.delivery_address}</p><p>Despacho: {pesos.format(deliveryFee)}</p></section><section><h3>Pedido</h3>{order.items.map((item, index) => <div className="item" key={index}><strong>{item.quantity}× {item.product}</strong>{item.sauce ? <span className="item-sauce">{item.sauce}</span> : null}{item.extras?.length ? <span>{item.extras.join(", ")}</span> : null}</div>)}</section><section><h3>Actualizar estado</h3><select value={order.status} onChange={(event) => onStatusChange(order, event.target.value)}>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></section></aside>;
}

createRoot(document.getElementById("root")).render(<Admin />);
