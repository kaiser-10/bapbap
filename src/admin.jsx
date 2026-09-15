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

// Debe coincidir con SLOT_HOURS en src/App.jsx y en create-payment.
const SLOT_HOURS = 2;
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_LABELS = { Mon: "Lunes", Tue: "Martes", Wed: "Miércoles", Thu: "Jueves", Fri: "Viernes", Sat: "Sábado", Sun: "Domingo" };

// El horario vive en la tabla opening_hours: una fila por día que se atiende.
function toBlocks(rows) {
  return rows
    .map((row) => ({ weekday: row.weekday, label: WEEKDAY_LABELS[row.weekday], openHour: row.open_hour, closeHour: row.close_hour }))
    .sort((a, b) => WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday));
}

function isClosedDate(date, closures) {
  return closures.some((range) => date >= range.date_from && date <= range.date_to);
}

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

// Igual que en la tienda: un día que cae en un cierre se corre a la semana
// siguiente, así los cupos muestran la fecha que de verdad se va a vender.
function nextOccurrence(block, now, closures) {
  const diff = (WEEKDAY_INDEX[block.weekday] - WEEKDAY_INDEX[now.weekday] + 7) % 7;
  const alreadyClosed = diff === 0 && now.hour >= block.closeHour;
  let date = addDays(now.date, alreadyClosed ? 7 : diff);
  for (let week = 0; week < 53 && isClosedDate(date, closures); week += 1) {
    date = addDays(date, 7);
  }
  return date;
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
  // Los cupos y los productos van plegados: se tocan de vez en cuando y el
  // panel es para despachar pedidos, no para configurarlos.
  const [showSlots, setShowSlots] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
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

  useEffect(() => { if (session) loadOrders(); }, [session]);

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
    <header className="admin-header"><a className="brand" href="/"><strong>bapbap</strong></a><div><span className="admin-clock">{formatTime(now)}</span><span className="admin-email">{session.user.email}</span><button className="link-button" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button></div></header>
    <section className="admin-intro"><div><p className="eyebrow">ADMINISTRACIÓN</p><h1>Pedidos</h1><p>Revisa, confirma y prepara cada pedido desde un solo lugar.</p></div><div className="admin-actions"><button className={showProducts ? "refresh-button active" : "refresh-button"} onClick={() => setShowProducts((open) => !open)}>🍗 Productos</button><button className={showSchedule ? "refresh-button active" : "refresh-button"} onClick={() => setShowSchedule((open) => !open)}>🕒 Horario y despacho</button><button className={showSlots ? "refresh-button active" : "refresh-button"} onClick={() => setShowSlots((open) => !open)}>🗓️ Cupos</button><button className="refresh-button" onClick={playAlert}>🔔 Probar sonido</button><button className="refresh-button" onClick={() => loadOrders()}>↻ Actualizar</button></div></section>
    {showProducts && <Products onError={setError} />}
    {showSchedule && <section className="settings-panel"><OpeningHours onError={setError} /><Closures onError={setError} /><Comunas onError={setError} /></section>}
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
  const [schedule, setSchedule] = useState({ blocks: [], closures: [] });
  const [usage, setUsage] = useState(new Map());
  const [saving, setSaving] = useState("");

  const readUsage = useCallback(async () => {
    const { data, error } = await supabase.rpc("slot_load");
    if (error) return;
    setUsage(new Map((data ?? []).map((row) => [`${row.slot_date}|${row.start_hour}`, row.taken])));
  }, []);

  // Los topes y el horario se leen al abrir el panel: solo cambian desde acá.
  useEffect(() => {
    let active = true;
    (async () => {
      const [limits, hours, closures] = await Promise.all([
        supabase.from("slot_limits").select("weekday, start_hour, end_hour, capacity"),
        supabase.from("opening_hours").select("weekday, open_hour, close_hour"),
        supabase.from("closures").select("date_from, date_to"),
      ]);
      if (!active) return;
      if (limits.error || hours.error || closures.error) { onError("No pudimos cargar los cupos por ventana."); return; }
      setSchedule({ blocks: toBlocks(hours.data ?? []), closures: closures.data ?? [] });
      setRows(limits.data ?? []);
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
    {schedule.blocks.length === 0 ? <p className="slot-limits-note">No hay días de atención configurados. Agrégalos en <strong>Horario y despacho</strong>.</p> : null}
    <div className="slot-days">
      {schedule.blocks.map((block) => {
        const date = nextOccurrence(block, now, schedule.closures);
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

const PHOTO_BUCKET = "product-photos";
const PHOTO_MAX_SIDE = 1400;

// Las fotos del celular pesan varios MB y la tienda las carga en datos móviles:
// se achican y pasan a JPG antes de subirlas.
async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No se pudo convertir la foto."))), "image/jpeg", 0.85);
  });
}

async function uploadPhoto(file, folder = "") {
  const blob = await compressPhoto(file);
  const path = `${folder}${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

// Solo las fotos subidas desde el panel viven en el bucket. Las de los
// productos originales están en /public del repo y no se tocan.
function bucketPath(url) {
  const marker = `/storage/v1/object/public/${PHOTO_BUCKET}/`;
  const index = url?.indexOf(marker) ?? -1;
  return index === -1 ? null : url.slice(index + marker.length);
}

async function removePhoto(url) {
  const path = bucketPath(url);
  if (path) await supabase.storage.from(PHOTO_BUCKET).remove([path]);
}

// El menú de la tienda. Los pedidos ya hechos guardan nombre y precio, así que
// editar o eliminar un producto no cambia el historial.
function Products({ onError }) {
  const [products, setProducts] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("products").select("*").order("sort_order").order("created_at");
    if (error) { onError("No pudimos cargar los productos. ¿Corriste products.sql en Supabase?"); return; }
    setProducts(data ?? []);
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  async function patch(product, changes) {
    setBusy(product.id);
    const { error } = await supabase.from("products").update({ ...changes, updated_at: new Date().toISOString() }).eq("id", product.id);
    setBusy("");
    if (error) { onError("No pudimos guardar el cambio. Inténtalo otra vez."); return; }
    onError("");
    setProducts((current) => current.map((item) => item.id === product.id ? { ...item, ...changes } : item));
  }

  async function remove(product) {
    if (!window.confirm(`¿Eliminar "${product.name}"? Desaparece del menú para siempre. Los pedidos anteriores no se ven afectados.\n\nSi solo quieres sacarlo por un tiempo, usa "Ocultar".`)) return;
    setBusy(product.id);
    const { error } = await supabase.from("products").delete().eq("id", product.id);
    setBusy("");
    if (error) { onError("No pudimos eliminar el producto."); return; }
    onError("");
    removePhoto(product.photo_url);
    setProducts((current) => current.filter((item) => item.id !== product.id));
  }

  function saved() {
    setEditing(null);
    load();
  }

  if (!products) return <p className="loading">Cargando productos…</p>;
  const nextSortOrder = products.reduce((max, item) => Math.max(max, item.sort_order), 0) + 10;

  return <section className="products-panel">
    <div className="products-head">
      <p className="slot-limits-note">Lo que marques acá se ve en la tienda en menos de un minuto. <strong>Agotado</strong> lo deja visible pero sin poder pedirlo; <strong>Ocultar</strong> lo saca del menú.</p>
      {editing ? null : <button className="login-button product-new" onClick={() => setEditing("new")}>+ Agregar producto</button>}
    </div>
    {editing === "new" ? <ProductForm sortOrder={nextSortOrder} onCancel={() => setEditing(null)} onSaved={saved} /> : null}
    <div className="product-list">
      {products.map((product) => editing?.id === product.id
        ? <ProductForm key={product.id} product={product} onCancel={() => setEditing(null)} onSaved={saved} />
        : <div className={product.hidden ? "product-row is-hidden" : "product-row"} key={product.id}>
          <div className="product-thumb">{product.photo_url ? <img src={product.photo_url} alt="" /> : null}</div>
          <div className="product-info">
            <strong>{product.name}</strong>
            <span>{pesos.format(product.price)}{product.has_sauce ? " · pregunta salsa" : ""}</span>
            <div className="product-badges">
              {product.sold_out ? <em className="badge sold">Agotado</em> : <em className="badge ok">Disponible</em>}
              {product.hidden ? <em className="badge">Oculto</em> : null}
            </div>
          </div>
          <div className="product-actions">
            <button className={product.sold_out ? "sold-out-button active" : "sold-out-button"} disabled={busy === product.id} onClick={() => patch(product, { sold_out: !product.sold_out })}>{product.sold_out ? "✅ Hay stock" : "🛑 Agotado"}</button>
            <button className="refresh-button" disabled={busy === product.id} onClick={() => patch(product, { hidden: !product.hidden })}>{product.hidden ? "👁️ Mostrar" : "🙈 Ocultar"}</button>
            <button className="refresh-button" disabled={Boolean(editing)} onClick={() => setEditing(product)}>✏️ Editar</button>
            <button className="refresh-button danger" disabled={busy === product.id} onClick={() => remove(product)}>🗑️</button>
          </div>
        </div>)}
    </div>
  </section>;
}

function ProductForm({ product, sortOrder, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({
    name: product?.name ?? "",
    description: product?.description ?? "",
    price: product?.price ?? "",
    has_sauce: product?.has_sauce ?? false,
  }));
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(product?.photo_url ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // La vista previa de una foto recién elegida es un blob local que hay que soltar.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); }

  async function submit(event) {
    event.preventDefault();
    const name = form.name.trim();
    const price = Number(form.price);
    if (name.length < 2) { setError("El nombre es muy corto."); return; }
    if (!Number.isInteger(price) || price < 100) { setError("El precio tiene que ser un número entero, sin puntos (ej: 5990)."); return; }
    if (!product && !file) { setError("Falta la foto del producto."); return; }

    setSaving(true);
    setError("");
    let photoUrl = product?.photo_url ?? null;
    try {
      if (file) photoUrl = await uploadPhoto(file);
    } catch {
      setSaving(false);
      setError("No pudimos subir la foto. Prueba con otra en JPG o PNG.");
      return;
    }

    const values = { name, description: form.description.trim(), price, has_sauce: form.has_sauce, photo_url: photoUrl, updated_at: new Date().toISOString() };
    const { error: requestError } = product
      ? await supabase.from("products").update(values).eq("id", product.id)
      : await supabase.from("products").insert({ ...values, sort_order: sortOrder });
    setSaving(false);

    if (requestError) {
      // Si falló el guardado, la foto recién subida quedaría huérfana.
      if (file) removePhoto(photoUrl);
      setError(requestError.code === "23505" ? "Ya existe un producto con ese nombre." : "No pudimos guardar el producto. Inténtalo otra vez.");
      return;
    }
    if (file && product?.photo_url) removePhoto(product.photo_url);
    onSaved();
  }

  return <form className="product-form" onSubmit={submit}>
    <h3>{product ? `Editar ${product.name}` : "Nuevo producto"}</h3>
    <div className="product-form-grid">
      <label className="product-photo-field">
        <span className="product-photo-preview">{preview ? <img src={preview} alt="" /> : <b>📷 Elegir foto</b>}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <small>{preview ? "Toca la foto para cambiarla" : "JPG o PNG"}</small>
      </label>
      <div className="product-fields">
        <label>Nombre<input required maxLength={80} value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Ej: Tteokbokki" /></label>
        <label>Descripción<textarea maxLength={300} rows={3} value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="Qué trae, para cuántas personas…" /></label>
        <label>Precio<input required type="number" min="100" step="1" inputMode="numeric" value={form.price} onChange={(event) => update("price", event.target.value)} placeholder="5990" /></label>
        <label className="product-check"><input type="checkbox" checked={form.has_sauce} onChange={(event) => update("has_sauce", event.target.checked)} /> Preguntar cómo quiere la salsa (con, sin o aparte)</label>
      </div>
    </div>
    {error ? <p className="admin-error">{error}</p> : null}
    <div className="product-form-actions">
      <button type="button" className="refresh-button" onClick={onCancel} disabled={saving}>Cancelar</button>
      <button className="login-button" disabled={saving}>{saving ? "Guardando…" : product ? "Guardar cambios" : "Agregar al menú"}</button>
    </div>
  </form>;
}

const HOUR_OPTIONS = Array.from({ length: 25 }, (_, hour) => hour);
const formatHour = (hour) => `${String(hour).padStart(2, "0")}:00`;

// Horario semanal. Se guarda todo junto con un botón: cambiar un día a medias
// dejaría la tienda con un horario que nadie eligió.
function OpeningHours({ onError }) {
  const [days, setDays] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase.from("opening_hours").select("weekday, open_hour, close_hour");
      if (!active) return;
      if (error) { onError("No pudimos cargar el horario. ¿Corriste store-config.sql en Supabase?"); return; }
      const byDay = new Map((data ?? []).map((row) => [row.weekday, row]));
      setDays(WEEKDAY_ORDER.map((weekday) => {
        const row = byDay.get(weekday);
        return { weekday, open: Boolean(row), openHour: row?.open_hour ?? 12, closeHour: row?.close_hour ?? 20 };
      }));
    })();
    return () => { active = false; };
  }, [onError]);

  function edit(weekday, changes) {
    setSavedAt(null);
    setDays((current) => current.map((day) => day.weekday === weekday ? { ...day, ...changes } : day));
  }

  async function save() {
    const open = days.filter((day) => day.open);
    const invalid = open.find((day) => Number(day.closeHour) <= Number(day.openHour));
    if (invalid) { onError(`${WEEKDAY_LABELS[invalid.weekday]}: la hora de cierre tiene que ser después de la de apertura.`); return; }
    if (!window.confirm("¿Guardar el horario? La tienda lo usa en menos de un minuto. Los pedidos que ya están pagados no se cancelan.")) return;

    setSaving(true);
    const now = new Date().toISOString();
    const closedDays = days.filter((day) => !day.open).map((day) => day.weekday);
    const openRows = open.map((day) => ({ weekday: day.weekday, open_hour: Number(day.openHour), close_hour: Number(day.closeHour), updated_at: now }));
    // Cada ventana nueva necesita su fila de tope: sin ella la ventana no tendría
    // límite. Las que ya existen no se tocan, para no pisar cupos configurados.
    const windows = open.flatMap((day) => blockSlots({ openHour: Number(day.openHour), closeHour: Number(day.closeHour) })
      .map((slot) => ({ weekday: day.weekday, start_hour: slot.startHour, end_hour: slot.endHour })));

    const results = await Promise.all([
      closedDays.length ? supabase.from("opening_hours").delete().in("weekday", closedDays) : { error: null },
      openRows.length ? supabase.from("opening_hours").upsert(openRows, { onConflict: "weekday" }) : { error: null },
      windows.length ? supabase.from("slot_limits").upsert(windows, { onConflict: "weekday,start_hour", ignoreDuplicates: true }) : { error: null },
    ]);
    setSaving(false);
    if (results.some((result) => result.error)) { onError("No pudimos guardar el horario completo. Revísalo y guarda de nuevo."); return; }
    onError("");
    setSavedAt(new Date());
  }

  if (!days) return <p className="loading">Cargando horario…</p>;

  return <div className="settings-block">
    <h3>Horario de atención</h3>
    <p className="slot-limits-note">Los días sin marcar quedan cerrados. Cada día se parte en ventanas de {SLOT_HOURS} horas para las preórdenes; los cupos de cada ventana se ajustan en <strong>Cupos</strong>.</p>
    <div className="hours-editor">
      {days.map((day) => <div className={day.open ? "hours-row" : "hours-row is-closed"} key={day.weekday}>
        <label className="hours-day"><input type="checkbox" checked={day.open} onChange={(event) => edit(day.weekday, { open: event.target.checked })} /> {WEEKDAY_LABELS[day.weekday]}</label>
        {day.open ? <div className="hours-range">
          <select value={day.openHour} onChange={(event) => edit(day.weekday, { openHour: Number(event.target.value) })} aria-label={`Apertura ${WEEKDAY_LABELS[day.weekday]}`}>{HOUR_OPTIONS.slice(0, 24).map((hour) => <option key={hour} value={hour}>{formatHour(hour)}</option>)}</select>
          <span>a</span>
          <select value={day.closeHour} onChange={(event) => edit(day.weekday, { closeHour: Number(event.target.value) })} aria-label={`Cierre ${WEEKDAY_LABELS[day.weekday]}`}>{HOUR_OPTIONS.slice(1).map((hour) => <option key={hour} value={hour}>{formatHour(hour)}</option>)}</select>
        </div> : <span className="hours-closed">Cerrado</span>}
      </div>)}
    </div>
    <div className="settings-actions">
      {savedAt ? <span className="settings-saved">✓ Guardado</span> : null}
      <button className="login-button" onClick={save} disabled={saving}>{saving ? "Guardando…" : "Guardar horario"}</button>
    </div>
  </div>;
}

// Días puntuales sin atención (feriados, vacaciones). La tienda salta esas
// fechas y ofrece la semana siguiente. El cierre desaparece solo al pasar.
function Closures({ onError }) {
  const [closures, setClosures] = useState(null);
  const [form, setForm] = useState({ from: "", to: "", reason: "" });
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const today = getSantiagoNow().date;

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("closures").select("*").gte("date_to", getSantiagoNow().date).order("date_from");
    if (error) { onError("No pudimos cargar los cierres."); return; }
    setClosures(data ?? []);
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  async function add(event) {
    event.preventDefault();
    const to = form.to || form.from;
    if (to < form.from) { onError("La fecha de término tiene que ser igual o posterior a la de inicio."); return; }

    // Cerrar no cancela lo que ya se vendió: mejor saberlo antes de confirmar.
    const { count } = await supabase.from("orders").select("id", { count: "exact", head: true })
      .eq("payment_status", "pagado").neq("status", "cancelado").gte("reserved_date", form.from).lte("reserved_date", to);
    const warning = count ? `\n\nOjo: ya hay ${count} ${count === 1 ? "pedido pagado" : "pedidos pagados"} para esas fechas. No se cancelan solos, hay que avisarles.` : "";
    if (!window.confirm(`¿Cerrar ${form.from === to ? `el ${formatShortDate(form.from)}` : `del ${formatShortDate(form.from)} al ${formatShortDate(to)}`}? Esos días no se podrá pedir.${warning}`)) return;

    setSaving(true);
    let noticeUrl = null;
    try {
      if (file) noticeUrl = await uploadPhoto(file, "avisos/");
    } catch {
      setSaving(false);
      onError("No pudimos subir la imagen del aviso. Prueba con otra en JPG o PNG.");
      return;
    }
    const { error } = await supabase.from("closures").insert({ date_from: form.from, date_to: to, reason: form.reason.trim(), notice_url: noticeUrl });
    setSaving(false);
    if (error) {
      if (noticeUrl) removePhoto(noticeUrl);
      onError("No pudimos guardar el cierre. Inténtalo otra vez.");
      return;
    }
    onError("");
    setForm({ from: "", to: "", reason: "" });
    setFile(null);
    load();
  }

  async function remove(closure) {
    if (!window.confirm("¿Quitar este cierre? Esos días vuelven a estar disponibles para pedir.")) return;
    const { error } = await supabase.from("closures").delete().eq("id", closure.id);
    if (error) { onError("No pudimos quitar el cierre."); return; }
    onError("");
    removePhoto(closure.notice_url);
    setClosures((current) => current.filter((item) => item.id !== closure.id));
  }

  if (!closures) return <p className="loading">Cargando cierres…</p>;

  return <div className="settings-block">
    <h3>Cierres y feriados</h3>
    <p className="slot-limits-note">Días en que no se atiende aunque estén en el horario. Si subes una imagen, se muestra en la tienda como aviso hasta el último día del cierre.</p>
    {closures.length === 0 ? <p className="settings-empty">No hay cierres programados.</p> : <div className="closure-list">
      {closures.map((closure) => <div className="closure-row" key={closure.id}>
        {closure.notice_url ? <img src={closure.notice_url} alt="" /> : <span className="closure-thumb-empty" />}
        <div>
          <strong>{closure.date_from === closure.date_to ? formatGroupDate(closure.date_from) : `${formatShortDate(closure.date_from)} – ${formatShortDate(closure.date_to)}`}</strong>
          <span>{closure.reason || "Sin motivo"}{closure.date_from <= today ? " · en curso" : ""}</span>
        </div>
        <button className="refresh-button danger" onClick={() => remove(closure)}>Quitar</button>
      </div>)}
    </div>}
    <form className="closure-form" onSubmit={add}>
      <label>Desde<input type="date" required min={today} value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} /></label>
      <label>Hasta<input type="date" min={form.from || today} value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })} /></label>
      <label>Motivo<input maxLength={80} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Ej: Año Nuevo" /></label>
      <label>Imagen de aviso (opcional)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      <button className="login-button" disabled={saving}>{saving ? "Guardando…" : "Agregar cierre"}</button>
    </form>
  </div>;
}

// Comunas con despacho. La tienda las agrupa por tarifa.
function Comunas({ onError }) {
  const [comunas, setComunas] = useState(null);
  const [form, setForm] = useState({ name: "", fee: "" });
  const [saving, setSaving] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("comunas").select("name, fee, sort_order").order("sort_order").order("name");
    if (error) { onError("No pudimos cargar las comunas."); return; }
    setComunas(data ?? []);
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  function edit(name, value) {
    setComunas((current) => current.map((comuna) => comuna.name === name ? { ...comuna, fee: value } : comuna));
  }

  // Se guarda al salir del campo, como los cupos: escribir "4490" no debe pasar
  // primero por un despacho de $4.
  async function saveFee(comuna) {
    const fee = Number(comuna.fee);
    if (!Number.isInteger(fee) || fee < 0) { onError(`El despacho de ${comuna.name} tiene que ser un número entero, sin puntos.`); return; }
    setSaving(comuna.name);
    const { error } = await supabase.from("comunas").update({ fee, updated_at: new Date().toISOString() }).eq("name", comuna.name);
    setSaving("");
    if (error) { onError("No pudimos guardar el despacho. Inténtalo otra vez."); return; }
    onError("");
    edit(comuna.name, fee);
  }

  async function add(event) {
    event.preventDefault();
    const name = form.name.trim();
    const fee = Number(form.fee);
    if (name.length < 2) { onError("El nombre de la comuna es muy corto."); return; }
    if (!Number.isInteger(fee) || fee < 0) { onError("El despacho tiene que ser un número entero, sin puntos (ej: 2990)."); return; }
    const sortOrder = comunas.reduce((max, comuna) => Math.max(max, comuna.sort_order), 0) + 10;
    setSaving("nueva");
    const { error } = await supabase.from("comunas").insert({ name, fee, sort_order: sortOrder });
    setSaving("");
    if (error) { onError(error.code === "23505" ? "Esa comuna ya está en la lista." : "No pudimos agregar la comuna."); return; }
    onError("");
    setForm({ name: "", fee: "" });
    load();
  }

  async function remove(comuna) {
    if (!window.confirm(`¿Dejar de despachar a ${comuna.name}? Desaparece de la lista de la tienda. Los pedidos anteriores no cambian.`)) return;
    const { error } = await supabase.from("comunas").delete().eq("name", comuna.name);
    if (error) { onError("No pudimos quitar la comuna."); return; }
    onError("");
    setComunas((current) => current.filter((item) => item.name !== comuna.name));
  }

  if (!comunas) return <p className="loading">Cargando comunas…</p>;

  return <div className="settings-block">
    <h3>Comunas y despacho</h3>
    <p className="slot-limits-note">Solo se despacha a las comunas de esta lista. El valor se guarda al salir del campo.</p>
    <div className="comuna-list">
      {comunas.map((comuna) => <div className="comuna-row" key={comuna.name}>
        <span>{comuna.name}</span>
        <span className="comuna-fee">$<input type="number" min="0" step="1" inputMode="numeric" value={comuna.fee} disabled={saving === comuna.name} onChange={(event) => edit(comuna.name, event.target.value)} onBlur={() => saveFee(comuna)} aria-label={`Despacho ${comuna.name}`} /></span>
        <button type="button" className="refresh-button danger" onClick={() => remove(comuna)} aria-label={`Quitar ${comuna.name}`}>🗑️</button>
      </div>)}
    </div>
    <form className="comuna-form" onSubmit={add}>
      <label>Nueva comuna<input required maxLength={60} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ej: Pirque" /></label>
      <label>Despacho<input required type="number" min="0" step="1" inputMode="numeric" value={form.fee} onChange={(event) => setForm({ ...form, fee: event.target.value })} placeholder="2990" /></label>
      <button className="login-button" disabled={saving === "nueva"}>{saving === "nueva" ? "Agregando…" : "Agregar"}</button>
    </form>
  </div>;
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
