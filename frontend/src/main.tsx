import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./glitch.css";
import "./site.css";
import App from "./App.js";
import Landing from "./Landing.js";
import Status from "./Status.js";
import { trackView } from "./track.js";

/**
 * One origin, three pages. The owner passkey belongs to this origin, so the
 * public pages and the owner console have to be served from the same place.
 */
function Page() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/panel") {
    trackView("/panel");
    return <App />;
  }
  if (path === "/status") return <Status />;
  return <Landing />;
}

const root = createRoot(document.getElementById("root")!);
root.render(<Page />);
