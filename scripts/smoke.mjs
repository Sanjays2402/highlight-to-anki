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
if (!anki.includes("export function buildImageCardFields") || !anki.includes("export async function addImageNote") || !anki.includes("export function buildImageFilename")) {
  console.error("src/anki.js must export buildImageCardFields, addImageNote, buildImageFilename"); process.exit(1);
}
if (!bg.includes("Send Image to Anki") || !bg.includes("contexts: [\"image\"]")) {
  console.error("background.js must register 'Send Image to Anki' context menu scoped to image"); process.exit(1);
}
if (!bg.includes("h2a:send-capture-image") || !bg.includes("sendCaptureAsImage")) {
  console.error("background.js must wire h2a:send-capture-image to sendCaptureAsImage"); process.exit(1);
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

// Behavioural check: buildImageCardFields + buildImageFilename.
const { buildImageCardFields, buildImageFilename } = await import("../src/anki.js");
const img = buildImageCardFields({
  imageUrl: "https://example.com/diagram.png",
  url: "https://example.com/post",
  title: "Diagram Post",
});
if (img.front !== "") { console.error("buildImageCardFields: front must be empty (filled by AnkiConnect picture)"); process.exit(1); }
if (!img.back.includes("href=\"https://example.com/post\"")) { console.error("buildImageCardFields: back missing source link"); process.exit(1); }
const fname = buildImageFilename("https://example.com/path/to/Diagram%20One.png");
if (!fname.startsWith("h2a-") || !/\.png$/i.test(fname)) { console.error("buildImageFilename: should keep .png extension"); process.exit(1); }
const dataFname = buildImageFilename("data:image/jpeg;base64,AAAA");
if (!/\.jpg$/i.test(dataFname)) { console.error("buildImageFilename: should derive .jpg from data: URL"); process.exit(1); }
const fallbackFname = buildImageFilename("");
if (!fallbackFname.startsWith("h2a-")) { console.error("buildImageFilename: empty input should fall back"); process.exit(1); }
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
if (!anki.includes("export function hostnameTag")) {
  console.error("src/anki.js must export hostnameTag"); process.exit(1);
}
if (!bg.includes("hostnameTag")) {
  console.error("background.js must import hostnameTag to auto-tag captures"); process.exit(1);
}
const { hostnameTag } = await import("../src/anki.js");
if (hostnameTag("www.Example.COM") !== "site:example.com") { console.error("hostnameTag: should strip www. and lowercase"); process.exit(1); }
if (hostnameTag("news.ycombinator.com") !== "site:news.ycombinator.com") { console.error("hostnameTag: should preserve subdomain"); process.exit(1); }
if (hostnameTag("") !== null || hostnameTag(null) !== null || hostnameTag(undefined) !== null) { console.error("hostnameTag: empty inputs should return null"); process.exit(1); }
if (hostnameTag("bad host name") !== "site:badhostname") { console.error("hostnameTag: should strip whitespace"); process.exit(1); }

// Recent cards history feature.
if (!bg.includes("h2a:list-history") || !bg.includes("h2a:clear-history")) {
  console.error("background.js must handle h2a:list-history and h2a:clear-history"); process.exit(1);
}
if (!bg.includes("appendHistory") || !bg.includes("HISTORY_KEY")) {
  console.error("background.js must implement appendHistory + HISTORY_KEY for recent cards"); process.exit(1);
}
if (!popupHtml.includes("recent-card") || !popupHtml.includes("recent-list") || !popupHtml.includes("Recent")) {
  console.error("popup.html must render a Recent history section"); process.exit(1);
}
if (!popupJs.includes("h2a:list-history") || !popupJs.includes("renderHistory")) {
  console.error("popup.js must render recent history via h2a:list-history"); process.exit(1);
}
if (!popupJs.includes("recent-item")) {
  console.error("popup.js must render .recent-item rows for history"); process.exit(1);
}

// Edit-before-send dialog feature.
for (const p of ["src/editor.html", "src/editor.js", "src/editor.css"]) {
  if (!fs.existsSync(p)) { console.error("missing file:", p); process.exit(1); }
}
const editorHtml = fs.readFileSync("src/editor.html", "utf8");
if (!editorHtml.includes("front-input") || !editorHtml.includes("back-input") || !editorHtml.includes("cloze-input")) {
  console.error("editor.html must render front, back, and cloze inputs"); process.exit(1);
}
if (!editorHtml.includes("send-btn") || !editorHtml.includes("cancel-btn")) {
  console.error("editor.html must render send and cancel buttons"); process.exit(1);
}
const editorJs = fs.readFileSync("src/editor.js", "utf8");
if (!editorJs.includes("h2a:get-pending-entry") || !editorJs.includes("h2a:send-edited-capture")) {
  console.error("editor.js must use get-pending-entry/send-edited-capture messages"); process.exit(1);
}
if (!bg.includes("Edit & Send to Anki")) {
  console.error("background.js must register 'Edit & Send to Anki…' context menu"); process.exit(1);
}
if (!bg.includes("h2a:send-edited-capture") || !bg.includes("sendEditedCapture")) {
  console.error("background.js must wire h2a:send-edited-capture to sendEditedCapture"); process.exit(1);
}
if (!bg.includes("h2a:get-pending-entry")) {
  console.error("background.js must handle h2a:get-pending-entry for the editor"); process.exit(1);
}
if (!bg.includes("openEditorWindow")) {
  console.error("background.js must define openEditorWindow to launch the editor dialog"); process.exit(1);
}

if (!anki.includes("export function resolveFieldNames")) {
  console.error("src/anki.js must export resolveFieldNames"); process.exit(1);
}
const { resolveFieldNames } = await import("../src/anki.js");
const defaultFields = resolveFieldNames(null, null);
if (defaultFields.frontField !== "Front" || defaultFields.backField !== "Back" || defaultFields.textField !== "Text" || defaultFields.extraField !== "Back Extra") {
  console.error("resolveFieldNames: defaults incorrect"); process.exit(1);
}
const tplResolved = resolveFieldNames({ fieldTemplates: { Vocab: { frontField: "Word", backField: "Definition" } } }, "Vocab");
if (tplResolved.frontField !== "Word" || tplResolved.backField !== "Definition" || tplResolved.textField !== "Text") {
  console.error("resolveFieldNames: per-deck override not applied"); process.exit(1);
}
const tplBlanks = resolveFieldNames({ fieldTemplates: { Vocab: { frontField: "   " } } }, "Vocab");
if (tplBlanks.frontField !== "Front") { console.error("resolveFieldNames: blank override should fall back"); process.exit(1); }
const tplMissing = resolveFieldNames({ fieldTemplates: { Vocab: { frontField: "Word" } } }, "Other");
if (tplMissing.frontField !== "Front") { console.error("resolveFieldNames: non-matching deck should fall back"); process.exit(1); }

if (!bg.includes("resolveFieldNames")) {
  console.error("background.js must use resolveFieldNames to apply per-deck field templates"); process.exit(1);
}
if (!bg.includes("fieldTemplates")) {
  console.error("background.js must persist fieldTemplates in settings"); process.exit(1);
}
if (!bg.includes("sanitiseTemplates")) {
  console.error("background.js must sanitise field templates on save"); process.exit(1);
}
if (!optHtml.includes("templates-list") || !optHtml.includes("add-template-btn") || !optHtml.includes("Field templates")) {
  console.error("options.html must render the field-templates section"); process.exit(1);
}
if (!optJs.includes("fieldTemplates") || !optJs.includes("renderTemplates") || !optJs.includes("templatesToMap")) {
  console.error("options.js must render and persist fieldTemplates"); process.exit(1);
}

if (!bg.includes("h2a:sync-status")) {
  console.error("background.js must handle h2a:sync-status"); process.exit(1);
}
if (!popupHtml.includes("sync-pill") || !popupHtml.includes("sync-card") || !popupHtml.includes("Sync")) {
  console.error("popup.html must render a Sync status card"); process.exit(1);
}
if (!popupJs.includes("h2a:sync-status") || !popupJs.includes("renderSync")) {
  console.error("popup.js must render sync status via h2a:sync-status"); process.exit(1);
}

// Dark/light theme feature.
if (!fs.existsSync("src/theme.js")) { console.error("missing file: src/theme.js"); process.exit(1); }
const themeSrc = fs.readFileSync("src/theme.js", "utf8");
if (!themeSrc.includes("export function resolveTheme") || !themeSrc.includes("export function initTheme")) {
  console.error("src/theme.js must export resolveTheme and initTheme"); process.exit(1);
}
if (!bg.includes("theme:") || !bg.includes("THEME_PREFERENCES")) {
  console.error("background.js must persist a theme preference (THEME_PREFERENCES + theme: ...)"); process.exit(1);
}
if (!popupHtml.includes("theme-seg") || !popupHtml.includes('data-theme-pref="light"') || !popupHtml.includes('data-theme-pref="dark"') || !popupHtml.includes('data-theme-pref="auto"')) {
  console.error("popup.html must render a theme segmented control with light/auto/dark"); process.exit(1);
}
if (!popupJs.includes("initTheme") || !popupJs.includes("setPreference")) {
  console.error("popup.js must wire initTheme and setPreference"); process.exit(1);
}
if (!optHtml.includes("theme-seg") || !optHtml.includes('data-theme-pref="auto"')) {
  console.error("options.html must render the theme picker"); process.exit(1);
}
if (!optJs.includes("initTheme")) {
  console.error("options.js must use initTheme"); process.exit(1);
}
const editorJsSrc = fs.readFileSync("src/editor.js", "utf8");
if (!editorJsSrc.includes("initTheme")) {
  console.error("editor.js must use initTheme"); process.exit(1);
}
const popupCss = fs.readFileSync("src/popup.css", "utf8");
if (!popupCss.includes(".theme-seg") || !popupCss.includes(".theme-btn")) {
  console.error("popup.css must style .theme-seg / .theme-btn"); process.exit(1);
}
const optionsCss = fs.readFileSync("src/options.css", "utf8");
if (!optionsCss.includes(".theme-seg") || !optionsCss.includes(".theme-btn")) {
  console.error("options.css must style .theme-seg / .theme-btn"); process.exit(1);
}
const { resolveTheme, coercePreference, THEME_VALUES } = await import("../src/theme.js");
if (!Array.isArray(THEME_VALUES) || THEME_VALUES.length !== 3) { console.error("THEME_VALUES must be a 3-tuple"); process.exit(1); }
if (resolveTheme("dark", false) !== "dark" || resolveTheme("dark", true) !== "dark") { console.error("resolveTheme: 'dark' must pin dark"); process.exit(1); }
if (resolveTheme("light", false) !== "light" || resolveTheme("light", true) !== "light") { console.error("resolveTheme: 'light' must pin light"); process.exit(1); }
if (resolveTheme("auto", true) !== "light" || resolveTheme("auto", false) !== "dark") { console.error("resolveTheme: 'auto' must follow media query"); process.exit(1); }
if (coercePreference("bogus") !== "auto" || coercePreference("dark") !== "dark") { console.error("coercePreference: invalid input should fall back to 'auto'"); process.exit(1); }

console.log("\u2713 smoke ok");
