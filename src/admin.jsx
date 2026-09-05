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

// El "agotado" se guarda como la fecha en que se marcó, en hora de Santiago:
// solo vale para hoy, así la tienda se reactiva sola en el próximo servicio.
function santiagoToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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
      setOrders(data);
      setSelected((current) => (current ? data.find((order) => order.id === current.id) ?? null : current));
    }
    if (!silent) setLoading(false);
  }

  async function loadSoldOut() {
    const { data } = await supabase.from("store_settings").select("sold_out_on").maybeSingle();
    setSoldOut(data?.sold_out_on === santiagoToday());
  }

  async function toggleSoldOut() {
    const next = soldOut ? null : santiagoToday();
    const aviso = next
      ? "¿Marcar la tienda como AGOTADA? Dejará de recibir pedidos nuevos de inmediato."
      : "¿Reactivar las ventas? La tienda volverá a recibir pedidos.";
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
    {soldOut && <p className="sold-out-notice">🛑 La tienda está marcada como <strong>agotada</strong> y no recibe pedidos. Se reactiva sola en el próximo servicio.</p>}
    <header className="admin-header"><a className="brand" href="/"><strong>bapbap</strong></a><div><span className="admin-clock">{formatTime(now)}</span><span className="admin-email">{session.user.email}</span><button className="link-button" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button></div></header>
    <section className="admin-intro"><div><p className="eyebrow">ADMINISTRACIÓN</p><h1>Pedidos</h1><p>Revisa, confirma y prepara cada pedido desde un solo lugar.</p></div><div className="admin-actions"><button className={soldOut ? "sold-out-button active" : "sold-out-button"} onClick={toggleSoldOut} disabled={savingSoldOut}>{savingSoldOut ? "Guardando…" : soldOut ? "✅ Reactivar ventas" : "🛑 Marcar agotado"}</button><button className="refresh-button" onClick={playAlert}>🔔 Probar sonido</button><button className="refresh-button" onClick={() => loadOrders()}>↻ Actualizar</button></div></section>
    <section className="admin-stats"><div><span>Ventas hoy</span><strong>{pesos.format(salesToday)}</strong></div><div><span>Ventas esta semana</span><strong>{pesos.format(salesWeek)}</strong></div><div><span>Total</span><strong>{orders.length}</strong></div><div><span>Nuevos</span><strong>{newCount}</strong></div><div><span>En preparación</span><strong>{orders.filter((order) => order.status === "preparando").length}</strong></div></section>
    <div className="filters">{["todos", "nuevo", "confirmado", "preparando", "enviado", "entregado"].map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item === "todos" ? "Todos" : statusLabels[item]}</button>)}</div>
    {error && <p className="admin-error">{error}</p>}
    {loading ? <p className="loading">Cargando pedidos…</p> : <section className="order-layout"><div className="order-list">{visibleOrders.length === 0 ? <p className="empty-orders">No hay pedidos en esta lista.</p> : visibleOrders.map((order) => <button className={`order-row ${selected?.id === order.id ? "selected" : ""}`} onClick={() => setSelected(order)} key={order.id}><div><span className={`status ${order.status}`}>{statusLabels[order.status]}</span><strong>#{order.order_number} · {order.customer_name}</strong><small>{formatDateTime(order.created_at)}</small></div><b>{pesos.format(order.total)}</b></button>)}</div><OrderDetail order={selected} onStatusChange={updateStatus} /></section>}
  </main>;
}

function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  async function submit(event) { event.preventDefault(); setSubmitting(true); setError(""); const { error: loginError } = await supabase.auth.signInWithPassword({ email, password }); setSubmitting(false); if (loginError) setError("Correo o contraseña incorrectos."); }
  return <main className="login-page"><form className="login-card" onSubmit={submit}><a className="brand" href="/"><strong>bapbap</strong></a><p className="eyebrow">PANEL PRIVADO</p><h1>Ingresa a tus pedidos.</h1><label>Correo administrador<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Contraseña<input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="admin-error">{error}</p>}<button className="login-button" disabled={submitting}>{submitting ? "Ingresando…" : "Ingresar"}</button></form></main>;
}

function OrderDetail({ order, onStatusChange }) {
  if (!order) return <aside className="order-detail placeholder"><p>Selecciona un pedido para ver sus detalles.</p></aside>;
  // El despacho no se guarda aparte: es lo que resta del total una vez descontados los productos,
  // así cada pedido muestra el valor que se le cobró aunque la tarifa cambie después.
  const itemsTotal = order.items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const deliveryFee = order.total - itemsTotal;
  return <aside className="order-detail"><div className="detail-heading"><div><span className={`status ${order.status}`}>{statusLabels[order.status]}</span><h2>#{order.order_number} · {order.customer_name}</h2><small>{formatDateTime(order.created_at)}</small></div><strong>{pesos.format(order.total)}</strong></div><section><h3>Contacto</h3><p>{order.customer_phone}</p></section><section><h3>Delivery</h3><p>{order.comuna}</p><p>{order.delivery_address}</p><p>Despacho: {pesos.format(deliveryFee)}</p></section><section><h3>Pedido</h3>{order.items.map((item, index) => <div className="item" key={index}><strong>{item.quantity}× {item.product}</strong>{item.sauce ? <span className="item-sauce">{item.sauce}</span> : null}{item.extras?.length ? <span>{item.extras.join(", ")}</span> : null}</div>)}</section><section><h3>Actualizar estado</h3><select value={order.status} onChange={(event) => onStatusChange(order, event.target.value)}>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></section></aside>;
}

createRoot(document.getElementById("root")).render(<Admin />);
