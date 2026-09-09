import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The sandbox worker must be bundled as a real ES module worker.
  worker: {
    format: "es",
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
