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
} from "./anki.js";

const TAG = "[highlight-to-anki:bg]";
const MENU_ID = "h2a-send-to-anki";
const PENDING_KEY = "h2a:pendingCaptures";
const PENDING_LIMIT = 25;
const SETTINGS_KEY = "h2a:settings";
const DEFAULT_SETTINGS = Object.freeze({
  defaultDeck: "",
  defaultModel: "",
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
  });
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
  if (!capture || !capture.text) return;
  const store = await chrome.storage.local.get(PENDING_KEY);
  const list = Array.isArray(store[PENDING_KEY]) ? store[PENDING_KEY] : [];
  list.unshift({ ...capture, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  if (list.length > PENDING_LIMIT) list.length = PENDING_LIMIT;
  await chrome.storage.local.set({ [PENDING_KEY]: list });
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    if (!tab || tab.id == null) return;
    const capture = await requestCapture(tab.id, info.selectionText);
    await stagePending(capture);
    // Broadcast to anyone listening (popup) — ignore errors when no
    // receiver is open.
    try {
      await chrome.runtime.sendMessage({ type: "h2a:capture-staged", payload: capture });
    } catch (_) { /* no popup open */ }
    console.log(TAG, "staged capture", capture.hostname || "(unknown)", capture.text.slice(0, 60));
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
  if (msg.type === "h2a:set-settings") {
    saveSettings(msg.payload || {})
      .then((settings) => sendResponse({ ok: true, payload: settings }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }
  return false;
});

console.log(TAG, "service worker booted");
