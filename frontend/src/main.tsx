import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/press-start-2p";
import App from "./App.js";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
