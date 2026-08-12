import { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

const products = [
  {
    id: "individual",
    name: "Porción individual",
    description: "Pollo coreano crocante con arroz recién preparado.",
    price: 6990,
    tag: "Para una persona",
    photo: "/photos/pollo-individual.jpg",
  },
  {
    id: "share",
    name: "Para compartir",
    description: "Doble porción de pollo coreano con arroz para dos.",
    price: 11990,
    tag: "Para dos personas",
    photo: "/photos/pollo-compartir.jpg",
  },
];

const DEFAULT_SAUCE = "Yangnyeom";

const extras = [
  { id: "rice", name: "Arroz extra", price: 2000 },
  { id: "sauce", name: "Salsa extra", price: 1500 },
];

const DELIVERY_FEE = 2990;
const COMUNAS = ["Puente Alto", "San Bernardo", "El Bosque", "La Pintana"];
const OPEN_DAYS = ["Sat", "Sun"];
const OPEN_HOUR = 12;
const CLOSE_HOUR = 20;

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
  // TEMP: prueba de pago real fuera de horario, revertir después
  if (true) return true;
  const { weekday, hour } = getSantiagoParts(date);
  return OPEN_DAYS.includes(weekday) && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

function useStoreOpen() {
  const [open, setOpen] = useState(() => isStoreOpen());
  useEffect(() => {
    const id = setInterval(() => setOpen(isStoreOpen()), 30000);
    return () => clearInterval(id);
  }, []);
  return open;
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
  const storeOpen = useStoreOpen();
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

  function addProduct(product, selectedExtras) {
    const extrasTotal = selectedExtras.reduce((sum, extra) => sum + extra.price, 0);
    const key = `${product.id}-${selectedExtras.map((extra) => extra.id).join("-")}`;
    const item = {
      key,
      product: product.name,
      sauce: DEFAULT_SAUCE,
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
      alert("Estamos cerrados. Solo recibimos pedidos sábado y domingo de 12:00 a 20:00 hrs.");
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
    <>
      <header className="site-header">
        <a className="brand" href="#inicio" aria-label="bapbap, inicio">
          <img src="/logo-horizontal.svg" alt="bapbap" />
        </a>
        <nav aria-label="Navegación principal"><a href="#menu">Menú</a><a href="#como-pedir">Cómo pedir</a></nav>
        <button className="cart-button" onClick={() => setCartOpen(true)} aria-label="Abrir carrito">
          Carrito <span>{cartCount}</span>
        </button>
      </header>

      <main>
        <section className="hero" id="inicio">
          <div className="hero-copy">
            <img className="hero-logo" src="/logo-featured.svg" alt="bapbap" />
            <p className="eyebrow">POLLO COREANO EN PUENTE ALTO</p>
            <h1>Crujiente por fuera.<br /><em>Inolvidable</em> por dentro.</h1>
            <p>Pollo frito coreano bañado en salsa, servido con arroz recién preparado.</p>
            <a className="primary-button" href="#menu">Pide ahora <span>↓</span></a>
          </div>
          <div className="hero-image">
            <img src="/photos/pollo-hero.jpg" alt="Pollo coreano con arroz" />
          </div>
        </section>

        <section className="promise"><span>{storeOpen ? "ABIERTO AHORA" : "CERRADO"} · SÁB Y DOM 12:00-20:00 HRS</span><b>✦</b><span>HECHO AL MOMENTO</span><b>✦</b><span>ARROZ INCLUIDO</span><b>✦</b><span>PAGO ONLINE SEGURO</span></section>

        <section className="menu-section" id="menu">
          <div className="section-title reveal"><p className="eyebrow">MENÚ</p><h2>Tu antojo comienza aquí.</h2><p>Elige una porción, personalízala y agrégala al carrito.</p></div>
          <div className="product-grid">
            {products.map((product) => <ProductCard key={product.id} product={product} onAdd={addProduct} storeOpen={storeOpen} />)}
          </div>
        </section>

        <section className="steps" id="como-pedir">
          <div className="reveal"><p className="eyebrow">ASÍ DE SIMPLE</p><h2>Pedir es fácil.</h2></div>
          <ol><li className="reveal"><span>01</span><strong>Elige tu pollo</strong><p>Agrega los extras que quieras.</p></li><li className="reveal"><span>02</span><strong>Revisa tu carrito</strong><p>Completa los datos de entrega.</p></li><li className="reveal"><span>03</span><strong>Paga online</strong><p>Confirma tu pedido de forma segura.</p></li></ol>
        </section>
      </main>

      <footer><p>Pollo coreano</p><a className="brand" href="#inicio" aria-label="bapbap, inicio"><img src="/logo-footer.svg" alt="bapbap" /></a><a href="https://www.instagram.com/bapbap.cl?igsh=MTRocjYzY2NydWZhdA==" target="_blank" rel="noreferrer">Instagram ↗</a></footer>

      <button className="mobile-cart" onClick={() => setCartOpen(true)}><span>Tu pedido ({cartCount})</span><strong>{formatPrice(cartTotal)}</strong></button>

      {cartOpen && <Cart cart={cart} total={cartTotal} onClose={() => setCartOpen(false)} onQuantity={changeQuantity} onCheckout={() => { setCartOpen(false); setCheckoutOpen(true); }} />}
      {checkoutOpen && <Checkout subtotal={cartTotal} deliveryFee={deliveryFee} total={orderTotal} form={form} setForm={setForm} isSubmitting={isSubmitting} storeOpen={storeOpen} onClose={() => setCheckoutOpen(false)} onSubmit={checkout} />}
    </>
  );
}

function ProductCard({ product, onAdd, storeOpen }) {
  const [extraIds, setExtraIds] = useState([]);
  const selectedExtras = extras.filter((extra) => extraIds.includes(extra.id));
  const total = product.price + selectedExtras.reduce((sum, extra) => sum + extra.price, 0);

  function toggleExtra(id) { setExtraIds((selected) => selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]); }

  return <article className="product-card reveal">
    <div className="food-art"><img src={product.photo} alt={product.name} /><p>{product.tag}</p></div>
    <div className="product-content"><div className="product-top"><h3>{product.name}</h3><strong>{formatPrice(product.price)}</strong></div><p>{product.description}</p>
      <fieldset><legend>Agrega extras</legend>{extras.map((extra) => <label className="extra" key={extra.id}><input type="checkbox" checked={extraIds.includes(extra.id)} onChange={() => toggleExtra(extra.id)} /><span>{extra.name}</span><b>+ {formatPrice(extra.price)}</b></label>)}</fieldset>
      <button className="add-button" onClick={() => onAdd(product, selectedExtras)} disabled={!storeOpen}>{storeOpen ? <>Agregar · {formatPrice(total)} <span>+</span></> : "Cerrado por ahora"}</button>
    </div>
  </article>;
}

function Cart({ cart, total, onClose, onQuantity, onCheckout }) {
  return <div className="overlay" role="presentation"><aside className="cart" role="dialog" aria-modal="true" aria-label="Tu carrito"><div className="drawer-header"><h2>Tu pedido</h2><button onClick={onClose} aria-label="Cerrar carrito">×</button></div>{cart.length === 0 ? <div className="empty"><p>Aún no agregas nada.</p><button onClick={onClose}>Ver el menú</button></div> : <><div className="cart-items">{cart.map((item) => <div className="cart-item" key={item.key}><div><strong>{item.product}</strong><p>{item.sauce}{item.extras.length ? ` · ${item.extras.map((extra) => extra.name).join(", ")}` : ""}</p><b>{formatPrice(item.unitPrice * item.quantity)}</b></div><div className="quantity"><button onClick={() => onQuantity(item.key, -1)}>−</button><span>{item.quantity}</span><button onClick={() => onQuantity(item.key, 1)}>+</button></div></div>)}</div><div className="cart-total"><span>Total</span><strong>{formatPrice(total)}</strong></div><button className="primary-button checkout" onClick={onCheckout}>Continuar al pago <span>→</span></button></>}</aside></div>;
}

function Checkout({ subtotal, deliveryFee, total, form, setForm, isSubmitting, storeOpen, onClose, onSubmit }) {
  function update(event) { setForm({ ...form, [event.target.name]: event.target.value }); }
  return <div className="overlay" role="presentation"><section className="checkout-modal" role="dialog" aria-modal="true" aria-label="Finalizar pedido"><div className="drawer-header"><h2>Finaliza tu pedido</h2><button onClick={onClose} aria-label="Cerrar">×</button></div><form onSubmit={onSubmit}><label>Nombre<input required maxLength={100} name="name" value={form.name} onChange={update} placeholder="Tu nombre" /></label><label>Teléfono<input required maxLength={30} type="tel" name="phone" value={form.phone} onChange={update} placeholder="+56 9 ..." /></label><label>Comuna<select name="comuna" value={form.comuna} onChange={update}>{COMUNAS.map((comuna) => <option key={comuna}>{comuna}</option>)}</select><small>Solo hacemos despacho a Puente Alto, San Bernardo, El Bosque y La Pintana.</small></label><label>Dirección<input required maxLength={200} name="address" value={form.address} onChange={update} placeholder="Calle, número y depto/casa" /></label><div className="payment-box">{storeOpen ? <><span>Método de pago</span><strong>Pago online seguro con Mercado Pago</strong><small>Te redirigiremos para completar el pago.</small></> : <><span>Estamos cerrados</span><strong>Solo recibimos pedidos sábado y domingo</strong><small>De 12:00 a 20:00 hrs. Vuelve a intentarlo en ese horario.</small></>}</div><div className="checkout-subtotal"><span>Subtotal</span><span>{formatPrice(subtotal)}</span></div><div className="checkout-subtotal"><span>Despacho</span><span>{formatPrice(deliveryFee)}</span></div><div className="checkout-total"><span>Total del pedido</span><strong>{formatPrice(total)}</strong></div><button className="primary-button checkout" type="submit" disabled={isSubmitting || !storeOpen}>{isSubmitting ? "Abriendo pago..." : "Ir a pagar"} <span>→</span></button><p className="secure-note">No almacenamos datos de tu tarjeta.</p></form></section></div>;
}

export default App;
