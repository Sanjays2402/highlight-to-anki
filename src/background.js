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
  buildCardFields,
  buildClozeFields,
  buildImageCardFields,
  hostnameTag,
} from "./anki.js";

const TAG = "[highlight-to-anki:bg]";
const MENU_ID = "h2a-send-to-anki";
const MENU_ID_CLOZE = "h2a-send-to-anki-cloze";
const MENU_ID_IMAGE = "h2a-send-image-to-anki";
const MENU_ID_BATCH = "h2a-add-to-batch";
const PENDING_KEY = "h2a:pendingCaptures";
const PENDING_LIMIT = 25;
const BATCH_KEY = "h2a:batch";
const BATCH_LIMIT = 100;
const SETTINGS_KEY = "h2a:settings";
const DEFAULT_SETTINGS = Object.freeze({
  defaultDeck: "",
  defaultModel: "",
  clozeModel: "",
  updatedAt: null,
});

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
    try {
      const noteId = await ankiAddNote({
        deckName: settings.defaultDeck,
        modelName: settings.defaultModel,
        front,
        back,
        tags,
      });
      sent += 1;
      console.log(TAG, "batch sent note", noteId);
      void noteId;
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
  try {
    const noteId = await ankiAddNote({
      deckName: settings.defaultDeck,
      modelName: settings.defaultModel,
      front,
      back,
      tags,
    });
    const patched = await patchPending(entry.id, { status: "sent", noteId, error: null, sentAt: new Date().toISOString() });
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
  try {
    const noteId = await ankiAddImageNote({
      deckName: settings.defaultDeck,
      modelName: settings.defaultModel,
      imageUrl: entry.imageUrl,
      back,
      tags,
    });
    const patched = await patchPending(entry.id, {
      status: "sent",
      mode: "image",
      noteId,
      error: null,
      sentAt: new Date().toISOString(),
    });
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
  try {
    const noteId = await ankiAddClozeNote({
      deckName: settings.defaultDeck,
      modelName,
      text,
      extra,
      tags,
    });
    const patched = await patchPending(entry.id, {
      status: "sent",
      mode: "cloze",
      noteId,
      error: null,
      sentAt: new Date().toISOString(),
    });
    return { ok: true, noteId, error: null, entry: patched || entry };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const patched = await patchPending(entry.id, { status: "failed", mode: "cloze", error: msg });
    return { ok: false, noteId: null, error: msg, entry: patched || entry };
  }
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const isBasic = info.menuItemId === MENU_ID;
    const isCloze = info.menuItemId === MENU_ID_CLOZE;
    const isImage = info.menuItemId === MENU_ID_IMAGE;
    const isBatch = info.menuItemId === MENU_ID_BATCH;
    if (!isBasic && !isCloze && !isImage && !isBatch) return;
    if (!tab || tab.id == null) return;
    const capture = isImage
      ? captureFromImage(info, tab)
      : await requestCapture(tab.id, info.selectionText);
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
