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
  findDuplicates as ankiFindDuplicates,
  buildCardFields,
  buildClozeFields,
  buildImageCardFields,
  hostnameTag,
  resolveFieldNames,
  resolveSiteDeck,
} from "./anki.js";

const TAG = "[highlight-to-anki:bg]";
const MENU_ID = "h2a-send-to-anki";
const MENU_ID_CLOZE = "h2a-send-to-anki-cloze";
const MENU_ID_IMAGE = "h2a-send-image-to-anki";
const MENU_ID_BATCH = "h2a-add-to-batch";
const MENU_ID_EDIT = "h2a-edit-and-send";
const PENDING_KEY = "h2a:pendingCaptures";
const PENDING_LIMIT = 25;
const BATCH_KEY = "h2a:batch";
const BATCH_LIMIT = 100;
const HISTORY_KEY = "h2a:history";
const HISTORY_LIMIT = 50;
const SETTINGS_KEY = "h2a:settings";
const DEFAULT_SETTINGS = Object.freeze({
  defaultDeck: "",
  defaultModel: "",
  clozeModel: "",
  fieldTemplates: {},
  siteRules: [],
  theme: "auto",
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
    siteRules: patch.siteRules !== undefined
      ? sanitiseSiteRules(patch.siteRules)
      : (Array.isArray(current.siteRules) ? current.siteRules : []),
    theme: THEME_PREFERENCES.has(patch.theme) ? patch.theme : (current.theme || "auto"),
    updatedAt: new Date().toISOString(),
  };
  await area.set({ [SETTINGS_KEY]: next });
  return next;
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
        id: MENU_ID_BATCH,
        title: "Add to Batch",
        contexts: ["selection"],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn(TAG, "batch menu create error:", err.message);
      },
    );
  });
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
    const tags = siteTag
      ? ["highlight-to-anki", "batch", siteTag]
      : ["highlight-to-anki", "batch"];
    const batchDeck = resolveSiteDeck(siteRules, entry.hostname) || settings.defaultDeck;
    try {
      const batchFields = resolveFieldNames(settings, batchDeck);
      const noteId = await ankiAddNote({
        deckName: batchDeck,
        modelName: settings.defaultModel,
        front,
        back,
        tags,
        frontField: batchFields.frontField,
        backField: batchFields.backField,
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

chrome.runtime.onInstalled.addListener(() => {
  console.log(TAG, "installed");
  ensureMenu();
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
  const tags = siteTag ? ["highlight-to-anki", siteTag] : ["highlight-to-anki"];
  const targetDeck = resolveSiteDeck(settings.siteRules, entry.hostname) || settings.defaultDeck;
  const fields = resolveFieldNames(settings, targetDeck);
  try {
    const noteId = await ankiAddNote({
      deckName: targetDeck,
      modelName: settings.defaultModel,
      front,
      back,
      tags,
      frontField: fields.frontField,
      backField: fields.backField,
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
  const tags = siteTag
    ? ["highlight-to-anki", "image", siteTag]
    : ["highlight-to-anki", "image"];
  const imgTargetDeck = resolveSiteDeck(settings.siteRules, entry.hostname) || settings.defaultDeck;
  const imgFields = resolveFieldNames(settings, imgTargetDeck);
  try {
    const noteId = await ankiAddImageNote({
      deckName: imgTargetDeck,
      modelName: settings.defaultModel,
      imageUrl: entry.imageUrl,
      back,
      tags,
      frontField: imgFields.frontField,
      backField: imgFields.backField,
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
  const tags = siteTag
    ? ["highlight-to-anki", "cloze", siteTag]
    : ["highlight-to-anki", "cloze"];
  const clozeTargetDeck = resolveSiteDeck(settings.siteRules, entry.hostname) || settings.defaultDeck;
  const clozeFields = resolveFieldNames(settings, clozeTargetDeck);
  try {
    const noteId = await ankiAddClozeNote({
      deckName: clozeTargetDeck,
      modelName,
      text,
      extra,
      tags,
      textField: clozeFields.textField,
      extraField: clozeFields.extraField,
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
        if (mode === "cloze") t.push("cloze");
        return t;
      })();
  await patchPending(entry.id, { status: "sending", mode, error: null });
  const settings = await loadSettings();
  const editFields = resolveFieldNames(settings, deckName);
  try {
    let noteId;
    if (mode === "cloze") {
      noteId = await ankiAddClozeNote({
        deckName,
        modelName,
        text: edits.text || "",
        extra: edits.extra || "",
        tags: baseTags,
        textField: editFields.textField,
        extraField: editFields.extraField,
      });
    } else {
      noteId = await ankiAddNote({
        deckName,
        modelName,
        front: edits.front || "",
        back: edits.back || "",
        tags: baseTags,
        frontField: editFields.frontField,
        backField: editFields.backField,
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

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const isBasic = info.menuItemId === MENU_ID;
    const isCloze = info.menuItemId === MENU_ID_CLOZE;
    const isImage = info.menuItemId === MENU_ID_IMAGE;
    const isBatch = info.menuItemId === MENU_ID_BATCH;
    const isEdit = info.menuItemId === MENU_ID_EDIT;
    if (!isBasic && !isCloze && !isImage && !isBatch && !isEdit) return;
    if (!tab || tab.id == null) return;
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
    ankiHealthCheck().then((status) => sendResponse({ ok: true, payload: status }));
    return true;
  }
  if (msg.type === "h2a:find-duplicates") {
    (async () => {
      const payload = msg.payload || {};
      try {
        const result = await ankiFindDuplicates({ deck: payload.deck, text: payload.text });
        sendResponse({ ok: true, payload: result });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "h2a:list-decks") {
    ankiDeckNames()
      .then((names) => sendResponse({ ok: true, payload: names }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }
  if (msg.type === "h2a:list-models") {
    ankiModelNames()
      .then((names) => sendResponse({ ok: true, payload: names }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
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
  if (msg.type === "h2a:set-settings") {
    saveSettings(msg.payload || {})
      .then((settings) => sendResponse({ ok: true, payload: settings }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }
  return false;
});

console.log(TAG, "service worker booted");
