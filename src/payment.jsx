import { createRoot } from "react-dom/client";
import "./payment.css";

const result = new URLSearchParams(window.location.search).get("result");
const content = {
  success: ["¡Pago enviado!", "Estamos verificando tu pago y confirmaremos el pedido apenas esté aprobado."],
  pending: ["Tu pago está pendiente.", "Cuando Mercado Pago confirme el pago, prepararemos tu pedido."],
  failure: ["No se pudo completar el pago.", "Puedes volver a la tienda e intentarlo nuevamente."],
}[result] ?? ["Gracias por tu pedido.", "Puedes volver a la tienda cuando quieras."];

createRoot(document.getElementById("root")).render(
  <main>
    <section>
      <a href="/" className="brand"><strong>bapbap</strong></a>
      <p className="eyebrow">PEDIDO RECIBIDO</p>
      <h1>{content[0]}</h1>
      <p>{content[1]}</p>
      <a className="button" href="/">Volver a la tienda</a>
    </section>
  </main>,
);
