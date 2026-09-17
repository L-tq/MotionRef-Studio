import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
// Studio Link: connects to the local studio server when the app is served by
// one (local deployment mode); dormant in the browser-only deployment.
import "./state/studioLink";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
