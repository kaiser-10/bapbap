import { useEffect, useMemo, useState } from "react";
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

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Admin() {
  const now = useClock();
  const [session, setSession] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("todos");

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  async function loadOrders() {
    setLoading(true); setError("");
    const { data, error: requestError } = await supabase.from("orders").select("*").eq("payment_status", "pagado").order("created_at", { ascending: false });
    if (requestError) setError("No fue posible cargar los pedidos. Revisa el permiso de administrador en Supabase.");
    else {
      setOrders(data);
      setSelected((current) => (current ? data.find((order) => order.id === current.id) ?? null : current));
    }
    setLoading(false);
  }

  useEffect(() => { if (session) loadOrders(); }, [session]);

  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel("orders-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => loadOrders())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session]);

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

  return <main className="admin-shell">
    <header className="admin-header"><a className="brand" href="/"><strong>bapbap</strong></a><div><span className="admin-clock">{formatTime(now)}</span><span className="admin-email">{session.user.email}</span><button className="link-button" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button></div></header>
    <section className="admin-intro"><div><p className="eyebrow">ADMINISTRACIÓN</p><h1>Pedidos</h1><p>Revisa, confirma y prepara cada pedido desde un solo lugar.</p></div><button className="refresh-button" onClick={loadOrders}>↻ Actualizar</button></section>
    <section className="admin-stats"><div><span>Total</span><strong>{orders.length}</strong></div><div><span>Nuevos</span><strong>{newCount}</strong></div><div><span>En preparación</span><strong>{orders.filter((order) => order.status === "preparando").length}</strong></div></section>
    <div className="filters">{["todos", "nuevo", "confirmado", "preparando", "enviado", "entregado"].map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{item === "todos" ? "Todos" : statusLabels[item]}</button>)}</div>
    {error && <p className="admin-error">{error}</p>}
    {loading ? <p className="loading">Cargando pedidos…</p> : <section className="order-layout"><div className="order-list">{visibleOrders.length === 0 ? <p className="empty-orders">No hay pedidos en esta lista.</p> : visibleOrders.map((order) => <button className={`order-row ${selected?.id === order.id ? "selected" : ""}`} onClick={() => setSelected(order)} key={order.id}><div><span className={`status ${order.status}`}>{statusLabels[order.status]}</span><strong>{order.customer_name}</strong><small>{formatDateTime(order.created_at)}</small></div><b>{pesos.format(order.total)}</b></button>)}</div><OrderDetail order={selected} onStatusChange={updateStatus} /></section>}
  </main>;
}

function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false);
  async function submit(event) { event.preventDefault(); setSubmitting(true); setError(""); const { error: loginError } = await supabase.auth.signInWithPassword({ email, password }); setSubmitting(false); if (loginError) setError("Correo o contraseña incorrectos."); }
  return <main className="login-page"><form className="login-card" onSubmit={submit}><a className="brand" href="/"><strong>bapbap</strong></a><p className="eyebrow">PANEL PRIVADO</p><h1>Ingresa a tus pedidos.</h1><label>Correo administrador<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Contraseña<input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="admin-error">{error}</p>}<button className="login-button" disabled={submitting}>{submitting ? "Ingresando…" : "Ingresar"}</button></form></main>;
}

function OrderDetail({ order, onStatusChange }) {
  if (!order) return <aside className="order-detail placeholder"><p>Selecciona un pedido para ver sus detalles.</p></aside>;
  return <aside className="order-detail"><div className="detail-heading"><div><span className={`status ${order.status}`}>{statusLabels[order.status]}</span><h2>{order.customer_name}</h2><small>{formatDateTime(order.created_at)}</small></div><strong>{pesos.format(order.total)}</strong></div><section><h3>Contacto</h3><p>{order.customer_phone}</p></section><section><h3>{order.delivery_method}</h3><p>{order.delivery_method === "Delivery" ? order.delivery_address : "Retiro coordinado"}</p>{order.delivery_method === "Delivery" && <p>Despacho: {pesos.format(2990)}</p>}</section><section><h3>Pedido</h3>{order.items.map((item, index) => <div className="item" key={index}><strong>{item.quantity}× {item.product}</strong><span>{item.sauce}{item.extras?.length ? ` · ${item.extras.join(", ")}` : ""}</span></div>)}</section><section><h3>Actualizar estado</h3><select value={order.status} onChange={(event) => onStatusChange(order, event.target.value)}>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></section></aside>;
}

createRoot(document.getElementById("root")).render(<Admin />);
