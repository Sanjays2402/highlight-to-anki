// Highlight to Anki — service worker (MV3)
//
// Owns the context-menu entry "Send to Anki" which appears whenever a
// user has text selected on a page. Clicking it asks the content script
// for a structured selection snapshot and stages it for downstream
// features (AnkiConnect bridge, edit-before-send, history, etc.).
//
// All chrome.* APIs used here are covered by manifest permissions:
//   contextMenus, storage, activeTab, scripting, <all_urls>.

import {
  healthCheck as ankiHealthCheck,
  deckNames as ankiDeckNames,
  modelNames as ankiModelNames,
  addNote as ankiAddNote,
  addClozeNote as ankiAddClozeNote,
  addImageNote as ankiAddImageNote,
  deleteNotes as ankiDeleteNotes,
  findDuplicates as ankiFindDuplicates,
  buildCardFields,
  buildClozeFields,
  buildImageCardFields,
  buildReverseCardFields,
  hostnameTag,
  detectLanguage,
  languageTag,
  resolveFieldNames,
  resolveDeckCss,
  applyDeckStyles,
  resolveSiteDeck,
  buildAnkiConnectUrl,
  normaliseAnkiHost,
  normaliseAnkiPort,
  DEFAULT_ANKI_HOST,
  DEFAULT_ANKI_PORT,
} from "./anki.js";

const TAG = "[highlight-to-anki:bg]";
const MENU_ID = "h2a-send-to-anki";
const MENU_ID_CLOZE = "h2a-send-to-anki-cloze";
const MENU_ID_REVERSE = "h2a-send-to-anki-reverse";
const MENU_ID_IMAGE = "h2a-send-image-to-anki";
const MENU_ID_BATCH = "h2a-add-to-batch";
const MENU_ID_PIN = "h2a-pin-snippet";
const MENU_ID_EDIT = "h2a-edit-and-send";
const MENU_ID_SHOT = "h2a-screenshot-region";
const PENDING_KEY = "h2a:pendingCaptures";
const PENDING_LIMIT = 25;
const BATCH_KEY = "h2a:batch";
const BATCH_LIMIT = 100;
const PINS_KEY = "h2a:pins";
const PINS_LIMIT = 100;
const HISTORY_KEY = "h2a:history";
const HISTORY_LIMIT = 50;
const SETTINGS_KEY = "h2a:settings";
const DEFAULT_SETTINGS = Object.freeze({
  defaultDeck: "",
  defaultModel: "",
  clozeModel: "",
  fieldTemplates: {},
  deckStyles: {},
  siteRules: [],
  theme: "auto",
  ankiHost: DEFAULT_ANKI_HOST,
  ankiPort: DEFAULT_ANKI_PORT,
  updatedAt: null,
});
const THEME_PREFERENCES = new Set(["auto", "dark", "light"]);

/**
 * Sanitise a user-supplied field-templates map. Drops empty deck keys
 * and trims overrides so blanks fall back to the AnkiConnect defaults
 * via {@link resolveFieldNames}. Returns a plain object suitable for
 * direct storage in chrome.storage.sync.
 *
 * @param {unknown} raw
 * @returns {Record<string, {frontField?:string, backField?:string, textField?:string, extraField?:string}>}
 */
/**
 * Sanitise the per-site deck rules list. Each entry is
 * `{ hostname, deck }` where both fields are required and non-empty.
 * Hostnames are lowercased and de-`www.`'d; duplicates are dropped
 * keeping the first occurrence so the user-visible ordering wins.
 *
 * @param {unknown} raw
 * @returns {Array<{ hostname: string, deck: string }>}
 */
function sanitiseSiteRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    let host = typeof item.hostname === "string" ? item.hostname.trim().toLowerCase() : "";
    const deck = typeof item.deck === "string" ? item.deck.trim() : "";
    if (!host || !deck) continue;
    if (host.startsWith("www.")) host = host.slice(4);
    host = host.replace(/\s+/g, "");
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({ hostname: host, deck });
  }
  return out;
}

function sanitiseTemplates(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [deck, tpl] of Object.entries(raw)) {
    const deckName = typeof deck === "string" ? deck.trim() : "";
    if (!deckName || !tpl || typeof tpl !== "object") continue;
    const entry = {};
    for (const key of ["frontField", "backField", "textField", "extraField"]) {
      const v = typeof tpl[key] === "string" ? tpl[key].trim() : "";
      if (v) entry[key] = v;
    }
    if (Object.keys(entry).length > 0) out[deckName] = entry;
  }
  return out;
}

/**
 * Sanitise the per-deck custom CSS map. Keys are deck names; values
 * are raw CSS strings that get embedded into every card front via a
 * scoped `<style>` block at send time. Empty / whitespace entries are
 * dropped so the persisted blob stays compact. Per-deck CSS is
 * capped at 8 KB so a runaway paste can't bloat chrome.storage.sync.
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function sanitiseDeckStyles(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  const MAX = 8 * 1024;
  for (const [deck, css] of Object.entries(raw)) {
    const deckName = typeof deck === "string" ? deck.trim() : "";
    if (!deckName) continue;
    const value = typeof css === "string" ? css : "";
    const trimmed = value.replace(/^\s+|\s+$/g, "");
    if (!trimmed) continue;
    out[deckName] = trimmed.length > MAX ? trimmed.slice(0, MAX) : trimmed;
  }
  return out;
}

/**
 * Append a successful send to the recent history ring buffer. Stored in
 * chrome.storage.local so it persists across popup opens but never leaves
 * the device. Bounded at {@link HISTORY_LIMIT} most-recent items.
 *
 * @param {object} entry the staged capture (post-send patch)
 * @param {{ noteId: number|null, mode?: string, deck?: string }} extra
 */
async function appendHistory(entry, extra) {
  if (!entry) return null;
  const store = await chrome.storage.local.get(HISTORY_KEY);
  const list = Array.isArray(store[HISTORY_KEY]) ? store[HISTORY_KEY] : [];
  const row = {
    id: entry.id || `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: (entry.text || "").slice(0, 400),
    imageUrl: entry.imageUrl || "",
    url: entry.url || "",
    title: entry.title || "",
    hostname: entry.hostname || "",
    mode: (extra && extra.mode) || entry.mode || "basic",
    noteId: extra && extra.noteId != null ? extra.noteId : entry.noteId || null,
    deck: (extra && extra.deck) || "",
    sentAt: entry.sentAt || new Date().toISOString(),
  };
  list.unshift(row);
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  await chrome.storage.local.set({ [HISTORY_KEY]: list });
  try {
    await chrome.runtime.sendMessage({ type: "h2a:history-updated", payload: row });
  } catch (_) { /* no popup open */ }
  return row;
}

/** Read settings from sync storage, falling back to local + defaults. */
async function loadSettings() {
  const area = chrome.storage.sync || chrome.storage.local;
  const store = await area.get(SETTINGS_KEY);
  const raw = store[SETTINGS_KEY] || {};
  return { ...DEFAULT_SETTINGS, ...raw };
}

/** Persist settings — only known keys, last-write-wins. */
async function saveSettings(patch) {
  const area = chrome.storage.sync || chrome.storage.local;
  const current = await loadSettings();
  const next = {
    defaultDeck: typeof patch.defaultDeck === "string" ? patch.defaultDeck : current.defaultDeck,
    defaultModel: typeof patch.defaultModel === "string" ? patch.defaultModel : current.defaultModel,
    clozeModel: typeof patch.clozeModel === "string" ? patch.clozeModel : current.clozeModel,
    fieldTemplates: patch.fieldTemplates !== undefined
      ? sanitiseTemplates(patch.fieldTemplates)
      : (current.fieldTemplates || {}),
    deckStyles: patch.deckStyles !== undefined
      ? sanitiseDeckStyles(patch.deckStyles)
      : sanitiseDeckStyles(current.deckStyles || {}),
    siteRules: patch.siteRules !== undefined
      ? sanitiseSiteRules(patch.siteRules)
      : (Array.isArray(current.siteRules) ? current.siteRules : []),
    theme: THEME_PREFERENCES.has(patch.theme) ? patch.theme : (current.theme || "auto"),
    ankiHost: patch.ankiHost !== undefined
      ? (normaliseAnkiHost(patch.ankiHost) || DEFAULT_ANKI_HOST)
      : (normaliseAnkiHost(current.ankiHost) || DEFAULT_ANKI_HOST),
    ankiPort: patch.ankiPort !== undefined
      ? (normaliseAnkiPort(patch.ankiPort) ?? DEFAULT_ANKI_PORT)
      : (normaliseAnkiPort(current.ankiPort) ?? DEFAULT_ANKI_PORT),
    updatedAt: new Date().toISOString(),
  };
  await area.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Resolve the AnkiConnect endpoint URL for a settings snapshot. Pure
 * helper around {@link buildAnkiConnectUrl} so callers don't need to
 * import normalisers themselves.
 *
 * @param {{ ankiHost?: string, ankiPort?: number|string }|undefined|null} settings
 * @returns {string}
 */
function ankiUrlFromSettings(settings) {
  const s = settings || {};
  return buildAnkiConnectUrl(s.ankiHost, s.ankiPort);
}

/** Create (or recreate) the context menu entry. */
function ensureMenu() {
  if (!chrome.contextMenus) {
    console.warn(TAG, "contextMenus API unavailable");
    return;
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: "Send to Anki",
        contexts: ["selection"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "menu create error:", err.message);
      },
    );
    chrome.contextMenus.create(
      {
        id: MENU_ID_CLOZE,
        title: "Send to Anki as Cloze",
        contexts: ["selection"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "cloze menu create error:", err.message);
      },
    );
    chrome.contextMenus.create(
      {
        id: MENU_ID_REVERSE,
        title: "Send to Anki (Reverse)",
        contexts: ["selection"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "reverse menu create error:", err.message);
      },
    );
    chrome.contextMenus.create(
      {
        id: MENU_ID_IMAGE,
        title: "Send Image to Anki",
        contexts: ["image"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "image menu create error:", err.message);
      },
    );
    chrome.contextMenus.create(
      {
        id: MENU_ID_EDIT,
        title: "Edit & Send to Anki…",
        contexts: ["selection"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "edit menu create error:", err.message);
      },
    );
    chrome.contextMenus.create(
      {
        id: MENU_ID_SHOT,
        title: "Screenshot Region to Anki…",
        contexts: ["page", "selection", "frame", "image"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "shot menu create error:", err.message);
      },
    );
    chrome.contextMenus.create(
      {
        id: MENU_ID_BATCH,
        title: "Add to Batch",
        contexts: ["selection"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "batch menu create error:", err.message);
      },
    );
    chrome.contextMenus.create(
      {
        id: MENU_ID_PIN,
        title: "Pin Snippet",
        contexts: ["selection"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "pin menu create error:", err.message);
      },
    );
  });
}

/**
 * Append a snippet to the pinned-snippets list. Pinned snippets are
 * captures the user wants to revisit and batch-send later, surfaced
 * in the popup. Newest-first FIFO bounded at {@link PINS_LIMIT}.
 *
 * @param {object} capture
 * @returns {Promise<object|null>} the pinned row, or null when empty.
 */
async function addPin(capture) {
  if (!capture || (!capture.text && !capture.imageUrl)) return null;
  const store = await chrome.storage.local.get(PINS_KEY);
  const list = Array.isArray(store[PINS_KEY]) ? store[PINS_KEY] : [];
  const row = {
    id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: (capture.text || "").slice(0, 1000),
    html: capture.html || "",
    imageUrl: capture.imageUrl || "",
    url: capture.url || "",
    title: capture.title || "",
    hostname: capture.hostname || "",
    paragraph: capture.paragraph || "",
    pinnedAt: new Date().toISOString(),
  };
  list.unshift(row);
  if (list.length > PINS_LIMIT) list.length = PINS_LIMIT;
  await chrome.storage.local.set({ [PINS_KEY]: list });
  return row;
}

/**
 * Move every pinned snippet onto the batch queue and clear the pin
 * store. The popup uses this to flip a stack of read-later snippets
 * into the normal batch-send pipeline in a single click.
 *
 * @returns {Promise<{ moved: number, pins: object[], batch: object[] }>}
 */
async function sendPinsToBatch(ids) {
  const store = await chrome.storage.local.get([PINS_KEY, BATCH_KEY]);
  const pins = Array.isArray(store[PINS_KEY]) ? store[PINS_KEY] : [];
  const batch = Array.isArray(store[BATCH_KEY]) ? store[BATCH_KEY] : [];
  const idSet = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const toMove = idSet ? pins.filter((p) => p && idSet.has(p.id)) : pins.slice();
  const remaining = idSet ? pins.filter((p) => p && !idSet.has(p.id)) : [];
  for (const p of toMove) {
    batch.push({
      ...p,
      id: `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "queued",
      noteId: null,
      error: null,
    });
  }
  if (batch.length > BATCH_LIMIT) batch.splice(0, batch.length - BATCH_LIMIT);
  await chrome.storage.local.set({ [PINS_KEY]: remaining, [BATCH_KEY]: batch });
  return { moved: toMove.length, pins: remaining, batch };
}

/**
 * Append a capture to the batch list. Each batch entry is the same
 * shape as a staged pending entry so the send loop can reuse the
 * single-card pipeline. The batch is a bounded FIFO of up to
 * {@link BATCH_LIMIT} items.
 * @param {object} capture
 * @returns {Promise<object|null>} the appended entry, or null when capture is empty.
 */
async function addToBatch(capture) {
  if (!capture || !capture.text) return null;
  const store = await chrome.storage.local.get(BATCH_KEY);
  const list = Array.isArray(store[BATCH_KEY]) ? store[BATCH_KEY] : [];
  const entry = {
    ...capture,
    id: `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "queued",
    noteId: null,
    error: null,
  };
  list.push(entry);
  if (list.length > BATCH_LIMIT) list.splice(0, list.length - BATCH_LIMIT);
  await chrome.storage.local.set({ [BATCH_KEY]: list });
  return entry;
}

/**
 * Send every queued batch capture to Anki, one card per selection.
 * Successful items are removed from the batch; failed items are
 * retained with their error so the user can retry. Returns a summary
 * that the popup uses to render the result toast.
 *
 * @returns {Promise<{ ok: boolean, total: number, sent: number, failed: number, errors: string[], remaining: object[] }>}
 */
async function sendBatch() {
  const settings = await loadSettings();
  if (!settings.defaultDeck || !settings.defaultModel) {
    return {
      ok: false,
      total: 0,
      sent: 0,
      failed: 0,
      errors: ["No default deck/model configured"],
      remaining: [],
    };
  }
  const siteRules = Array.isArray(settings.siteRules) ? settings.siteRules : [];
  const store = await chrome.storage.local.get(BATCH_KEY);
  const list = Array.isArray(store[BATCH_KEY]) ? store[BATCH_KEY] : [];
  const total = list.length;
  const remaining = [];
  const errors = [];
  let sent = 0;
  let failed = 0;
  for (const entry of list) {
    if (!entry || !entry.text) continue;
    const { front, back } = buildCardFields(entry);
    const siteTag = hostnameTag(entry.hostname);
    const langTag = languageTag(detectLanguage(entry.paragraph || entry.text));
    const tags = ["highlight-to-anki", "batch"];
    if (siteTag) tags.push(siteTag);
    if (langTag) tags.push(langTag);
    const batchDeck = resolveSiteDeck(siteRules, entry.hostname) || settings.defaultDeck;
    try {
      const batchFields = resolveFieldNames(settings, batchDeck);
      const batchDeckCss = resolveDeckCss(settings, batchDeck);
      const noteId = await ankiAddNote({
        deckName: batchDeck,
        modelName: settings.defaultModel,
        front: applyDeckStyles(front, batchDeckCss),
        back,
        tags,
        frontField: batchFields.frontField,
        backField: batchFields.backField,
        url: ankiUrlFromSettings(settings),
      });
      sent += 1;
      console.log(TAG, "batch sent note", noteId);
      await appendHistory({ ...entry, noteId, sentAt: new Date().toISOString() }, { mode: "basic", noteId, deck: batchDeck });
    } catch (err) {
      failed += 1;
      const msg = err && err.message ? err.message : String(err);
      errors.push(msg);
      remaining.push({ ...entry, status: "failed", error: msg });
    }
  }
  await chrome.storage.local.set({ [BATCH_KEY]: remaining });
  return { ok: failed === 0 && total > 0, total, sent, failed, errors, remaining };
}

/**
 * Derive a hostname from an arbitrary URL string. Returns an empty
 * string when the URL is unparseable; callers can then skip the
 * `site:` tag the same way they would for a tab without a hostname.
 * @param {string|undefined|null} u
 * @returns {string}
 */
function safeHostname(u) {
  if (!u) return "";
  try {
    return new URL(u).hostname || "";
  } catch (_err) {
    return "";
  }
}

/**
 * Build a capture snapshot for a right-clicked image. Mirrors the
 * shape of {@link captureSelection} in the content script so the rest
 * of the pipeline (staging, sending, history) can stay shape-agnostic.
 *
 * @param {chrome.contextMenus.OnClickData} info
 * @param {chrome.tabs.Tab|undefined} tab
 * @returns {object}
 */
function captureFromImage(info, tab) {
  const srcUrl = (info && info.srcUrl) || "";
  const pageUrl = (info && info.pageUrl) || (tab && tab.url) || "";
  const title = (tab && tab.title) || pageUrl || "image";
  return {
    kind: "image",
    text: "",
    html: srcUrl ? `<img src="${srcUrl}">` : "",
    imageUrl: srcUrl,
    url: pageUrl,
    title,
    hostname: safeHostname(pageUrl),
    paragraph: "",
    capturedAt: new Date().toISOString(),
  };
}

const ONBOARDING_KEY = "h2a:onboarding";

/**
 * Open the first-run onboarding tutorial in a new tab. The tutorial
 * itself decides when the user is finished and writes
 * `h2a:onboarding` into chrome.storage.local; we just open the URL.
 *
 * @returns {Promise<void>}
 */
async function openOnboarding() {
  const url = chrome.runtime.getURL("src/onboarding.html");
  try {
    await chrome.tabs.create({ url, active: true });
  } catch (err) {
    console.warn(TAG, "openOnboarding tabs.create failed:", err && err.message);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log(TAG, "installed", details && details.reason);
  ensureMenu();
  if (details && details.reason === "install") {
    // First-run only — never re-open on update / browser_update / chrome_update.
    openOnboarding().catch((err) => {
      console.warn(TAG, "first-run onboarding open failed:", err && err.message);
    });
  }
});
chrome.runtime.onStartup.addListener(() => ensureMenu());
// Cover the cold-boot case where neither onInstalled nor onStartup has
// fired yet (e.g. dev reload).
ensureMenu();

/**
 * Ask the page's content script for a selection snapshot. If the script
 * is not yet injected (some pages load it lazily), fall back to
 * chrome.scripting to grab the raw selection text as a best effort.
 * @param {number} tabId
 * @param {string=} fallbackText
 * @returns {Promise<object>} capture payload
 */
async function requestCapture(tabId, fallbackText) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, {
      type: "h2a:capture-selection",
    });
    if (reply && reply.ok && reply.payload && reply.payload.text) {
      return reply.payload;
    }
  } catch (err) {
    console.debug(TAG, "content script unreachable, falling back:", err && err.message);
  }

  // Fallback: minimal capture via scripting injection.
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const sel = window.getSelection();
        return {
          text: sel ? sel.toString().trim() : "",
          html: "",
          url: location.href,
          title: document.title,
          hostname: location.hostname,
          paragraph: "",
          capturedAt: new Date().toISOString(),
        };
      },
    });
    return result && result.result
      ? result.result
      : {
          text: fallbackText || "",
          html: "",
          url: "",
          title: "",
          hostname: "",
          paragraph: "",
          capturedAt: new Date().toISOString(),
        };
  } catch (err) {
    console.warn(TAG, "scripting fallback failed:", err && err.message);
    return {
      text: fallbackText || "",
      html: "",
      url: "",
      title: "",
      hostname: "",
      paragraph: "",
      capturedAt: new Date().toISOString(),
    };
  }
}

/** Persist a capture to a bounded ring buffer in chrome.storage.local. */
async function stagePending(capture) {
  if (!capture) return null;
  // Image captures have no `text`; allow either text or imageUrl as proof-of-content.
  if (!capture.text && !capture.imageUrl) return null;
  const store = await chrome.storage.local.get(PENDING_KEY);
  const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
  const entry = {
    ...capture,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "staged",
    noteId: null,
    error: null,
  };
  list.unshift(entry);
  if (list.length > PENDING_LIMIT) list.length = PENDING_LIMIT;
  await chrome.storage.local.set({ [PENDING_KEY]: list });
  return entry;
}

/** Patch a staged capture in place by id. */
async function patchPending(id, patch) {
  if (!id) return null;
  const store = await chrome.storage.local.get(PENDING_KEY);
  const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
  const idx = list.findIndex((entry) => entry && entry.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  await chrome.storage.local.set({ [PENDING_KEY]: list });
  return list[idx];
}

/**
 * Send a capture entry to Anki as a basic note. Honours the configured
 * default deck/model; returns the AnkiConnect note id on success and
 * records the outcome back onto the staged entry so the popup history
 * can surface it later.
 *
 * @param {object} entry staged capture
 * @returns {Promise<{ ok: boolean, noteId: number|null, error: string|null, entry: object }>}
 */
async function sendCaptureToAnki(entry) {
  if (!entry || !entry.text) {
    return { ok: false, noteId: null, error: "empty capture", entry };
  }
  const settings = await loadSettings();
  if (!settings.defaultDeck || !settings.defaultModel) {
    const patched = await patchPending(entry.id, { status: "needs-config", error: "No default deck/model configured" });
    return { ok: false, noteId: null, error: "No default deck/model configured", entry: patched || entry };
  }
  const { front, back } = buildCardFields(entry);
  await patchPending(entry.id, { status: "sending", error: null });
  const siteTag = hostnameTag(entry.hostname);
  const langTag = languageTag(detectLanguage(entry.paragraph || entry.text));
  const tags = ["highlight-to-anki"];
  if (siteTag) tags.push(siteTag);
  if (langTag) tags.push(langTag);
  const targetDeck = resolveSiteDeck(settings.siteRules, entry.hostname) || settings.defaultDeck;
  const fields = resolveFieldNames(settings, targetDeck);
  const deckCss = resolveDeckCss(settings, targetDeck);
  try {
    const noteId = await ankiAddNote({
      deckName: targetDeck,
      modelName: settings.defaultModel,
      front: applyDeckStyles(front, deckCss),
      back,
      tags,
      frontField: fields.frontField,
      backField: fields.backField,
      url: ankiUrlFromSettings(settings),
    });
    const patched = await patchPending(entry.id, { status: "sent", noteId, error: null, sentAt: new Date().toISOString() });
    await appendHistory(patched || { ...entry, noteId }, { mode: "basic", noteId, deck: targetDeck });
    return { ok: true, noteId, error: null, entry: patched || entry };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const patched = await patchPending(entry.id, { status: "failed", error: msg });
    return { ok: false, noteId: null, error: msg, entry: patched || entry };
  }
}

/**
 * Send a captured image to Anki as the front of a new note. Uses the
 * configured default deck/model and lets AnkiConnect download the
 * image into Anki's media folder via the `picture` parameter — we
 * never touch the bytes ourselves, which keeps things MV3-friendly
 * (no extra host permission churn beyond `<all_urls>` already declared
 * for content-script reach).
 *
 * @param {object} entry staged image capture
 * @returns {Promise<{ ok: boolean, noteId: number|null, error: string|null, entry: object }>}
 */
async function sendCaptureAsImage(entry) {
  if (!entry || !entry.imageUrl) {
    return { ok: false, noteId: null, error: "empty image capture", entry };
  }
  const settings = await loadSettings();
  if (!settings.defaultDeck || !settings.defaultModel) {
    const patched = await patchPending(entry.id, {
      status: "needs-config",
      error: "No default deck/model configured",
    });
    return {
      ok: false,
      noteId: null,
      error: "No default deck/model configured",
      entry: patched || entry,
    };
  }
  const { back } = buildImageCardFields(entry);
  await patchPending(entry.id, { status: "sending", mode: "image", error: null });
  const siteTag = hostnameTag(entry.hostname);
  const tags = ["highlight-to-anki", "image"];
  if (siteTag) tags.push(siteTag);
  const imgTargetDeck = resolveSiteDeck(settings.siteRules, entry.hostname) || settings.defaultDeck;
  const imgFields = resolveFieldNames(settings, imgTargetDeck);
  const imgDeckCss = resolveDeckCss(settings, imgTargetDeck);
  try {
    const noteId = await ankiAddImageNote({
      deckName: imgTargetDeck,
      modelName: settings.defaultModel,
      imageUrl: entry.imageUrl,
      back: applyDeckStyles(back, imgDeckCss),
      tags,
      frontField: imgFields.frontField,
      backField: imgFields.backField,
      url: ankiUrlFromSettings(settings),
    });
    const patched = await patchPending(entry.id, {
      status: "sent",
      mode: "image",
      noteId,
      error: null,
      sentAt: new Date().toISOString(),
    });
    await appendHistory(patched || { ...entry, noteId, mode: "image" }, { mode: "image", noteId, deck: imgTargetDeck });
    return { ok: true, noteId, error: null, entry: patched || entry };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const patched = await patchPending(entry.id, { status: "failed", mode: "image", error: msg });
    return { ok: false, noteId: null, error: msg, entry: patched || entry };
  }
}

/**
 * Send a capture entry to Anki as a cloze-deletion note. Uses the
 * configured `clozeModel` (falling back to `defaultModel`) and the
 * configured `defaultDeck`. The card is tagged `cloze` in addition to
 * the usual `highlight-to-anki` tag so it is easy to filter in Anki.
 *
 * @param {object} entry staged capture
 * @returns {Promise<{ ok: boolean, noteId: number|null, error: string|null, entry: object }>}
 */
async function sendCaptureAsCloze(entry) {
  if (!entry || !entry.text) {
    return { ok: false, noteId: null, error: "empty capture", entry };
  }
  const settings = await loadSettings();
  const modelName = settings.clozeModel || settings.defaultModel;
  if (!settings.defaultDeck || !modelName) {
    const patched = await patchPending(entry.id, {
      status: "needs-config",
      error: "No default deck or cloze note type configured",
    });
    return {
      ok: false,
      noteId: null,
      error: "No default deck or cloze note type configured",
      entry: patched || entry,
    };
  }
  const { text, extra } = buildClozeFields(entry);
  await patchPending(entry.id, { status: "sending", mode: "cloze", error: null });
  const siteTag = hostnameTag(entry.hostname);
  const langTag = languageTag(detectLanguage(entry.paragraph || entry.text));
  const tags = ["highlight-to-anki", "cloze"];
  if (siteTag) tags.push(siteTag);
  if (langTag) tags.push(langTag);
  const clozeTargetDeck = resolveSiteDeck(settings.siteRules, entry.hostname) || settings.defaultDeck;
  const clozeFields = resolveFieldNames(settings, clozeTargetDeck);
  const clozeDeckCss = resolveDeckCss(settings, clozeTargetDeck);
  try {
    const noteId = await ankiAddClozeNote({
      deckName: clozeTargetDeck,
      modelName,
      text: applyDeckStyles(text, clozeDeckCss),
      extra,
      tags,
      textField: clozeFields.textField,
      extraField: clozeFields.extraField,
      url: ankiUrlFromSettings(settings),
    });
    const patched = await patchPending(entry.id, {
      status: "sent",
      mode: "cloze",
      noteId,
      error: null,
      sentAt: new Date().toISOString(),
    });
    await appendHistory(patched || { ...entry, noteId, mode: "cloze" }, { mode: "cloze", noteId, deck: clozeTargetDeck });
    return { ok: true, noteId, error: null, entry: patched || entry };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const patched = await patchPending(entry.id, { status: "failed", mode: "cloze", error: msg });
    return { ok: false, noteId: null, error: msg, entry: patched || entry };
  }
}

/**
 * Send a capture entry to Anki as a reverse-prompt note. The front
 * shows the surrounding paragraph with the selection blanked out;
 * the back surfaces the selection itself plus the source citation.
 * Uses the configured default deck/model and tags the card `reverse`
 * so it's easy to filter inside Anki.
 *
 * @param {object} entry staged capture
 * @returns {Promise<{ ok: boolean, noteId: number|null, error: string|null, entry: object }>}
 */
async function sendCaptureAsReverse(entry) {
  if (!entry || !entry.text) {
    return { ok: false, noteId: null, error: "empty capture", entry };
  }
  const settings = await loadSettings();
  if (!settings.defaultDeck || !settings.defaultModel) {
    const patched = await patchPending(entry.id, {
      status: "needs-config",
      error: "No default deck/model configured",
    });
    return {
      ok: false,
      noteId: null,
      error: "No default deck/model configured",
      entry: patched || entry,
    };
  }
  const { front, back } = buildReverseCardFields(entry);
  await patchPending(entry.id, { status: "sending", mode: "reverse", error: null });
  const siteTag = hostnameTag(entry.hostname);
  const langTag = languageTag(detectLanguage(entry.paragraph || entry.text));
  const tags = ["highlight-to-anki", "reverse"];
  if (siteTag) tags.push(siteTag);
  if (langTag) tags.push(langTag);
  const revTargetDeck = resolveSiteDeck(settings.siteRules, entry.hostname) || settings.defaultDeck;
  const revFields = resolveFieldNames(settings, revTargetDeck);
  const revDeckCss = resolveDeckCss(settings, revTargetDeck);
  try {
    const noteId = await ankiAddNote({
      deckName: revTargetDeck,
      modelName: settings.defaultModel,
      front: applyDeckStyles(front, revDeckCss),
      back,
      tags,
      frontField: revFields.frontField,
      backField: revFields.backField,
      url: ankiUrlFromSettings(settings),
    });
    const patched = await patchPending(entry.id, {
      status: "sent",
      mode: "reverse",
      noteId,
      error: null,
      sentAt: new Date().toISOString(),
    });
    await appendHistory(patched || { ...entry, noteId, mode: "reverse" }, { mode: "reverse", noteId, deck: revTargetDeck });
    return { ok: true, noteId, error: null, entry: patched || entry };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const patched = await patchPending(entry.id, { status: "failed", mode: "reverse", error: msg });
    return { ok: false, noteId: null, error: msg, entry: patched || entry };
  }
}

/**
 * Open the edit-before-send dialog as a small popup window, scoped
 * to a single staged capture id. We use chrome.windows.create with
 * type: 'popup' so it floats free of the browser tabstrip and feels
 * like a true dialog, matching the popup's liquid-glass chrome.
 *
 * @param {string} captureId staged-capture id from {@link stagePending}
 */
async function openEditorWindow(captureId) {
  if (!captureId) return;
  const url = chrome.runtime.getURL(`src/editor.html#id=${encodeURIComponent(captureId)}`);
  try {
    if (chrome.windows && chrome.windows.create) {
      await chrome.windows.create({ url, type: "popup", width: 520, height: 720, focused: true });
      return;
    }
  } catch (err) {
    console.warn(TAG, "openEditorWindow windows.create failed:", err && err.message);
  }
  try {
    await chrome.tabs.create({ url });
  } catch (err) {
    console.warn(TAG, "openEditorWindow tabs.create failed:", err && err.message);
  }
}

/**
 * Send a user-edited capture to Anki. Unlike {@link sendCaptureToAnki},
 * the front/back/tags/deck/model arrive directly from the editor — we
 * trust the user's edits and skip the template builders. The staged
 * pending entry is patched in place so history and toasts still work.
 *
 * @param {{ id: string, mode: string, deck: string, model: string, tags: string[], front?: string, back?: string, text?: string, extra?: string }} edits
 * @returns {Promise<{ ok: boolean, noteId: number|null, error: string|null, entry: object|null }>}
 */
async function sendEditedCapture(edits) {
  if (!edits || !edits.id) {
    return { ok: false, noteId: null, error: "missing capture id", entry: null };
  }
  const store = await chrome.storage.local.get(PENDING_KEY);
  const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
  const entry = list.find((e) => e && e.id === edits.id);
  if (!entry) return { ok: false, noteId: null, error: "capture not found", entry: null };
  const deckName = (edits.deck || "").trim();
  const modelName = (edits.model || "").trim();
  if (!deckName || !modelName) {
    return { ok: false, noteId: null, error: "Deck and note type are required", entry };
  }
  const mode = edits.mode === "cloze" ? "cloze" : "basic";
  const baseTags = Array.isArray(edits.tags) && edits.tags.length
    ? edits.tags
    : (() => {
        const t = ["highlight-to-anki"];
        const siteTag = hostnameTag(entry.hostname);
        if (siteTag) t.push(siteTag);
        const langTag = languageTag(detectLanguage(entry.paragraph || entry.text || edits.text || edits.front));
        if (langTag) t.push(langTag);
        if (mode === "cloze") t.push("cloze");
        return t;
      })();
  await patchPending(entry.id, { status: "sending", mode, error: null });
  const settings = await loadSettings();
  const editFields = resolveFieldNames(settings, deckName);
  const editDeckCss = resolveDeckCss(settings, deckName);
  try {
    let noteId;
    if (mode === "cloze") {
      noteId = await ankiAddClozeNote({
        deckName,
        modelName,
        text: applyDeckStyles(edits.text || "", editDeckCss),
        extra: edits.extra || "",
        tags: baseTags,
        textField: editFields.textField,
        extraField: editFields.extraField,
        url: ankiUrlFromSettings(settings),
      });
    } else {
      noteId = await ankiAddNote({
        deckName,
        modelName,
        front: applyDeckStyles(edits.front || "", editDeckCss),
        back: edits.back || "",
        tags: baseTags,
        frontField: editFields.frontField,
        backField: editFields.backField,
        url: ankiUrlFromSettings(settings),
      });
    }
    const patched = await patchPending(entry.id, {
      status: "sent",
      mode,
      noteId,
      error: null,
      sentAt: new Date().toISOString(),
    });
    await appendHistory(patched || { ...entry, noteId, mode }, { mode, noteId, deck: deckName });
    try {
      await chrome.runtime.sendMessage({ type: "h2a:capture-sent", payload: { ok: true, noteId, error: null, entry: patched || entry } });
    } catch (_) { /* no popup open */ }
    return { ok: true, noteId, error: null, entry: patched || entry };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const patched = await patchPending(entry.id, { status: "failed", mode, error: msg });
    return { ok: false, noteId: null, error: msg, entry: patched || entry };
  }
}

/**
 * Drive the selection-screenshot flow: inject the region overlay,
 * capture the visible tab as a PNG, crop to the selected rectangle
 * via OffscreenCanvas, stage the resulting data: URL as an image
 * capture, and (if a default deck/model is configured) ship it to
 * Anki straight away. Returns a payload describing what was staged
 * and any broadcast envelope for the popup.
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<{ ok: boolean, broadcast?: object, error?: string }>}
 */
async function startScreenshotRegionFlow(tab) {
  if (!tab || tab.id == null || !tab.windowId == null) return { ok: false, error: "no active tab" };
  let regionReply;
  try {
    regionReply = await chrome.tabs.sendMessage(tab.id, { type: "h2a:start-region-capture" });
  } catch (err) {
    // Content script may not be injected on this page (e.g. chrome://);
    // try to inject it on demand and retry once.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
      regionReply = await chrome.tabs.sendMessage(tab.id, { type: "h2a:start-region-capture" });
    } catch (err2) {
      console.warn(TAG, "screenshot: cannot reach page:", err2 && err2.message);
      return { ok: false, error: "page not scriptable" };
    }
  }
  if (!regionReply || !regionReply.ok || !regionReply.payload) {
    console.log(TAG, "screenshot: cancelled");
    return { ok: false, error: "cancelled" };
  }
  const region = regionReply.payload;
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    console.warn(TAG, "captureVisibleTab failed:", err && err.message);
    return { ok: false, error: err && err.message ? err.message : "capture failed" };
  }
  let cropped;
  try {
    cropped = await cropScreenshotInWorker(dataUrl, region.rect, region.devicePixelRatio || 1);
  } catch (err) {
    console.warn(TAG, "crop failed:", err && err.message);
    return { ok: false, error: err && err.message ? err.message : "crop failed" };
  }
  const capture = {
    kind: "image",
    text: "",
    html: `<img src="${cropped}">`,
    imageUrl: cropped,
    url: region.url || tab.url || "",
    title: region.title || tab.title || "screenshot",
    hostname: region.hostname || safeHostname(region.url || tab.url || ""),
    paragraph: "",
    capturedAt: new Date().toISOString(),
    source: "screenshot",
  };
  const entry = await stagePending(capture);
  try {
    await chrome.runtime.sendMessage({ type: "h2a:capture-staged", payload: entry || capture });
  } catch (_) { /* no popup open */ }
  if (!entry) return { ok: false, error: "stage failed" };
  const settings = await loadSettings();
  if (!settings.defaultDeck || !settings.defaultModel) {
    console.log(TAG, "screenshot staged; needs default deck/model");
    return { ok: true, broadcast: { type: "h2a:capture-staged", payload: entry } };
  }
  const result = await sendCaptureAsImage(entry);
  if (result.ok) console.log(TAG, "screenshot sent", result.noteId);
  else console.warn(TAG, "screenshot send failed:", result.error);
  return { ok: result.ok, broadcast: { type: "h2a:capture-sent", payload: result }, error: result.error || undefined };
}

/**
 * Crop a PNG data: URL to the given CSS-pixel rectangle using
 * OffscreenCanvas (works inside a service worker since MV3 has no
 * DOM). The rect coordinates are scaled by devicePixelRatio because
 * captureVisibleTab returns the image in device pixels.
 *
 * @param {string} dataUrl
 * @param {{ x:number, y:number, width:number, height:number }} rect
 * @param {number} dpr
 * @returns {Promise<string>} PNG data URL
 */
async function cropScreenshotInWorker(dataUrl, rect, dpr) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const sx = Math.max(0, Math.round((rect.x || 0) * dpr));
  const sy = Math.max(0, Math.round((rect.y || 0) * dpr));
  const sw = Math.min(bitmap.width - sx, Math.round((rect.width || 0) * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round((rect.height || 0) * dpr));
  if (sw <= 0 || sh <= 0) throw new Error("empty region");
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close && bitmap.close();
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToDataUrl(outBlob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("reader error"));
    reader.readAsDataURL(blob);
  });
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const isBasic = info.menuItemId === MENU_ID;
    const isCloze = info.menuItemId === MENU_ID_CLOZE;
    const isReverse = info.menuItemId === MENU_ID_REVERSE;
    const isImage = info.menuItemId === MENU_ID_IMAGE;
    const isBatch = info.menuItemId === MENU_ID_BATCH;
    const isPin = info.menuItemId === MENU_ID_PIN;
    const isEdit = info.menuItemId === MENU_ID_EDIT;
    const isShot = info.menuItemId === MENU_ID_SHOT;
    if (!isBasic && !isCloze && !isReverse && !isImage && !isBatch && !isPin && !isEdit && !isShot) return;
    if (!tab || tab.id == null) return;
    if (isShot) {
      const result = await startScreenshotRegionFlow(tab);
      if (result && result.broadcast) {
        try { await chrome.runtime.sendMessage(result.broadcast); } catch (_) { /* no popup open */ }
      }
      return;
    }
    const capture = isImage
      ? captureFromImage(info, tab)
      : await requestCapture(tab.id, info.selectionText);
    if (isEdit) {
      const entry = await stagePending(capture);
      try {
        await chrome.runtime.sendMessage({ type: "h2a:capture-staged", payload: entry || capture });
      } catch (_) { /* no popup open */ }
      if (entry) {
        await openEditorWindow(entry.id);
      }
      return;
    }
    if (isPin) {
      const pinned = await addPin(capture);
      try {
        await chrome.runtime.sendMessage({ type: "h2a:pins-updated", payload: pinned });
      } catch (_) { /* no popup open */ }
      if (pinned) console.log(TAG, "pinned snippet", (capture.text || "").slice(0, 60));
      return;
    }
    if (isBatch) {
      const batchEntry = await addToBatch(capture);
      try {
        await chrome.runtime.sendMessage({ type: "h2a:batch-updated", payload: batchEntry });
      } catch (_) { /* no popup open */ }
      if (batchEntry) console.log(TAG, "queued in batch", (capture.text || "").slice(0, 60));
      return;
    }
    const entry = await stagePending(capture);
    try {
      await chrome.runtime.sendMessage({ type: "h2a:capture-staged", payload: entry || capture });
    } catch (_) { /* no popup open */ }
    const preview = isImage ? (capture.imageUrl || "").slice(0, 80) : (capture.text || "").slice(0, 60);
    console.log(TAG, "staged capture", capture.hostname || "(unknown)", preview);
    if (!entry) return;
    const settings = await loadSettings();
    if (isImage) {
      if (!settings.defaultDeck || !settings.defaultModel) return;
      const result = await sendCaptureAsImage(entry);
      try {
        await chrome.runtime.sendMessage({ type: "h2a:capture-sent", payload: result });
      } catch (_) { /* no popup open */ }
      if (result.ok) {
        console.log(TAG, "sent image note", result.noteId, "→", settings.defaultDeck);
      } else {
        console.warn(TAG, "image send failed:", result.error);
      }
      return;
    }
    if (isCloze) {
      const modelName = settings.clozeModel || settings.defaultModel;
      if (!settings.defaultDeck || !modelName) return;
      const result = await sendCaptureAsCloze(entry);
      try {
        await chrome.runtime.sendMessage({ type: "h2a:capture-sent", payload: result });
      } catch (_) { /* no popup open */ }
      if (result.ok) {
        console.log(TAG, "sent cloze note", result.noteId, "→", settings.defaultDeck);
      } else {
        console.warn(TAG, "cloze send failed:", result.error);
      }
      return;
    }
    if (isReverse) {
      if (!settings.defaultDeck || !settings.defaultModel) return;
      const result = await sendCaptureAsReverse(entry);
      try {
        await chrome.runtime.sendMessage({ type: "h2a:capture-sent", payload: result });
      } catch (_) { /* no popup open */ }
      if (result.ok) {
        console.log(TAG, "sent reverse note", result.noteId, "→", settings.defaultDeck);
      } else {
        console.warn(TAG, "reverse send failed:", result.error);
      }
      return;
    }
    if (settings.defaultDeck && settings.defaultModel) {
      const result = await sendCaptureToAnki(entry);
      try {
        await chrome.runtime.sendMessage({ type: "h2a:capture-sent", payload: result });
      } catch (_) { /* no popup open */ }
      if (result.ok) {
        console.log(TAG, "sent note", result.noteId, "→", settings.defaultDeck);
      } else {
        console.warn(TAG, "send failed:", result.error);
      }
    }
  });
}

/**
 * Handle the `send-selection` keyboard shortcut. Mirrors the basic
 * "Send to Anki" context-menu flow but skips the right-click step:
 * we grab the active tab's selection, stage it, broadcast for any
 * open popup, and (when a default deck/model is configured) send the
 * card straight to Anki. Wired to the `commands` manifest key — no
 * extra permissions required beyond `activeTab` + `scripting` which
 * are already declared.
 *
 * @param {string} command command id from chrome.commands.onCommand
 */
async function handleSendSelectionCommand(command) {
  if (command !== "send-selection") return;
  let tab;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
  } catch (err) {
    console.warn(TAG, "shortcut: tabs.query failed:", err && err.message);
    return;
  }
  if (!tab || tab.id == null) return;
  const capture = await requestCapture(tab.id);
  if (!capture || (!capture.text && !capture.imageUrl)) {
    console.log(TAG, "shortcut: no selection on active tab");
    return;
  }
  const entry = await stagePending(capture);
  try {
    await chrome.runtime.sendMessage({ type: "h2a:capture-staged", payload: entry || capture });
  } catch (_) { /* no popup open */ }
  if (!entry) return;
  const settings = await loadSettings();
  if (!settings.defaultDeck || !settings.defaultModel) {
    console.log(TAG, "shortcut: capture staged; needs default deck/model");
    return;
  }
  const result = await sendCaptureToAnki(entry);
  try {
    await chrome.runtime.sendMessage({ type: "h2a:capture-sent", payload: result });
  } catch (_) { /* no popup open */ }
  if (result.ok) {
    console.log(TAG, "shortcut: sent note", result.noteId, "→", settings.defaultDeck);
  } else {
    console.warn(TAG, "shortcut: send failed:", result.error);
  }
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    handleSendSelectionCommand(command).catch((err) => {
      console.warn(TAG, "shortcut handler error:", err && err.message);
    });
  });
}

// Lightweight message router for the popup / options UIs.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "h2a:list-pending") {
    chrome.storage.local.get(PENDING_KEY).then((store) => {
      sendResponse({ ok: true, payload: store[PENDING_KEY] || [] });
    });
    return true;
  }
  if (msg.type === "h2a:clear-pending") {
    chrome.storage.local.set({ [PENDING_KEY]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "h2a:anki-health") {
    (async () => {
      const settings = await loadSettings();
      const url = ankiUrlFromSettings(settings);
      const status = await ankiHealthCheck({ url });
      sendResponse({ ok: true, payload: status });
    })();
    return true;
  }
  if (msg.type === "h2a:test-connection") {
    (async () => {
      const payload = msg.payload || {};
      const url = buildAnkiConnectUrl(payload.ankiHost, payload.ankiPort);
      const status = await ankiHealthCheck({ url, timeoutMs: 2500 });
      sendResponse({ ok: true, payload: { ...status, url } });
    })();
    return true;
  }
  if (msg.type === "h2a:find-duplicates") {
    (async () => {
      const payload = msg.payload || {};
      try {
        const settings = await loadSettings();
        const url = ankiUrlFromSettings(settings);
        const result = await ankiFindDuplicates({ deck: payload.deck, text: payload.text, url });
        sendResponse({ ok: true, payload: result });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "h2a:list-decks") {
    (async () => {
      try {
        const settings = await loadSettings();
        const names = await ankiDeckNames({ url: ankiUrlFromSettings(settings) });
        sendResponse({ ok: true, payload: names });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "h2a:list-models") {
    (async () => {
      try {
        const settings = await loadSettings();
        const names = await ankiModelNames({ url: ankiUrlFromSettings(settings) });
        sendResponse({ ok: true, payload: names });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "h2a:get-settings") {
    loadSettings().then((settings) => sendResponse({ ok: true, payload: settings }));
    return true;
  }
  if (msg.type === "h2a:send-capture") {
    (async () => {
      const id = msg.payload && msg.payload.id;
      const store = await chrome.storage.local.get(PENDING_KEY);
      const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
      const entry = id ? list.find((e) => e && e.id === id) : list[0];
      if (!entry) {
        sendResponse({ ok: false, error: "capture not found" });
        return;
      }
      const result = await sendCaptureToAnki(entry);
      sendResponse({ ok: result.ok, payload: result, error: result.error });
    })();
    return true;
  }
  if (msg.type === "h2a:send-capture-reverse") {
    (async () => {
      const id = msg.payload && msg.payload.id;
      const store = await chrome.storage.local.get(PENDING_KEY);
      const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
      const entry = id ? list.find((e) => e && e.id === id) : list[0];
      if (!entry) {
        sendResponse({ ok: false, error: "capture not found" });
        return;
      }
      const result = await sendCaptureAsReverse(entry);
      sendResponse({ ok: result.ok, payload: result, error: result.error });
    })();
    return true;
  }
  if (msg.type === "h2a:send-capture-cloze") {
    (async () => {
      const id = msg.payload && msg.payload.id;
      const store = await chrome.storage.local.get(PENDING_KEY);
      const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
      const entry = id ? list.find((e) => e && e.id === id) : list[0];
      if (!entry) {
        sendResponse({ ok: false, error: "capture not found" });
        return;
      }
      const result = await sendCaptureAsCloze(entry);
      sendResponse({ ok: result.ok, payload: result, error: result.error });
    })();
    return true;
  }
  if (msg.type === "h2a:send-capture-image") {
    (async () => {
      const id = msg.payload && msg.payload.id;
      const store = await chrome.storage.local.get(PENDING_KEY);
      const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
      const entry = id ? list.find((e) => e && e.id === id) : list[0];
      if (!entry) {
        sendResponse({ ok: false, error: "capture not found" });
        return;
      }
      const result = await sendCaptureAsImage(entry);
      sendResponse({ ok: result.ok, payload: result, error: result.error });
    })();
    return true;
  }
  if (msg.type === "h2a:get-pending-entry") {
    (async () => {
      const id = msg.payload && msg.payload.id;
      const store = await chrome.storage.local.get(PENDING_KEY);
      const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
      const entry = id ? list.find((e) => e && e.id === id) : null;
      sendResponse({ ok: !!entry, payload: entry || null });
    })();
    return true;
  }
  if (msg.type === "h2a:open-editor") {
    (async () => {
      const id = msg.payload && msg.payload.id;
      await openEditorWindow(id);
      sendResponse({ ok: !!id });
    })();
    return true;
  }
  if (msg.type === "h2a:send-edited-capture") {
    sendEditedCapture(msg.payload || {})
      .then((result) => sendResponse({ ok: result.ok, payload: result, error: result.error }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }
  if (msg.type === "h2a:sync-status") {
    (async () => {
      const store = await chrome.storage.local.get([PENDING_KEY, HISTORY_KEY, BATCH_KEY]);
      const pending = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
      const history = Array.isArray(store[HISTORY_KEY]) ? store[HISTORY_KEY] : [];
      const batch = Array.isArray(store[BATCH_KEY]) ? store[BATCH_KEY] : [];
      const inFlight = pending.filter((e) => e && e.status === "sending").length;
      const failed = pending
        .filter((e) => e && e.status === "failed" && e.error)
        .sort((a, b) => String(b.capturedAt || "").localeCompare(String(a.capturedAt || "")))[0] || null;
      const lastSent = history[0] || null;
      const lastSyncAt = lastSent ? lastSent.sentAt : null;
      const lastError = failed ? failed.error : null;
      let state = "idle";
      if (inFlight > 0) state = "syncing";
      else if (lastError && (!lastSyncAt || (failed && String(failed.capturedAt || "") >= String(lastSyncAt)))) state = "error";
      else if (lastSyncAt) state = "synced";
      sendResponse({
        ok: true,
        payload: {
          state,
          inFlight,
          queued: batch.length,
          totalSent: history.length,
          lastSyncAt,
          lastError,
          checkedAt: new Date().toISOString(),
        },
      });
    })();
    return true;
  }
  if (msg.type === "h2a:undo-last-send") {
    (async () => {
      const payload = msg.payload || {};
      const noteId = typeof payload.noteId === "number" ? payload.noteId : Number(payload.noteId);
      if (!Number.isFinite(noteId) || noteId <= 0) {
        sendResponse({ ok: false, error: "missing noteId" });
        return;
      }
      try {
        const settings = await loadSettings();
        await ankiDeleteNotes([noteId], { url: ankiUrlFromSettings(settings) });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
        return;
      }
      // Drop the matching row from history so the UI reflects the undo.
      try {
        const store = await chrome.storage.local.get(HISTORY_KEY);
        const list = Array.isArray(store[HISTORY_KEY]) ? store[HISTORY_KEY] : [];
        const next = list.filter((row) => row && row.noteId !== noteId);
        if (next.length !== list.length) {
          await chrome.storage.local.set({ [HISTORY_KEY]: next });
          try {
            await chrome.runtime.sendMessage({ type: "h2a:history-updated", payload: { undoneNoteId: noteId } });
          } catch (_) { /* no popup open */ }
        }
      } catch (err) {
        console.warn(TAG, "undo: history cleanup failed:", err && err.message);
      }
      sendResponse({ ok: true, payload: { noteId } });
    })();
    return true;
  }
  if (msg.type === "h2a:list-history") {
    chrome.storage.local.get(HISTORY_KEY).then((store) => {
      sendResponse({ ok: true, payload: store[HISTORY_KEY] || [] });
    });
    return true;
  }
  if (msg.type === "h2a:clear-history") {
    chrome.storage.local.set({ [HISTORY_KEY]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "h2a:list-pins") {
    chrome.storage.local.get(PINS_KEY).then((store) => {
      sendResponse({ ok: true, payload: store[PINS_KEY] || [] });
    });
    return true;
  }
  if (msg.type === "h2a:remove-pin") {
    (async () => {
      const id = msg.payload && msg.payload.id;
      if (!id) { sendResponse({ ok: false, error: "missing id" }); return; }
      const store = await chrome.storage.local.get(PINS_KEY);
      const list = Array.isArray(store[PINS_KEY]) ? store[PINS_KEY] : [];
      const next = list.filter((p) => p && p.id !== id);
      await chrome.storage.local.set({ [PINS_KEY]: next });
      try { await chrome.runtime.sendMessage({ type: "h2a:pins-updated", payload: null }); } catch (_) { /* no popup */ }
      sendResponse({ ok: true, payload: next });
    })();
    return true;
  }
  if (msg.type === "h2a:clear-pins") {
    chrome.storage.local.set({ [PINS_KEY]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "h2a:pin-snippet") {
    (async () => {
      const pin = await addPin(msg.payload || {});
      try { await chrome.runtime.sendMessage({ type: "h2a:pins-updated", payload: pin }); } catch (_) { /* no popup */ }
      sendResponse({ ok: !!pin, payload: pin });
    })();
    return true;
  }
  if (msg.type === "h2a:send-pins-to-batch") {
    (async () => {
      const ids = msg.payload && Array.isArray(msg.payload.ids) ? msg.payload.ids : null;
      const result = await sendPinsToBatch(ids);
      try { await chrome.runtime.sendMessage({ type: "h2a:pins-updated", payload: null }); } catch (_) { /* no popup */ }
      try { await chrome.runtime.sendMessage({ type: "h2a:batch-updated", payload: null }); } catch (_) { /* no popup */ }
      sendResponse({ ok: true, payload: result });
    })();
    return true;
  }
  if (msg.type === "h2a:list-batch") {
    chrome.storage.local.get(BATCH_KEY).then((store) => {
      sendResponse({ ok: true, payload: store[BATCH_KEY] || [] });
    });
    return true;
  }
  if (msg.type === "h2a:clear-batch") {
    chrome.storage.local.set({ [BATCH_KEY]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "h2a:send-batch") {
    sendBatch()
      .then((result) => sendResponse({ ok: result.ok, payload: result }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }
  if (msg.type === "h2a:open-onboarding") {
    openOnboarding()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }
  if (msg.type === "h2a:onboarding-status") {
    chrome.storage.local.get(ONBOARDING_KEY).then((store) => {
      sendResponse({ ok: true, payload: store[ONBOARDING_KEY] || { completed: false } });
    });
    return true;
  }
  if (msg.type === "h2a:set-settings") {
    saveSettings(msg.payload || {})
      .then((settings) => sendResponse({ ok: true, payload: settings }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }
  return false;
});

console.log(TAG, "service worker booted");
