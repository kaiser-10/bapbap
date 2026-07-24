import { useMemo, useState } from "react";
import { supabase } from "./lib/supabase";

const products = [
  {
    id: "individual",
    name: "Porción individual",
    description: "Pollo coreano crocante con arroz recién preparado.",
    price: 6990,
    tag: "Para una persona",
  },
  {
    id: "share",
    name: "Para compartir",
    description: "Doble porción de pollo coreano con arroz para dos.",
    price: 11990,
    tag: "Para dos personas",
  },
];

const sauces = [
  { id: "yangnyeom", name: "Yangnyeom", detail: "Dulce y picante" },
  { id: "garlic", name: "Soya ajo", detail: "Sabrosa y suave" },
  { id: "plain", name: "Sin salsa", detail: "Extra crocante" },
];

const extras = [
  { id: "kimchi", name: "Kimchi casero", price: 1500 },
  { id: "drink", name: "Bebida lata", price: 1800 },
];

const pesos = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

function formatPrice(price) {
  return pesos.format(price);
}

function App() {
  const [cart, setCart] = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", delivery: "Retiro", address: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [cart],
  );
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  function addProduct(product, sauce, selectedExtras) {
    const extrasTotal = selectedExtras.reduce((sum, extra) => sum + extra.price, 0);
    const key = `${product.id}-${sauce.id}-${selectedExtras.map((extra) => extra.id).join("-")}`;
    const item = {
      key,
      product: product.name,
      sauce: sauce.name,
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
    if (!supabase) {
      alert("Falta configurar la conexión con la base de datos.");
      return;
    }

    setIsSubmitting(true);
    const { data, error } = await supabase.functions.invoke("create-payment", {
      body: {
        customer: { name: form.name, phone: form.phone, delivery: form.delivery, address: form.address },
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
    <>
      <header className="site-header">
        <a className="brand" href="#inicio" aria-label="bapbap, inicio">
          <strong>bapbap</strong>
        </a>
        <nav aria-label="Navegación principal"><a href="#menu">Menú</a><a href="#como-pedir">Cómo pedir</a></nav>
        <button className="cart-button" onClick={() => setCartOpen(true)} aria-label="Abrir carrito">
          Carrito <span>{cartCount}</span>
        </button>
      </header>

      <main>
        <section className="hero" id="inicio">
          <div className="hero-copy">
            <p className="eyebrow">POLLO COREANO EN PUENTE ALTO</p>
            <h1>Crujiente por fuera.<br /><em>Inolvidable</em> por dentro.</h1>
            <p>Pollo frito coreano bañado en salsa, servido con arroz recién preparado.</p>
            <a className="primary-button" href="#menu">Pide ahora <span>↓</span></a>
          </div>
          <div className="hero-image" aria-label="Pollo coreano con arroz">
            <div className="sun" /><div className="plate"><div className="rice" /><i /><i /><i /></div>
            <span className="spark one">✦</span><span className="spark two">✦</span>
            <b>POLLO<br />COREANO</b>
          </div>
        </section>

        <section className="promise"><span>HECHO AL MOMENTO</span><b>✦</b><span>ARROZ INCLUIDO</span><b>✦</b><span>PAGO ONLINE SEGURO</span></section>

        <section className="menu-section" id="menu">
          <div className="section-title"><p className="eyebrow">MENÚ</p><h2>Tu antojo comienza aquí.</h2><p>Elige una porción, personalízala y agrégala al carrito.</p></div>
          <div className="product-grid">
            {products.map((product) => <ProductCard key={product.id} product={product} onAdd={addProduct} />)}
          </div>
        </section>

        <section className="steps" id="como-pedir">
          <div><p className="eyebrow">ASÍ DE SIMPLE</p><h2>Pedir es fácil.</h2></div>
          <ol><li><span>01</span><strong>Elige tu pollo</strong><p>Personaliza tu salsa y extras.</p></li><li><span>02</span><strong>Revisa tu carrito</strong><p>Completa los datos de entrega o retiro.</p></li><li><span>03</span><strong>Paga online</strong><p>Confirma tu pedido de forma segura.</p></li></ol>
        </section>
      </main>

      <footer><a className="brand" href="#inicio"><strong>bapbap</strong></a><p>Pollo coreano con arroz.</p><a href="https://www.instagram.com/bapbap.cl?igsh=MTRocjYzY2NydWZhdA==" target="_blank" rel="noreferrer">Instagram ↗</a></footer>

      <button className="mobile-cart" onClick={() => setCartOpen(true)}><span>Tu pedido ({cartCount})</span><strong>{formatPrice(cartTotal)}</strong></button>

      {cartOpen && <Cart cart={cart} total={cartTotal} onClose={() => setCartOpen(false)} onQuantity={changeQuantity} onCheckout={() => { setCartOpen(false); setCheckoutOpen(true); }} />}
      {checkoutOpen && <Checkout total={cartTotal} form={form} setForm={setForm} isSubmitting={isSubmitting} onClose={() => setCheckoutOpen(false)} onSubmit={checkout} />}
    </>
  );
}

function ProductCard({ product, onAdd }) {
  const [sauceId, setSauceId] = useState(sauces[0].id);
  const [extraIds, setExtraIds] = useState([]);
  const sauce = sauces.find((item) => item.id === sauceId);
  const selectedExtras = extras.filter((extra) => extraIds.includes(extra.id));
  const total = product.price + selectedExtras.reduce((sum, extra) => sum + extra.price, 0);

  function toggleExtra(id) { setExtraIds((selected) => selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]); }

  return <article className="product-card">
    <div className="food-art"><div className="bowl"><span /><i /><i /></div><p>{product.tag}</p></div>
    <div className="product-content"><div className="product-top"><h3>{product.name}</h3><strong>{formatPrice(product.price)}</strong></div><p>{product.description}</p>
      <fieldset><legend>Elige tu salsa</legend><div className="sauce-list">{sauces.map((item) => <label key={item.id} className={sauceId === item.id ? "selected" : ""}><input type="radio" name={`sauce-${product.id}`} checked={sauceId === item.id} onChange={() => setSauceId(item.id)} /><span>{item.name}<small>{item.detail}</small></span></label>)}</div></fieldset>
      <fieldset><legend>Agrega extras</legend>{extras.map((extra) => <label className="extra" key={extra.id}><input type="checkbox" checked={extraIds.includes(extra.id)} onChange={() => toggleExtra(extra.id)} /><span>{extra.name}</span><b>+ {formatPrice(extra.price)}</b></label>)}</fieldset>
      <button className="add-button" onClick={() => onAdd(product, sauce, selectedExtras)}>Agregar · {formatPrice(total)} <span>+</span></button>
    </div>
  </article>;
}

function Cart({ cart, total, onClose, onQuantity, onCheckout }) {
  return <div className="overlay" role="presentation"><aside className="cart" role="dialog" aria-modal="true" aria-label="Tu carrito"><div className="drawer-header"><h2>Tu pedido</h2><button onClick={onClose} aria-label="Cerrar carrito">×</button></div>{cart.length === 0 ? <div className="empty"><p>Aún no agregas nada.</p><button onClick={onClose}>Ver el menú</button></div> : <><div className="cart-items">{cart.map((item) => <div className="cart-item" key={item.key}><div><strong>{item.product}</strong><p>{item.sauce}{item.extras.length ? ` · ${item.extras.map((extra) => extra.name).join(", ")}` : ""}</p><b>{formatPrice(item.unitPrice * item.quantity)}</b></div><div className="quantity"><button onClick={() => onQuantity(item.key, -1)}>−</button><span>{item.quantity}</span><button onClick={() => onQuantity(item.key, 1)}>+</button></div></div>)}</div><div className="cart-total"><span>Total</span><strong>{formatPrice(total)}</strong></div><button className="primary-button checkout" onClick={onCheckout}>Continuar al pago <span>→</span></button></>}</aside></div>;
}

function Checkout({ total, form, setForm, isSubmitting, onClose, onSubmit }) {
  function update(event) { setForm({ ...form, [event.target.name]: event.target.value }); }
  return <div className="overlay" role="presentation"><section className="checkout-modal" role="dialog" aria-modal="true" aria-label="Finalizar pedido"><div className="drawer-header"><h2>Finaliza tu pedido</h2><button onClick={onClose} aria-label="Cerrar">×</button></div><form onSubmit={onSubmit}><label>Nombre<input required name="name" value={form.name} onChange={update} placeholder="Tu nombre" /></label><label>Teléfono<input required type="tel" name="phone" value={form.phone} onChange={update} placeholder="+56 9 ..." /></label><label>¿Cómo recibes tu pedido?<select name="delivery" value={form.delivery} onChange={update}><option>Retiro</option><option>Delivery</option></select></label>{form.delivery === "Delivery" && <label>Dirección<input required name="address" value={form.address} onChange={update} placeholder="Calle, número y comuna" /></label>}<div className="payment-box"><span>Método de pago</span><strong>Pago online seguro con Mercado Pago</strong><small>Te redirigiremos para completar el pago.</small></div><div className="checkout-total"><span>Total del pedido</span><strong>{formatPrice(total)}</strong></div><button className="primary-button checkout" type="submit" disabled={isSubmitting}>{isSubmitting ? "Abriendo pago..." : "Ir a pagar"} <span>→</span></button><p className="secure-note">No almacenamos datos de tu tarjeta.</p></form></section></div>;
}

export default App;
