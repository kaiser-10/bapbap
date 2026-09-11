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
    id: "kimbap",
    name: "Kimbap",
    description: "Rollo de arroz con pastel de pescado, huevo, zanahoria y espinaca, envuelto en alga y cortado en rodajas.",
    price: 4990,
    photo: "/photos/kimbap.jpg",
    hasSauce: false,
  },
  {
    id: "kimari",
    name: "Kimari",
    description: "Rollo de alga relleno de fideo y verduras, frito hasta quedar crocante.",
    price: 5990,
    photo: "/photos/kimari.jpg",
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

// Horario de atención. Debe coincidir con BLOCKS en create-payment.
const BLOCKS = [
  { weekday: "Fri", label: "Viernes", openHour: 17, closeHour: 20 },
  { weekday: "Sat", label: "Sábado", openHour: 12, closeHour: 20 },
  { weekday: "Sun", label: "Domingo", openHour: 12, closeHour: 17 },
];
// Cada día se parte en ventanas de entrega de este largo, que es lo que el
// cliente elige al preordenar. Debe coincidir con SLOT_HOURS en create-payment
// y con las filas sembradas en la tabla slot_limits.
const SLOT_HOURS = 2;
// Lo que se le promete a quien pide al momento. Debe coincidir con create-payment.
const ASAP_MIN = 30;
const ASAP_MAX = 40;
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Frases de la marquesina. Sin horarios: esos viven en la sección de reserva.
const TICKER = ["PIDE AHORA O PREORDENA", "HECHO AL MOMENTO", "NABO INCLUIDO", "DESPACHO DESDE $2.990"];

// Pausa puntual: no se ofrece ningún bloque anterior a esta fecha (formato
// YYYY-MM-DD, hora de Santiago). Al llegar el día, vuelve solo; no hay que
// tocar nada. Para reabrir antes, poner una fecha pasada. Debe coincidir con
// create-payment.
const REOPEN_DATE = "2026-08-22";
const REOPEN_LABEL = "sábado 22 de agosto";

// La tienda puede quedarse sin ventanas por dos motivos distintos: la pausa
// puntual de arriba, o que se hayan llenado todas. Solo en el primer caso se
// sabe cuándo se vuelve; prometer una fecha en el segundo sería mentir, y
// anunciar una fecha ya pasada deja el sitio con cara de abandonado.
function pauseActive(now = getSantiagoNow()) {
  return REOPEN_DATE > now.date;
}

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

// La última ventana del día se recorta al cierre, así nunca se ofrece una hora
// en la que ya no hay nadie: el viernes cierra con 19-20 y el domingo con 16-17.
function blockSlots(block) {
  const slots = [];
  for (let start = block.openHour; start < block.closeHour; start += SLOT_HOURS) {
    slots.push({ startHour: start, endHour: Math.min(start + SLOT_HOURS, block.closeHour) });
  }
  return slots;
}

function nextOccurrence(block, now) {
  const diff = (WEEKDAY_INDEX[block.weekday] - WEEKDAY_INDEX[now.weekday] + 7) % 7;
  const alreadyClosed = diff === 0 && now.hour >= block.closeHour;
  return addDays(now.date, alreadyClosed ? 7 : diff);
}

// Ventanas que todavía se pueden preordenar. De hoy solo quedan las que aún no
// empiezan: para la que está en curso existe el pedido al momento.
function getUpcomingSlots(now = getSantiagoNow()) {
  return BLOCKS.flatMap((block) => {
    const date = nextOccurrence(block, now);
    return blockSlots(block).map((slot) => ({ ...slot, weekday: block.weekday, label: block.label, date }));
  })
    .filter((slot) => slot.date >= REOPEN_DATE)
    .filter((slot) => slot.date > now.date || slot.startHour > now.hour)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour);
}

// La ventana en curso, si la tienda está abierta ahora mismo. Los pedidos al
// momento también ocupan cupo: para la cocina pesan igual que una preorden.
function getLiveSlot(now = getSantiagoNow()) {
  if (now.date < REOPEN_DATE) return null;
  const block = BLOCKS.find((item) => item.weekday === now.weekday && now.hour >= item.openHour && now.hour < item.closeHour);
  if (!block) return null;
  const slot = blockSlots(block).find((item) => now.hour >= item.startHour && now.hour < item.endHour);
  return slot ? { ...slot, weekday: block.weekday, label: block.label, date: now.date } : null;
}

const slotKey = (slot) => `${slot.date}|${slot.startHour}`;

// Disponibilidad: el "agotado" del panel, el tope de cada ventana y cuántos
// cupos van tomados. Todo vive en la base porque tiene que poder cambiar sin
// volver a desplegar. Si algo falla se devuelve vacío y las ventanas quedan sin
// tope: un problema de red nunca debe dejar la tienda cerrada por su cuenta.
async function readAvailability() {
  if (!supabase) return { soldOutDate: null, limits: [], load: [] };
  try {
    const [settings, limits, load] = await Promise.all([
      supabase.from("store_settings").select("sold_out_on").maybeSingle(),
      supabase.from("slot_limits").select("weekday, start_hour, capacity"),
      supabase.rpc("slot_load"),
    ]);
    return {
      soldOutDate: settings.error ? null : settings.data?.sold_out_on ?? null,
      limits: limits.error ? [] : limits.data ?? [],
      load: load.error ? [] : load.data ?? [],
    };
  } catch {
    return { soldOutDate: null, limits: [], load: [] };
  }
}

function useAvailability() {
  const [state, setState] = useState(() => ({ slots: getUpcomingSlots(), live: getLiveSlot() }));

  useEffect(() => {
    let active = true;
    async function refresh() {
      const { soldOutDate, limits, load } = await readAvailability();
      const capacities = new Map(limits.map((row) => [`${row.weekday}|${row.start_hour}`, row.capacity]));
      const taken = new Map(load.map((row) => [`${row.slot_date}|${row.start_hour}`, row.taken]));
      // Sin tope configurado la ventana no limita: preferimos vender a cerrar
      // por una fila que falta.
      const decorate = (slot) => {
        const capacity = capacities.get(`${slot.weekday}|${slot.startHour}`);
        const used = taken.get(slotKey(slot)) ?? 0;
        return { ...slot, full: capacity != null && used >= capacity };
      };

      const now = getSantiagoNow();
      const slots = getUpcomingSlots(now).filter((slot) => slot.date !== soldOutDate).map(decorate);
      const liveSlot = getLiveSlot(now);
      const live = liveSlot && liveSlot.date !== soldOutDate ? decorate(liveSlot) : null;
      if (active) setState({ slots, live });
    }
    refresh();
    const id = setInterval(refresh, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return state;
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
  const { slots, live } = useAvailability();
  // "Ahora" solo si estamos abiertos y la ventana en curso no se llenó.
  const liveOpen = Boolean(live && !live.full);
  const openSlots = useMemo(() => slots.filter((slot) => !slot.full), [slots]);
  const canOrder = liveOpen || openSlots.length > 0;
  const [cart, setCart] = useState([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [headerSolid, setHeaderSolid] = useState(false);
  const [form, setForm] = useState({ mode: "", slot: "", name: "", phone: "", comuna: COMUNAS[0], address: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const cartTotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [cart],
  );
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const deliveryFee = COMUNA_FEES[form.comuna] ?? 0;
  const orderTotal = cartTotal + deliveryFee;

  // Elige solo la opción razonable: al momento si estamos abiertos, si no la
  // primera ventana libre. También corrige la elección que dejó de existir
  // (cerró la tienda, se llenó la ventana) sin pisar la que el cliente tomó.
  useEffect(() => {
    setForm((current) => {
      const mode = !current.mode
        ? (liveOpen ? "ahora" : "preorden")
        : (current.mode === "ahora" && !liveOpen && openSlots.length > 0 ? "preorden" : current.mode);
      const slot = openSlots.some((item) => slotKey(item) === current.slot)
        ? current.slot
        : (openSlots[0] ? slotKey(openSlots[0]) : "");
      return mode === current.mode && slot === current.slot ? current : { ...current, mode, slot };
    });
  }, [liveOpen, openSlots]);

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
      alert(pauseActive()
        ? `No hay horarios de entrega disponibles por ahora. Volvemos el ${REOPEN_LABEL}.`
        : "No hay horarios de entrega disponibles por ahora. Vuelve a intentarlo más tarde.");
      return;
    }
    if (!supabase) {
      alert("Falta configurar la conexión con la base de datos.");
      return;
    }

    const chosen = form.mode === "ahora" ? live : openSlots.find((item) => slotKey(item) === form.slot);
    if (!chosen) {
      alert("Esa opción de entrega ya no está disponible. Elige otra, por favor.");
      return;
    }

    setIsSubmitting(true);
    const { data, error } = await supabase.functions.invoke("create-payment", {
      body: {
        customer: { name: form.name, phone: form.phone, comuna: form.comuna, address: form.address },
        order: { mode: form.mode, date: chosen.date, startHour: chosen.startHour },
        items: cart.map((item) => ({
        product: item.product,
        sauce: item.sauce,
        quantity: item.quantity,
      })),
      },
    });
    setIsSubmitting(false);

    if (error || !data?.checkoutUrl) {
      // El servidor explica por qué (ventana llena, día agotado). Sin ese
      // detalle el cliente reintenta lo mismo una y otra vez.
      let message = "No pudimos iniciar el pago. Inténtalo nuevamente.";
      try {
        const payload = await error?.context?.json?.();
        if (payload?.error) message = payload.error;
      } catch {
        // Nos quedamos con el mensaje genérico.
      }
      alert(message);
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
            <p className="hero-sub">Pollo frito coreano bañado en salsa, servido con una pequeña porción de nabo. Pídelo ahora mismo o preordena y elige cuándo te llega.</p>
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
        </div> : <div className="ticker ticker-closed"><span>{pauseActive() ? `SIN CUPOS POR AHORA · VOLVEMOS EL ${REOPEN_LABEL.toUpperCase()}` : "SIN CUPOS POR AHORA · VUELVE A INTENTARLO MÁS TARDE"}</span></div>}

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
            <h2>Ahora o cuando quieras.</h2>
            <p>Si estamos abiertos, te llega en {ASAP_MIN}-{ASAP_MAX} minutos. Si no, preordena cualquier día de la semana y elige la ventana horaria que más te acomode.</p>
          </div>
          <div className="hours-grid">
            {BLOCKS.map((block) => <div className={live?.weekday === block.weekday ? "hour is-open" : "hour"} key={block.weekday}>
              <strong>{block.label}</strong>
              <span>{block.openHour}:00 — {block.closeHour}:00</span>
              {live?.weekday === block.weekday ? <em>Abierto ahora</em> : null}
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
            <div className="step reveal"><b>01</b><strong>Arma tu pedido</strong><p>Suma kimbap, kimari, bibimbap o una bebida si quieres.</p></div>
            <div className="step reveal"><b>02</b><strong>Elige cuándo</strong><p>Al momento si estamos abiertos, o preorden con ventana horaria.</p></div>
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
        {checkoutOpen && <Checkout key="checkout" subtotal={cartTotal} deliveryFee={deliveryFee} total={orderTotal} form={form} setForm={setForm} isSubmitting={isSubmitting} slots={slots} live={live} liveOpen={liveOpen} canOrder={canOrder} onClose={() => setCheckoutOpen(false)} onSubmit={checkout} />}
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

function Checkout({ subtotal, deliveryFee, total, form, setForm, isSubmitting, slots, live, liveOpen, canOrder, onClose, onSubmit }) {
  function update(event) { setForm({ ...form, [event.target.name]: event.target.value }); }
  return <motion.div className="overlay" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
    <motion.section className="checkout-modal" role="dialog" aria-modal="true" aria-label="Finalizar pedido" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={drawerTransition}>
      <div className="drawer-header"><h2>Finaliza tu pedido</h2><button onClick={onClose} aria-label="Cerrar">×</button></div>
      <form onSubmit={onSubmit}><fieldset className="mode-choice"><legend>¿Cuándo lo quieres?</legend><div className="mode-toggle" role="group">
        <button type="button" className={form.mode === "ahora" ? "mode on" : "mode"} aria-pressed={form.mode === "ahora"} disabled={!liveOpen} onClick={() => setForm({ ...form, mode: "ahora" })}>
          <b>⚡ Lo quiero ahora</b>
          <small>{liveOpen ? `Llega en ${ASAP_MIN}-${ASAP_MAX} min aprox.` : live ? "La hora en curso se llenó" : "Solo en horario de atención"}</small>
        </button>
        <button type="button" className={form.mode === "preorden" ? "mode on" : "mode"} aria-pressed={form.mode === "preorden"} disabled={slots.length === 0} onClick={() => setForm({ ...form, mode: "preorden" })}>
          <b>📅 Preorden</b>
          <small>{slots.length === 0 ? "Sin ventanas disponibles" : "Elige día y hora de entrega"}</small>
        </button>
      </div></fieldset>
      {form.mode === "ahora"
        ? <p className="mode-note">Empezamos a prepararlo apenas confirmes el pago. Llega en <strong>{ASAP_MIN}-{ASAP_MAX} minutos</strong> aproximadamente.</p>
        : <label>Ventana de entrega{canOrder ? <select required name="slot" value={form.slot} onChange={update}>{slots.map((slot) => <option key={slotKey(slot)} value={slotKey(slot)} disabled={slot.full}>{slot.label} {formatBlockDate(slot.date)} · {slot.startHour}:00-{slot.endHour}:00{slot.full ? " · agotado" : ""}</option>)}</select> : <select disabled><option>No disponible por ahora</option></select>}<small>Te llega dentro de esa ventana. Puedes pedir hoy para cualquier día del fin de semana.</small></label>}
      <label>Nombre<input required maxLength={100} name="name" value={form.name} onChange={update} placeholder="Tu nombre" /></label><label>Teléfono<input required maxLength={30} type="tel" name="phone" value={form.phone} onChange={update} placeholder="+56 9 ..." /></label><label>Comuna<select name="comuna" value={form.comuna} onChange={update}>{COMUNA_GROUPS.map((group) => <optgroup label={`Despacho ${formatPrice(group.fee)}`} key={group.fee}>{group.comunas.map((comuna) => <option key={comuna}>{comuna}</option>)}</optgroup>)}</select><small>El valor del despacho cambia según la comuna. Solo despachamos a las que aparecen en la lista.</small></label><label>Dirección<input required maxLength={200} name="address" value={form.address} onChange={update} placeholder="Calle, número y depto/casa" /></label><div className="payment-box">{canOrder ? <><span>Método de pago</span><strong>Pago online seguro con Mercado Pago</strong><small>Te redirigiremos para completar el pago.</small></> : <><span>Sin cupos disponibles</span><strong>No estamos recibiendo pedidos por ahora</strong><small>Vuelve a intentarlo más tarde.</small></>}</div><div className="checkout-subtotal"><span>Subtotal</span><span>{formatPrice(subtotal)}</span></div><div className="checkout-subtotal"><span>Despacho</span><span>{formatPrice(deliveryFee)}</span></div><div className="checkout-total"><span>Total del pedido</span><strong>{formatPrice(total)}</strong></div><motion.button className="primary-button checkout" type="submit" disabled={isSubmitting || !canOrder} whileTap={!isSubmitting && canOrder ? { scale: 0.97 } : undefined}>{isSubmitting ? "Abriendo pago..." : "Ir a pagar"} <span>→</span></motion.button><p className="secure-note">No almacenamos datos de tu tarjeta.</p></form>
    </motion.section>
  </motion.div>;
}

export default App;
