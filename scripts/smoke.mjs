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
if (!anki.includes("export async function addNote") || !anki.includes("export function buildCardFields")) {
  console.error("src/anki.js must export addNote and buildCardFields"); process.exit(1);
}
if (!anki.includes("export function buildClozeFields") || !anki.includes("export async function addClozeNote")) {
  console.error("src/anki.js must export buildClozeFields and addClozeNote"); process.exit(1);
}
if (!bg.includes("Send to Anki as Cloze")) {
  console.error("background.js must register 'Send to Anki as Cloze' context menu"); process.exit(1);
}
if (!bg.includes("h2a:send-capture-cloze") || !bg.includes("sendCaptureAsCloze")) {
  console.error("background.js must wire h2a:send-capture-cloze to sendCaptureAsCloze"); process.exit(1);
}
if (!bg.includes("h2a:send-capture") || !bg.includes("sendCaptureToAnki")) {
  console.error("background.js must wire h2a:send-capture to sendCaptureToAnki"); process.exit(1);
}

// Behavioural check: buildCardFields produces a citation link on the back.
const { buildCardFields, escapeHtml } = await import("../src/anki.js");
const sample = buildCardFields({
  text: "Memory is the residue of thought.",
  paragraph: "Memory is the residue of thought. Students remember what they think about.",
  url: "https://example.com/a?b=1&c=2",
  title: "Why Don't Students Like School?",
  hostname: "example.com",
});
if (!sample.front.includes("Memory is the residue of thought.")) { console.error("buildCardFields: front missing selection text"); process.exit(1); }
if (!sample.back.includes("<blockquote") || !sample.back.includes("Students remember")) { console.error("buildCardFields: back missing context blockquote"); process.exit(1); }
if (!sample.back.includes("href=\"https://example.com/a?b=1&amp;c=2\"")) { console.error("buildCardFields: back missing escaped source link"); process.exit(1); }
if (escapeHtml("<x>&'\"") !== "&lt;x&gt;&amp;&#39;&quot;") { console.error("escapeHtml: incorrect output"); process.exit(1); }
const noParagraph = buildCardFields({ text: "Solo", url: "https://e.com/", title: "E" });
if (noParagraph.back.includes("<blockquote")) { console.error("buildCardFields: should omit blockquote when paragraph absent"); process.exit(1); }

// Behavioural check: buildClozeFields wraps selection inside the paragraph.
const { buildClozeFields } = await import("../src/anki.js");
const cloze = buildClozeFields({
  text: "residue of thought",
  paragraph: "Memory is the residue of thought.",
  url: "https://example.com/post",
  title: "Why Don't Students Like School?",
});
if (!cloze.text.includes("{{c1::residue of thought}}")) { console.error("buildClozeFields: missing cloze marker"); process.exit(1); }
if (!cloze.text.includes("Memory is the")) { console.error("buildClozeFields: should splice cloze into paragraph context"); process.exit(1); }
if (cloze.text.split("{{c1::").length !== 2) { console.error("buildClozeFields: should only emit a single cloze marker"); process.exit(1); }
if (!cloze.extra.includes("href=\"https://example.com/post\"")) { console.error("buildClozeFields: extra missing source link"); process.exit(1); }
const clozeSolo = buildClozeFields({ text: "alpha & beta", url: "", title: "" });
if (!clozeSolo.text.includes("{{c1::alpha &amp; beta}}")) { console.error("buildClozeFields: selection HTML-escape failed"); process.exit(1); }
if (!bg.includes("h2a:list-decks") || !bg.includes("h2a:list-models")) { console.error("background.js must handle h2a:list-decks and h2a:list-models"); process.exit(1); }
if (!bg.includes("h2a:get-settings") || !bg.includes("h2a:set-settings")) { console.error("background.js must handle h2a:get-settings and h2a:set-settings"); process.exit(1); }
const optHtml = fs.readFileSync("src/options.html", "utf8");
if (!optHtml.includes("deck-select") || !optHtml.includes("model-select")) { console.error("options.html must render deck-select and model-select"); process.exit(1); }
if (!optHtml.includes("cloze-model-select")) { console.error("options.html must render cloze-model-select"); process.exit(1); }
const optJs = fs.readFileSync("src/options.js", "utf8");
if (!optJs.includes("h2a:list-decks") || !optJs.includes("h2a:list-models") || !optJs.includes("h2a:set-settings")) { console.error("options.js must use list-decks/list-models/set-settings messages"); process.exit(1); }
if (!optJs.includes("clozeModel")) { console.error("options.js must persist clozeModel"); process.exit(1); }
if (!Array.isArray(m.host_permissions) || !m.host_permissions.some((h) => h.includes("127.0.0.1:8765"))) {
  console.error("manifest host_permissions must include http://127.0.0.1:8765/*"); process.exit(1);
}
console.log("\u2713 smoke ok");
