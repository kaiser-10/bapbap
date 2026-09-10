import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { supabase } from "./lib/supabase";

const fadeUp = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };
const drawerTransition = { type: "spring", stiffness: 320, damping: 34 };
const cardReveal = {
  initial: { opacity: 0, y: 26 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.15 },
  transition: { duration: 0.5, ease: "easeOut" },
};

const products = [
  {
    id: "media",
    name: "Media porción",
    description: "Pollo coreano crocante con una pequeña porción de nabo.",
    price: 11990,
    photo: "/photos/pollo-individual.jpg",
    hasSauce: true,
  },
  {
    id: "porcion",
    name: "Porción (2 a 3 personas)",
    description: "El doble de pollo coreano crocante, con una pequeña porción de nabo.",
    price: 19990,
    photo: "/photos/pollo-compartir.jpg",
    hasSauce: true,
  },
  {
    id: "bibimbap",
    name: "Bibimbap",
    description: "Arroz con carne salteada, vegetales frescos, huevo frito y sésamo.",
    price: 8990,
    photo: "/photos/bibimbap.jpg",
    hasSauce: false,
  },
  {
    id: "coca-cola",
    name: "Coca-Cola en lata",
    description: "350 ml, bien fría.",
    price: 1500,
    photo: "/photos/coca-cola.jpg",
    hasSauce: false,
  },
  {
    id: "arroz",
    name: "Porción de arroz",
    description: "Arroz blanco recién preparado, para acompañar cualquier porción.",
    price: 2000,
    photo: "/photos/arroz.jpg",
    hasSauce: false,
  },
];

// Preferencia de servido, sin costo. El orden importa: el primero es el que viene marcado.
const SAUCE_CHOICES = ["Con salsa", "Sin salsa", "Salsa aparte"];
const DEFAULT_SAUCE = SAUCE_CHOICES[0];

const COMUNA_GROUPS = [
  { fee: 2990, comunas: ["Puente Alto", "San Bernardo", "El Bosque", "La Pintana"] },
  { fee: 4490, comunas: ["La Florida", "La Granja", "San Ramón", "La Cisterna"] },
];
const COMUNA_FEES = Object.fromEntries(COMUNA_GROUPS.flatMap((group) => group.comunas.map((comuna) => [comuna, group.fee])));
const COMUNAS = Object.keys(COMUNA_FEES);

// Bloques de entrega de la semana. Los pedidos se reciben cualquier día; el
// cliente reserva en cuál de estos bloques quiere que le llegue. Debe
// coincidir con BLOCKS en create-payment.
const BLOCKS = [
  { weekday: "Fri", label: "Viernes", openHour: 17, closeHour: 20 },
  { weekday: "Sat", label: "Sábado", openHour: 12, closeHour: 20 },
  { weekday: "Sun", label: "Domingo", openHour: 12, closeHour: 17 },
];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Frases de la marquesina. Sin horarios: esos viven en la sección de reserva.
const TICKER = ["RESERVA CUALQUIER DÍA", "HECHO AL MOMENTO", "NABO INCLUIDO", "DESPACHO DESDE $2.990"];

// Pausa puntual: no se ofrece ningún bloque anterior a esta fecha (formato
// YYYY-MM-DD, hora de Santiago). Al llegar el día, vuelve solo; no hay que
// tocar nada. Para reabrir antes, poner una fecha pasada. Debe coincidir con
// create-payment.
const REOPEN_DATE = "2026-08-22";
const REOPEN_LABEL = "sábado 22 de agosto";

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
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    hour: Number(get("hour")) % 24,
  };
}

function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatBlockDate(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return new Intl.DateTimeFormat("es-CL", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function nextOccurrence(block, now) {
  const diff = (WEEKDAY_INDEX[block.weekday] - WEEKDAY_INDEX[now.weekday] + 7) % 7;
  const alreadyClosed = diff === 0 && now.hour >= block.closeHour;
  return addDays(now.date, alreadyClosed ? 7 : diff);
}

function getUpcomingBlocks(now = getSantiagoNow()) {
  return BLOCKS.map((block) => ({ ...block, date: nextOccurrence(block, now) }))
    .filter((block) => block.date >= REOPEN_DATE)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function blockLabel(block) {
  return `${block.label} ${formatBlockDate(block.date)} · ${block.openHour}:00-${block.closeHour}:00 hrs`;
}

// El "agotado" lo controla el panel de admin y vive en la base de datos, porque
// tiene que poder cambiar sin volver a desplegar. Guarda la fecha del bloque
// sin stock. Si la consulta falla, seguimos vendiendo: un problema de red
// nunca debe dejar la tienda cerrada por su cuenta.
async function readSoldOutDate() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("store_settings").select("sold_out_on").maybeSingle();
    if (error) return null;
    return data?.sold_out_on ?? null;
  } catch {
    return null;
  }
}

function useAvailableBlocks() {
  const [blocks, setBlocks] = useState(() => getUpcomingBlocks());

  useEffect(() => {
    let active = true;
    async function refresh() {
      const soldOutDate = await readSoldOutDate();
      const upcoming = getUpcomingBlocks().filter((block) => block.date !== soldOutDate);
      if (active) setBlocks(upcoming);
    }
    refresh();
    const id = setInterval(refresh, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return blocks;
}

const pesos = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

function formatPrice(price) {
  return pesos.format(price);
}

function App() {
  const blocks = useAvailableBlocks();
  const canOrder = blocks.length > 0;
  const [cart, setCart] = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [headerSolid, setHeaderSolid] = useState(false);
  const [form, setForm] = useState({ reservation: "", name: "", phone: "", comuna: COMUNAS[0], address: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [cart],
  );
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const deliveryFee = COMUNA_FEES[form.comuna] ?? 0;
  const orderTotal = cartTotal + deliveryFee;

  // Preselecciona el bloque más próximo apenas se sabe cuáles están disponibles.
  useEffect(() => {
    if (!form.reservation && blocks.length > 0) {
      setForm((current) => ({ ...current, reservation: blocks[0].weekday }));
    }
  }, [blocks]);

  useEffect(() => {
    const items = document.querySelectorAll(".reveal");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 },
    );
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  // El header va transparente sobre la foto del hero y se vuelve sólido al
  // bajar. Se mira un testigo al tope del hero en vez de escuchar el scroll:
  // así no corre nada en cada cuadro.
  useEffect(() => {
    const sentinel = document.querySelector(".scroll-sentinel");
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) => setHeaderSolid(!entry.isIntersecting));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  function addProduct(product, sauce) {
    // La salsa entra en la clave: dos porciones iguales con distinta salsa son líneas separadas.
    const key = `${product.id}-${sauce ?? "none"}`;
    const item = {
      key,
      product: product.name,
      sauce,
      unitPrice: product.price,
      quantity: 1,
    };

    setCart((current) => {
      const found = current.find((cartItem) => cartItem.key === key);
      if (!found) return [...current, item];
      return current.map((cartItem) =>
        cartItem.key === key ? { ...cartItem, quantity: cartItem.quantity + 1 } : cartItem,
      );
    });
    setCartOpen(true);
  }

  function changeQuantity(key, amount) {
    setCart((current) =>
      current
        .map((item) => (item.key === key ? { ...item, quantity: item.quantity + amount } : item))
        .filter((item) => item.quantity > 0),
    );
  }

  async function checkout(event) {
    event.preventDefault();
    if (!canOrder) {
      alert(`No hay horarios de entrega disponibles por ahora. Volvemos el ${REOPEN_LABEL}.`);
      return;
    }
    if (!supabase) {
      alert("Falta configurar la conexión con la base de datos.");
      return;
    }

    setIsSubmitting(true);
    const { data, error } = await supabase.functions.invoke("create-payment", {
      body: {
        customer: { name: form.name, phone: form.phone, comuna: form.comuna, address: form.address },
        reservation: { weekday: form.reservation },
        items: cart.map((item) => ({
        product: item.product,
        sauce: item.sauce,
        quantity: item.quantity,
      })),
      },
    });
    setIsSubmitting(false);

    if (error || !data?.checkoutUrl) {
      alert("No pudimos iniciar el pago. Inténtalo nuevamente.");
      return;
    }
    window.location.assign(data.checkoutUrl);
  }

  return (
    <MotionConfig reducedMotion="user">
      <header className={headerSolid ? "site-header shell is-solid" : "site-header shell"}>
        <a className="brand" href="#inicio" aria-label="bapbap, inicio">
          <img src="/logo-horizontal.svg" alt="bapbap" />
        </a>
        <nav aria-label="Navegación principal"><a href="#menu">Menú</a><a href="#cobertura">Cobertura</a><a href="#como-pedir">Cómo pedir</a></nav>
        <button className="cart-pill" onClick={() => setCartOpen(true)} aria-label="Abrir carrito">
          Carrito <AnimatePresence mode="popLayout" initial={false}><motion.span key={cartCount} initial={{ scale: 1.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ type: "spring", stiffness: 400, damping: 15 }}>{cartCount}</motion.span></AnimatePresence>
        </button>
      </header>

      <main>
        <section className="hero" id="inicio">
          <div className="scroll-sentinel" aria-hidden="true" />
          <div className="hero-photo"><img src="/photos/pollo-hero-nuevo.jpg" alt="Bandeja de pollo coreano crocante bañado en salsa con sésamo" /></div>
          <motion.div className="hero-copy" initial="hidden" animate="visible" variants={fadeUp} transition={{ duration: 0.6, ease: "easeOut" }}>
            <img className="hero-logo" src="/logo-featured.svg" alt="bapbap" />
            <p className="hero-eyebrow">POLLO COREANO EN PUENTE ALTO</p>
            <h1>Crujiente por fuera.<br /><em>Inolvidable</em> por dentro.</h1>
            <p className="hero-sub">Pollo frito coreano bañado en salsa, servido con una pequeña porción de nabo. Reserva cualquier día y elige cuándo lo quieres.</p>
            <a className="hero-cta" href="#menu">Ver el menú <span>↓</span></a>
          </motion.div>
        </section>

        {/* Seis copias idénticas: la pista se corre justo la mitad (tres copias), así
            el loop cierra sin salto y las tres restantes cubren cualquier pantalla.
            Sin cupos la marquesina se detiene: el aviso no debe pasar de largo. */}
        {canOrder ? <div className="ticker">
          <div className="ticker-track">
            {[0, 1, 2, 3, 4, 5].map((copy) => <div className="ticker-set" key={copy} aria-hidden={copy > 0}>
              {TICKER.map((text) => <span key={text}>{text}<b aria-hidden="true">✦</b></span>)}
            </div>)}
          </div>
        </div> : <div className="ticker ticker-closed"><span>SIN CUPOS POR AHORA · VOLVEMOS EL {REOPEN_LABEL.toUpperCase()}</span></div>}

        <section className="menu shell" id="menu">
          <div className="section-head reveal">
            <span className="section-tag">MENÚ</span>
            <h2>Tu antojo comienza aquí.</h2>
            <p>Elige una porción, dinos cómo la quieres y agrégala al carrito.</p>
          </div>
          <div className="menu-grid">
            {products.map((product, index) => <ProductCard key={product.id} product={product} onAdd={addProduct} canOrder={canOrder} wide={index === products.length - 1} />)}
          </div>
          <p className="payment-note reveal">🔒 Pago seguro con <strong>Mercado Pago</strong> · Débito o crédito · No guardamos los datos de tu tarjeta</p>
        </section>

        <section className="coverage shell reveal" id="cobertura">
          <span className="coverage-mark" aria-hidden="true">배달</span>
          <div className="section-head">
            <span className="section-tag">CUÁNDO Y DÓNDE</span>
            <h2>Reserva tu día.</h2>
            <p>Pide cualquier día de la semana y elige en cuál de estos horarios lo quieres.</p>
          </div>
          <div className="hours-grid">
            {BLOCKS.map((block) => <div className="hour" key={block.weekday}>
              <strong>{block.label}</strong>
              <span>{block.openHour}:00 — {block.closeHour}:00</span>
            </div>)}
          </div>
          <p className="coverage-label">DESPACHO SEGÚN TU COMUNA</p>
          <div className="coverage-grid">
            {COMUNA_GROUPS.map((group) => <div className="tier" key={group.fee}>
              <strong>{formatPrice(group.fee)}</strong>
              <small>DESPACHO</small>
              <p>{group.comunas.join(" · ")}</p>
            </div>)}
          </div>
        </section>

        <section className="steps shell" id="como-pedir">
          <div className="section-head reveal">
            <span className="section-tag">ASÍ DE SIMPLE</span>
            <h2>Pedir es fácil.</h2>
          </div>
          <div className="steps-grid">
            <div className="step reveal"><b>01</b><strong>Arma tu pedido</strong><p>Suma bibimbap, arroz o bebida si quieres.</p></div>
            <div className="step reveal"><b>02</b><strong>Elige el día</strong><p>Viernes, sábado o domingo, y tus datos de entrega.</p></div>
            <div className="step reveal"><b>03</b><strong>Paga online</strong><p>Con Mercado Pago, débito o crédito.</p></div>
          </div>
        </section>
      </main>

      <footer className="site-footer shell">
        <a className="brand" href="#inicio" aria-label="bapbap, inicio"><img src="/logo-footer.svg" alt="bapbap" /></a>
        <p>Pollo coreano · Puente Alto</p>
        <a href="https://www.instagram.com/bapbap.cl?igsh=MTRocjYzY2NydWZhdA==" target="_blank" rel="noreferrer">Instagram ↗</a>
      </footer>

      {/* La barra inferior solo aparece con algo dentro: vacía tapaba el botón del hero. */}
      <AnimatePresence>
        {cartCount > 0 && <motion.button className="mobile-cart" key="mobile-cart" onClick={() => setCartOpen(true)} initial={{ y: 90 }} animate={{ y: 0 }} exit={{ y: 90 }} transition={drawerTransition}><span>Tu pedido ({cartCount})</span><strong>{formatPrice(cartTotal)}</strong></motion.button>}
      </AnimatePresence>

      <AnimatePresence>
        {cartOpen && <Cart key="cart" cart={cart} total={cartTotal} onClose={() => setCartOpen(false)} onQuantity={changeQuantity} onCheckout={() => { setCartOpen(false); setCheckoutOpen(true); }} />}
        {checkoutOpen && <Checkout key="checkout" subtotal={cartTotal} deliveryFee={deliveryFee} total={orderTotal} form={form} setForm={setForm} isSubmitting={isSubmitting} blocks={blocks} canOrder={canOrder} onClose={() => setCheckoutOpen(false)} onSubmit={checkout} />}
      </AnimatePresence>
    </MotionConfig>
  );
}

function ProductCard({ product, onAdd, canOrder, wide }) {
  const [sauce, setSauce] = useState(product.hasSauce ? DEFAULT_SAUCE : null);

  return <motion.article className={wide ? "card card-wide" : "card"} {...cardReveal} whileHover={{ y: -7 }}>
    <div className="card-photo">
      <img src={product.photo} alt={product.name} />
      <span className="price-stamp">{formatPrice(product.price)}</span>
    </div>
    <div className="card-body">
      <h3>{product.name}</h3>
      <p>{product.description}</p>
      {product.hasSauce ? <div className="sauces" role="group" aria-label={`¿Cómo quieres ${product.name}?`}>
        {SAUCE_CHOICES.map((choice) => <button type="button" key={choice} className={sauce === choice ? "on" : ""} aria-pressed={sauce === choice} onClick={() => setSauce(choice)}>{choice}</button>)}
      </div> : null}
      <motion.button className="card-add" onClick={() => onAdd(product, sauce)} disabled={!canOrder} whileTap={canOrder ? { scale: 0.97 } : undefined}>{canOrder ? <>Agregar <span>+</span></> : "No disponible por ahora"}</motion.button>
    </div>
  </motion.article>;
}

function Cart({ cart, total, onClose, onQuantity, onCheckout }) {
  return <motion.div className="overlay" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
    <motion.aside className="cart" role="dialog" aria-modal="true" aria-label="Tu carrito" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={drawerTransition}>
      <div className="drawer-header"><h2>Tu pedido</h2><button onClick={onClose} aria-label="Cerrar carrito">×</button></div>
      {cart.length === 0 ? <div className="empty"><p>Aún no agregas nada.</p><button onClick={() => { onClose(); document.getElementById("menu")?.scrollIntoView(); }}>Ver el menú</button></div> : <><div className="cart-items"><AnimatePresence initial={false}>{cart.map((item) => <motion.div className="cart-item" key={item.key} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ duration: 0.25 }}><div><strong>{item.product}</strong>{item.sauce ? <p>{item.sauce}</p> : null}<b>{formatPrice(item.unitPrice * item.quantity)}</b></div><div className="quantity"><motion.button whileTap={{ scale: 0.85 }} onClick={() => onQuantity(item.key, -1)}>−</motion.button><span>{item.quantity}</span><motion.button whileTap={{ scale: 0.85 }} onClick={() => onQuantity(item.key, 1)}>+</motion.button></div></motion.div>)}</AnimatePresence></div><div className="cart-total"><span>Total</span><strong>{formatPrice(total)}</strong></div><motion.button className="primary-button checkout" whileTap={{ scale: 0.97 }} onClick={onCheckout}>Continuar al pago <span>→</span></motion.button></>}
    </motion.aside>
  </motion.div>;
}

function Checkout({ subtotal, deliveryFee, total, form, setForm, isSubmitting, blocks, canOrder, onClose, onSubmit }) {
  function update(event) { setForm({ ...form, [event.target.name]: event.target.value }); }
  return <motion.div className="overlay" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
    <motion.section className="checkout-modal" role="dialog" aria-modal="true" aria-label="Finalizar pedido" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={drawerTransition}>
      <div className="drawer-header"><h2>Finaliza tu pedido</h2><button onClick={onClose} aria-label="Cerrar">×</button></div>
      <form onSubmit={onSubmit}><label>¿Cuándo lo quieres?{canOrder ? <select required name="reservation" value={form.reservation} onChange={update}>{blocks.map((block) => <option key={block.weekday} value={block.weekday}>{blockLabel(block)}</option>)}</select> : <select disabled><option>No disponible por ahora</option></select>}</label><label>Nombre<input required maxLength={100} name="name" value={form.name} onChange={update} placeholder="Tu nombre" /></label><label>Teléfono<input required maxLength={30} type="tel" name="phone" value={form.phone} onChange={update} placeholder="+56 9 ..." /></label><label>Comuna<select name="comuna" value={form.comuna} onChange={update}>{COMUNA_GROUPS.map((group) => <optgroup label={`Despacho ${formatPrice(group.fee)}`} key={group.fee}>{group.comunas.map((comuna) => <option key={comuna}>{comuna}</option>)}</optgroup>)}</select><small>El valor del despacho cambia según la comuna. Solo despachamos a las que aparecen en la lista.</small></label><label>Dirección<input required maxLength={200} name="address" value={form.address} onChange={update} placeholder="Calle, número y depto/casa" /></label><div className="payment-box">{canOrder ? <><span>Método de pago</span><strong>Pago online seguro con Mercado Pago</strong><small>Te redirigiremos para completar el pago.</small></> : <><span>Sin cupos disponibles</span><strong>No estamos recibiendo pedidos por ahora</strong><small>Vuelve a intentarlo más tarde.</small></>}</div><div className="checkout-subtotal"><span>Subtotal</span><span>{formatPrice(subtotal)}</span></div><div className="checkout-subtotal"><span>Despacho</span><span>{formatPrice(deliveryFee)}</span></div><div className="checkout-total"><span>Total del pedido</span><strong>{formatPrice(total)}</strong></div><motion.button className="primary-button checkout" type="submit" disabled={isSubmitting || !canOrder} whileTap={!isSubmitting && canOrder ? { scale: 0.97 } : undefined}>{isSubmitting ? "Abriendo pago..." : "Ir a pagar"} <span>→</span></motion.button><p className="secure-note">No almacenamos datos de tu tarjeta.</p></form>
    </motion.section>
  </motion.div>;
}

export default App;
