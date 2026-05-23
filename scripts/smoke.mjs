// Smoke test: validates manifest.json shape and required files exist.
import fs from "node:fs";
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const must = ["manifest_version","name","version","description"];
for (const k of must) if (!m[k]) { console.error("missing manifest key:", k); process.exit(1); }
if (m.manifest_version !== 3) { console.error("manifest_version must be 3"); process.exit(1); }
for (const p of ["src/popup.html","src/popup.js","src/popup.css","src/background.js","src/content.js","src/anki.js","src/options.html","src/options.js","src/options.css"])
  if (!fs.existsSync(p)) { console.error("missing file:", p); process.exit(1); }
if (!Array.isArray(m.content_scripts) || !m.content_scripts.length) { console.error("manifest content_scripts missing"); process.exit(1); }
const cs0 = m.content_scripts[0];
if (!cs0.js || !cs0.js.includes("src/content.js")) { console.error("content_scripts[0].js must include src/content.js"); process.exit(1); }
if (!cs0.matches || !cs0.matches.length) { console.error("content_scripts[0].matches required"); process.exit(1); }
for (const sz of [16,32,48,128]) if (!fs.existsSync(`icons/icon-${sz}.png`)) { console.error("missing icon:", sz); process.exit(1); }
if (!Array.isArray(m.permissions) || !m.permissions.includes("contextMenus")) { console.error("manifest must declare contextMenus permission"); process.exit(1); }
const bg = fs.readFileSync("src/background.js", "utf8");
if (!bg.includes("contextMenus.create") || !bg.includes("Send to Anki")) { console.error("background.js must register 'Send to Anki' context menu"); process.exit(1); }
if (!bg.includes("contexts: [\"selection\"]") && !bg.includes("contexts:[\"selection\"]")) { console.error("context menu must be scoped to selection context"); process.exit(1); }

// AnkiConnect health-check feature wiring.
const anki = fs.readFileSync("src/anki.js", "utf8");
if (!anki.includes("healthCheck") || !anki.includes("127.0.0.1:8765")) {
  console.error("src/anki.js must export healthCheck targeting 127.0.0.1:8765"); process.exit(1);
}
if (!bg.includes("h2a:anki-health")) { console.error("background.js must handle h2a:anki-health message"); process.exit(1); }
const popupHtml = fs.readFileSync("src/popup.html", "utf8");
if (!popupHtml.includes("health-pill") || !popupHtml.includes("AnkiConnect")) {
  console.error("popup.html must render an AnkiConnect health pill"); process.exit(1);
}
const popupJs = fs.readFileSync("src/popup.js", "utf8");
if (!popupJs.includes("h2a:anki-health")) { console.error("popup.js must request AnkiConnect health from the service worker"); process.exit(1); }
if (!m.options_ui || m.options_ui.page !== "src/options.html") { console.error("manifest must declare options_ui.page = src/options.html"); process.exit(1); }
if (!anki.includes("deckNames") || !anki.includes("modelNames")) { console.error("src/anki.js must export deckNames and modelNames"); process.exit(1); }
if (!bg.includes("h2a:list-decks") || !bg.includes("h2a:list-models")) { console.error("background.js must handle h2a:list-decks and h2a:list-models"); process.exit(1); }
if (!bg.includes("h2a:get-settings") || !bg.includes("h2a:set-settings")) { console.error("background.js must handle h2a:get-settings and h2a:set-settings"); process.exit(1); }
const optHtml = fs.readFileSync("src/options.html", "utf8");
if (!optHtml.includes("deck-select") || !optHtml.includes("model-select")) { console.error("options.html must render deck-select and model-select"); process.exit(1); }
const optJs = fs.readFileSync("src/options.js", "utf8");
if (!optJs.includes("h2a:list-decks") || !optJs.includes("h2a:list-models") || !optJs.includes("h2a:set-settings")) { console.error("options.js must use list-decks/list-models/set-settings messages"); process.exit(1); }
if (!Array.isArray(m.host_permissions) || !m.host_permissions.some((h) => h.includes("127.0.0.1:8765"))) {
  console.error("manifest host_permissions must include http://127.0.0.1:8765/*"); process.exit(1);
}
console.log("\u2713 smoke ok");
