import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles/tokens.css";
import "./styles/layout.css";
import { applyDocumentTheme, resolveTheme, useThemeStore } from "./state/themeStore";

applyDocumentTheme(resolveTheme(useThemeStore.getState().preference));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
