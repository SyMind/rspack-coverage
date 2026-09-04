import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { App } from "./App.js";
import "./styles.css";
import "./workbench-theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("Rspack Coverage UI root is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
