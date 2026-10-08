import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installErrorReporting } from "./diagnostics.js";
import "./style.css";

const removeErrorReporting = installErrorReporting();
if (import.meta.hot) import.meta.hot.dispose(removeErrorReporting);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
