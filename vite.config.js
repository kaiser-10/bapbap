import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        store: "index.html",
        admin: "admin.html",
        payment: "payment.html",
        // Vista previa del rediseño. No la enlaza nadie: se entra a /nuevo a mano.
        nuevo: "nuevo.html",
      },
    },
  },
});
