import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { supabase } from "./lib/supabase";

const fadeUp = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };
const drawerTransition = { type: "spring", stiffness: 320, damping: 34 };

const products = [
  {
    id: "media",
    name: "Media porción",
    description: "Pollo coreano crocante con una pequeña porción de nabo.",
    price: 11990,
    photo: "/photos/pollo-individual.jpg",
  },
  {
    id: "porcion",
    name: "Porción (2 a 3 personas)",
    description: "El doble de pollo coreano crocante, con una pequeña porción de nabo.",
    price: 19990,
    photo: "/photos/pollo-compartir.jpg",
  },
];

const extras = [
  { id: "rice", name: "Agregar porción de arroz", price: 2000 },
];

// Preferencia de servido, sin costo. El orden importa: el primero es el que viene marcado.
const SAUCE_CHOICES = ["Con salsa", "Sin salsa", "Salsa aparte"];
const DEFAULT_SAUCE = SAUCE_CHOICES[0];

const DELIVERY_FEE = 2990;
const COMUNAS = ["Puente Alto", "San Bernardo", "El Bosque", "La Pintana"];
const OPEN_DAYS = ["Sat", "Sun"];
const OPEN_HOUR = 12;
const CLOSE_HOUR = 17;

// Pausa puntual: no hay venta hasta esta fecha (formato YYYY-MM-DD, hora de Santiago).
// Al llegar el día, la tienda vuelve sola a su horario normal; no hay que tocar nada.
// Para reabrir antes, poner una fecha pasada. Debe coincidir con create-payment.
const REOPEN_DATE = "2026-08-22";
const REOPEN_LABEL = "sábado 22 de agosto";

function getSantiagoDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isOnBreak(date = new Date()) {
  return getSantiagoDate(date) < REOPEN_DATE;
}

function getSantiagoParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  return {
    weekday: parts.find((part) => part.type === "weekday").value,
    hour: Number(parts.find((part) => part.type === "hour").value) % 24,
  };
}

function isStoreOpen(date = new Date()) {
  if (isOnBreak(date)) return false;
  const { weekday, hour } = getSantiagoParts(date);
  return OPEN_DAYS.includes(weekday) && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

function readClock() {
  return { withinHours: isStoreOpen(), onBreak: isOnBreak() };
}

// El "agotado" lo controla el panel de admin y vive en la base de datos, porque
// tiene que poder cambiar sin volver a desplegar. Si la consulta falla, seguimos
// vendiendo: un problema de red nunca debe dejar la tienda cerrada por su cuenta.
async function readSoldOut() {
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from("store_settings")
      .select("sold_out_on")
      .maybeSingle();
    if (error) return false;
    return data?.sold_out_on === getSantiagoDate(new Date());
  } catch {
    return false;
  }
}

function useStoreStatus() {
  const [status, setStatus] = useState(() => ({ ...readClock(), soldOut: false }));

  useEffect(() => {
    let active = true;
    async function refresh() {
      const soldOut = await readSoldOut();
      if (active) setStatus({ ...readClock(), soldOut });
    }
    refresh();
    const id = setInterval(refresh, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return status;
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
  const { withinHours, onBreak, soldOut } = useStoreStatus();
  const storeOpen = withinHours && !soldOut;
  const [cart, setCart] = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", comuna: COMUNAS[0], address: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [cart],
  );
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const deliveryFee = DELIVERY_FEE;
  const orderTotal = cartTotal + deliveryFee;

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

  function addProduct(product, selectedExtras, sauce) {
    const extrasTotal = selectedExtras.reduce((sum, extra) => sum + extra.price, 0);
    // La salsa entra en la clave: dos porciones iguales con distinta salsa son líneas separadas.
    const key = `${product.id}-${sauce}-${selectedExtras.map((extra) => extra.id).join("-")}`;
    const item = {
      key,
      product: product.name,
      sauce,
      extras: selectedExtras,
      unitPrice: product.price + extrasTotal,
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
    if (!storeOpen) {
      alert(soldOut
        ? "Se nos acabó el stock por hoy. ¡Te esperamos en el próximo servicio!"
        : onBreak
          ? `Este fin de semana no hay venta. Volvemos el ${REOPEN_LABEL}.`
          : "Estamos cerrados. Solo recibimos pedidos sábado y domingo de 12:00 a 17:00 hrs.");
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
        items: cart.map((item) => ({
        product: item.product,
        sauce: item.sauce,
        extras: item.extras.map((extra) => extra.name),
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
      <header className="site-header">
        <a className="brand" href="#inicio" aria-label="bapbap, inicio">
          <img src="/logo-horizontal.svg" alt="bapbap" />
        </a>
        <nav aria-label="Navegación principal"><a href="#menu">Menú</a><a href="#como-pedir">Cómo pedir</a></nav>
        <button className="cart-button" onClick={() => setCartOpen(true)} aria-label="Abrir carrito">
          Carrito <AnimatePresence mode="popLayout" initial={false}><motion.span key={cartCount} initial={{ scale: 1.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ type: "spring", stiffness: 400, damping: 15 }}>{cartCount}</motion.span></AnimatePresence>
        </button>
      </header>

      <main>
        <section className="hero" id="inicio">
          <motion.div className="hero-copy" initial="hidden" animate="visible" variants={fadeUp} transition={{ duration: 0.6, ease: "easeOut" }}>
            <img className="hero-logo" src="/logo-featured.svg" alt="bapbap" />
            <p className="eyebrow">POLLO COREANO EN PUENTE ALTO</p>
            <h1>Crujiente por fuera.<br /><em>Inolvidable</em> por dentro.</h1>
            <p>Pollo frito coreano bañado en salsa, servido con una pequeña porción de nabo.</p>
            <a className="primary-button" href="#menu">Pide ahora <span>↓</span></a>
          </motion.div>
          <motion.div className="hero-image" initial="hidden" animate="visible" variants={fadeUp} transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}>
            <img src="/photos/pollo-hero.jpg" alt="Pollo coreano con nabo" />
          </motion.div>
        </section>

        <section className="promise"><span>{soldOut ? "AGOTADO POR HOY · VUELVE EN EL PRÓXIMO SERVICIO" : onBreak ? `ESTE FIN DE SEMANA NO HAY VENTA · VOLVEMOS EL ${REOPEN_LABEL.toUpperCase()}` : storeOpen ? `ABIERTO AHORA · HASTA LAS ${CLOSE_HOUR}:00 HRS` : `CERRADO · ABRIMOS SÁB Y DOM ${OPEN_HOUR}:00-${CLOSE_HOUR}:00 HRS`}</span><b>✦</b><span>HECHO AL MOMENTO</span><b>✦</b><span>NABO INCLUIDO</span><b>✦</b><span>PAGO SEGURO CON MERCADO PAGO</span></section>

        <section className="menu-section" id="menu">
          <div className="section-title reveal"><p className="eyebrow">MENÚ</p><h2>Tu antojo comienza aquí.</h2><p>Elige una porción, personalízala y agrégala al carrito.</p></div>
          <div className="product-grid">
            {products.map((product) => <ProductCard key={product.id} product={product} onAdd={addProduct} storeOpen={storeOpen} onBreak={onBreak} soldOut={soldOut} />)}
          </div>
          <p className="payment-note reveal">🔒 Pago seguro con <strong>Mercado Pago</strong> · Débito o crédito · No guardamos los datos de tu tarjeta</p>
        </section>

        <section className="steps" id="como-pedir">
          <div className="reveal"><p className="eyebrow">ASÍ DE SIMPLE</p><h2>Pedir es fácil.</h2></div>
          <ol><li className="reveal"><span>01</span><strong>Elige tu pollo</strong><p>Agrega los extras que quieras.</p></li><li className="reveal"><span>02</span><strong>Revisa tu carrito</strong><p>Completa los datos de entrega.</p></li><li className="reveal"><span>03</span><strong>Paga online</strong><p>Con Mercado Pago, débito o crédito.</p></li></ol>
        </section>
      </main>

      <footer><p>Pollo coreano</p><a className="brand" href="#inicio" aria-label="bapbap, inicio"><img src="/logo-footer.svg" alt="bapbap" /></a><a href="https://www.instagram.com/bapbap.cl?igsh=MTRocjYzY2NydWZhdA==" target="_blank" rel="noreferrer">Instagram ↗</a></footer>

      <button className="mobile-cart" onClick={() => setCartOpen(true)}><span>Tu pedido ({cartCount})</span><strong>{formatPrice(cartTotal)}</strong></button>

      <AnimatePresence>
        {cartOpen && <Cart key="cart" cart={cart} total={cartTotal} onClose={() => setCartOpen(false)} onQuantity={changeQuantity} onCheckout={() => { setCartOpen(false); setCheckoutOpen(true); }} />}
        {checkoutOpen && <Checkout key="checkout" subtotal={cartTotal} deliveryFee={deliveryFee} total={orderTotal} form={form} setForm={setForm} isSubmitting={isSubmitting} storeOpen={storeOpen} onBreak={onBreak} soldOut={soldOut} onClose={() => setCheckoutOpen(false)} onSubmit={checkout} />}
      </AnimatePresence>
    </MotionConfig>
  );
}

function ProductCard({ product, onAdd, storeOpen, onBreak, soldOut }) {
  const [extraIds, setExtraIds] = useState([]);
  const [sauce, setSauce] = useState(DEFAULT_SAUCE);
  const selectedExtras = extras.filter((extra) => extraIds.includes(extra.id));
  const total = product.price + selectedExtras.reduce((sum, extra) => sum + extra.price, 0);

  function toggleExtra(id) { setExtraIds((selected) => selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]); }

  return <motion.article className="product-card reveal" whileHover={{ y: -6, boxShadow: "0 18px 34px rgba(33,21,20,.14)" }}>
    <div className="food-art"><img src={product.photo} alt={product.name} />{product.tag ? <p>{product.tag}</p> : null}</div>
    <div className="product-content"><div className="product-top"><h3>{product.name}</h3><strong>{formatPrice(product.price)}</strong></div><p>{product.description}</p>
      <fieldset><legend>¿Cómo quieres el pollo?</legend>{SAUCE_CHOICES.map((choice) => <label className="extra" key={choice}><input type="radio" name={`sauce-${product.id}`} value={choice} checked={sauce === choice} onChange={() => setSauce(choice)} /><span>{choice}</span></label>)}</fieldset>
      <fieldset><legend>Agrega extras</legend>{extras.map((extra) => <label className="extra" key={extra.id}><input type="checkbox" checked={extraIds.includes(extra.id)} onChange={() => toggleExtra(extra.id)} /><span>{extra.name}</span><b>+ {formatPrice(extra.price)}</b></label>)}</fieldset>
      <motion.button className="add-button" onClick={() => onAdd(product, selectedExtras, sauce)} disabled={!storeOpen} whileTap={storeOpen ? { scale: 0.97 } : undefined}>{storeOpen ? <>Agregar · {formatPrice(total)} <span>+</span></> : soldOut ? "Agotado por hoy" : onBreak ? `Volvemos el ${REOPEN_LABEL}` : "Cerrado por ahora"}</motion.button>
    </div>
  </motion.article>;
}

function Cart({ cart, total, onClose, onQuantity, onCheckout }) {
  return <motion.div className="overlay" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
    <motion.aside className="cart" role="dialog" aria-modal="true" aria-label="Tu carrito" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={drawerTransition}>
      <div className="drawer-header"><h2>Tu pedido</h2><button onClick={onClose} aria-label="Cerrar carrito">×</button></div>
      {cart.length === 0 ? <div className="empty"><p>Aún no agregas nada.</p><button onClick={() => { onClose(); document.getElementById("menu")?.scrollIntoView(); }}>Ver el menú</button></div> : <><div className="cart-items"><AnimatePresence initial={false}>{cart.map((item) => <motion.div className="cart-item" key={item.key} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ duration: 0.25 }}><div><strong>{item.product}</strong><p>{[item.sauce, ...item.extras.map((extra) => extra.name)].join(" · ")}</p><b>{formatPrice(item.unitPrice * item.quantity)}</b></div><div className="quantity"><motion.button whileTap={{ scale: 0.85 }} onClick={() => onQuantity(item.key, -1)}>−</motion.button><span>{item.quantity}</span><motion.button whileTap={{ scale: 0.85 }} onClick={() => onQuantity(item.key, 1)}>+</motion.button></div></motion.div>)}</AnimatePresence></div><div className="cart-total"><span>Total</span><strong>{formatPrice(total)}</strong></div><motion.button className="primary-button checkout" whileTap={{ scale: 0.97 }} onClick={onCheckout}>Continuar al pago <span>→</span></motion.button></>}
    </motion.aside>
  </motion.div>;
}

function Checkout({ subtotal, deliveryFee, total, form, setForm, isSubmitting, storeOpen, onBreak, soldOut, onClose, onSubmit }) {
  function update(event) { setForm({ ...form, [event.target.name]: event.target.value }); }
  return <motion.div className="overlay" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
    <motion.section className="checkout-modal" role="dialog" aria-modal="true" aria-label="Finalizar pedido" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={drawerTransition}>
      <div className="drawer-header"><h2>Finaliza tu pedido</h2><button onClick={onClose} aria-label="Cerrar">×</button></div>
      <form onSubmit={onSubmit}><label>Nombre<input required maxLength={100} name="name" value={form.name} onChange={update} placeholder="Tu nombre" /></label><label>Teléfono<input required maxLength={30} type="tel" name="phone" value={form.phone} onChange={update} placeholder="+56 9 ..." /></label><label>Comuna<select name="comuna" value={form.comuna} onChange={update}>{COMUNAS.map((comuna) => <option key={comuna}>{comuna}</option>)}</select><small>Solo hacemos despacho a Puente Alto, San Bernardo, El Bosque y La Pintana.</small></label><label>Dirección<input required maxLength={200} name="address" value={form.address} onChange={update} placeholder="Calle, número y depto/casa" /></label><div className="payment-box">{storeOpen ? <><span>Método de pago</span><strong>Pago online seguro con Mercado Pago</strong><small>Te redirigiremos para completar el pago.</small></> : soldOut ? <><span>Agotado por hoy</span><strong>Se nos acabó el stock</strong><small>Gracias por preferirnos. Te esperamos en el próximo servicio.</small></> : onBreak ? <><span>Este fin de semana no hay venta</span><strong>Volvemos el {REOPEN_LABEL}</strong><small>Disculpa las molestias. Te esperamos ese día de 12:00 a 17:00 hrs.</small></> : <><span>Estamos cerrados</span><strong>Solo recibimos pedidos sábado y domingo</strong><small>De 12:00 a 17:00 hrs. Vuelve a intentarlo en ese horario.</small></>}</div><div className="checkout-subtotal"><span>Subtotal</span><span>{formatPrice(subtotal)}</span></div><div className="checkout-subtotal"><span>Despacho</span><span>{formatPrice(deliveryFee)}</span></div><div className="checkout-total"><span>Total del pedido</span><strong>{formatPrice(total)}</strong></div><motion.button className="primary-button checkout" type="submit" disabled={isSubmitting || !storeOpen} whileTap={!isSubmitting && storeOpen ? { scale: 0.97 } : undefined}>{isSubmitting ? "Abriendo pago..." : "Ir a pagar"} <span>→</span></motion.button><p className="secure-note">No almacenamos datos de tu tarjeta.</p></form>
    </motion.section>
  </motion.div>;
}

export default App;
