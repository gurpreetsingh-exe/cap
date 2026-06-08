import { initSrtUi } from "./ui.js";

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSrtUi);
  } else {
    initSrtUi();
  }
}
