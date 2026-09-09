import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./nuevo.css";

// Vista previa de diseño: los datos van fijos y el carrito no opera. La idea es
// mirar cómo se ve, no cambiar la tienda. Si el diseño se aprueba, se lleva a
// App.jsx y esta página se borra.

const products = [
  { id: "media", name: "Media porción", description: "Pollo coreano crocante con una pequeña porción de nabo.", price: 11990, photo: "/photos/pollo-individual.jpg", hasSauce: true },
  { id: "porcion", name: "Porción (2 a 3 personas)", description: "El doble de pollo coreano crocante, con una pequeña porción de nabo.", price: 19990, photo: "/photos/pollo-compartir.jpg", hasSauce: true },
  { id: "bibimbap", name: "Bibimbap", description: "Arroz con carne salteada, vegetales frescos, huevo frito y sésamo.", price: 8990, photo: "/photos/bibimbap.jpg", hasSauce: false },
  { id: "coca-cola", name: "Coca-Cola en lata", description: "350 ml, bien fría.", price: 1500, photo: "/photos/coca-cola.jpg", hasSauce: false },
  { id: "arroz", name: "Porción de arroz", description: "Arroz blanco recién preparado, para acompañar cualquier porción.", price: 2000, photo: "/photos/arroz.jpg", hasSauce: false },
];

const SAUCES = ["Con salsa", "Sin salsa", "Salsa aparte"];

const COMUNA_GROUPS = [
  { fee: 2990, comunas: ["Puente Alto", "San Bernardo", "El Bosque", "La Pintana"] },
  { fee: 4490, comunas: ["La Florida", "La Granja", "San Ramón", "La Cisterna"] },
];

const TICKER = ["RESERVA CUALQUIER DÍA", "VIE 17—20", "SÁB 12—20", "DOM 12—17", "HECHO AL MOMENTO", "NABO INCLUIDO", "DESPACHO DESDE $2.990"];

const pesos = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const formatPrice = (price) => pesos.format(price);

function Card({ product, wide }) {
  const [sauce, setSauce] = useState(product.hasSauce ? SAUCES[0] : null);
  return <article className={wide ? "card card-wide" : "card"}>
    <div className="card-photo">
      <img src={product.photo} alt={product.name} />
      <span className="price-stamp">{formatPrice(product.price)}</span>
    </div>
    <div className="card-body">
      <h3>{product.name}</h3>
      <p>{product.description}</p>
      {product.hasSauce ? <div className="sauces">{SAUCES.map((choice) => <button key={choice} className={sauce === choice ? "on" : ""} onClick={() => setSauce(choice)}>{choice}</button>)}</div> : null}
      <button className="card-add">Agregar <span>+</span></button>
    </div>
  </article>;
}

function Nuevo() {
  return <>
    <div className="grain" aria-hidden="true" />
    <a className="preview-flag" href="/">Vista previa · volver al sitio real</a>

    <header className="site-header shell">
      <img src="/logo-horizontal.svg" alt="bapbap" />
      <nav><a href="#menu">Menú</a><a href="#cobertura">Cobertura</a><a href="#pasos">Cómo pedir</a></nav>
      <button className="cart-pill">Carrito <span>0</span></button>
    </header>

    <section className="hero">
      <div className="hero-photo"><img src="/photos/pollo-hero.jpg" alt="Pollo coreano crocante bañado en salsa" /></div>
      <div className="hero-copy shell">
        <p className="hero-eyebrow">POLLO COREANO EN PUENTE ALTO</p>
        <h1>Crujiente por fuera.<br /><em>Inolvidable</em> por dentro.</h1>
        <p className="hero-sub">Pollo frito coreano bañado en salsa, servido con una pequeña porción de nabo. Reserva cualquier día y elige cuándo lo quieres.</p>
        <a className="hero-cta" href="#menu">Ver el menú <span>↓</span></a>
      </div>
    </section>

    {/* Dos copias idénticas: la pista se corre un ancho exacto y el loop no salta. */}
    <div className="ticker">
      <div className="ticker-track">
        {[0, 1].map((copy) => <div className="ticker-set" key={copy} aria-hidden={copy === 1}>
          {TICKER.map((text) => <span key={text}>{text}<b aria-hidden="true">✦</b></span>)}
        </div>)}
      </div>
    </div>

    <section className="menu shell" id="menu">
      <div className="section-head">
        <span className="section-tag">MENÚ</span>
        <h2>Tu antojo comienza aquí.</h2>
        <p>Elige una porción, dinos cómo la quieres y agrégala al carrito.</p>
      </div>
      <div className="menu-grid">
        {products.map((product, index) => <Card key={product.id} product={product} wide={index === products.length - 1} />)}
      </div>
    </section>

    <section className="coverage shell" id="cobertura">
      <span className="coverage-mark" aria-hidden="true">배달</span>
      <div className="section-head">
        <span className="section-tag">COBERTURA</span>
        <h2>¿Llegamos a tu comuna?</h2>
      </div>
      <div className="coverage-grid">
        {COMUNA_GROUPS.map((group) => <div className="tier" key={group.fee}>
          <strong>{formatPrice(group.fee)}</strong>
          <small>DESPACHO</small>
          <p>{group.comunas.join(" · ")}</p>
        </div>)}
      </div>
    </section>

    <section className="steps shell" id="pasos">
      <div className="section-head">
        <span className="section-tag">ASÍ DE SIMPLE</span>
        <h2>Pedir es fácil.</h2>
      </div>
      <div className="steps-grid">
        <div className="step"><b>01</b><strong>Arma tu pedido</strong><p>Suma bibimbap, arroz o bebida si quieres.</p></div>
        <div className="step"><b>02</b><strong>Elige el día</strong><p>Viernes, sábado o domingo, y tus datos de entrega.</p></div>
        <div className="step"><b>03</b><strong>Paga online</strong><p>Con Mercado Pago, débito o crédito.</p></div>
      </div>
    </section>

    <footer className="site-footer shell">
      <img src="/logo-footer.svg" alt="bapbap" />
      <p>Pollo coreano · Puente Alto</p>
      <a href="https://www.instagram.com/bapbap.cl?igsh=MTRocjYzY2NydWZhdA==" target="_blank" rel="noreferrer">Instagram ↗</a>
    </footer>
  </>;
}

createRoot(document.getElementById("root")).render(<Nuevo />);
