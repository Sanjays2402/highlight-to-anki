// Highlight to Anki — AnkiConnect client.
//
// Thin wrapper around the AnkiConnect HTTP API exposed by the Anki
// desktop add-on (https://foosoft.net/projects/anki-connect). All
// traffic is local-only via http://127.0.0.1:8765, which is the host
// permission declared in the manifest.

export const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
export const ANKI_CONNECT_VERSION = 6;
const DEFAULT_TIMEOUT_MS = 2500;

/**
 * Invoke an AnkiConnect action. Resolves with the unwrapped `result`
 * on success and rejects with a descriptive Error otherwise. Caller is
 * responsible for handling network-unreachable rejections (Anki not
 * running, add-on disabled, firewall, …) — those will throw `TypeError`
 * from `fetch` which we re-wrap below.
 *
 * @param {string} action
 * @param {Record<string, unknown>=} params
 * @param {{ timeoutMs?: number, url?: string }=} opts
 * @returns {Promise<unknown>}
 */
export async function invoke(action, params = {}, opts = {}) {
  const url = opts.url || ANKI_CONNECT_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new Error(`AnkiConnect timed out after ${timeoutMs}ms`);
    }
    throw new Error(`AnkiConnect unreachable: ${err && err.message ? err.message : "network error"}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`AnkiConnect HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new Error("AnkiConnect returned malformed JSON");
  }
  if (body.error) {
    throw new Error(`AnkiConnect: ${body.error}`);
  }
  return body.result;
}

/**
 * Escape a string for safe inclusion as HTML text content. Anki notes
 * store fields as HTML, so any selection coming from the page must be
 * neutralised before being interpolated into a field template.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the `{ front, back }` field payload for a basic note from a
 * capture snapshot. Front is the raw selection text; back is the
 * surrounding paragraph (when available) plus a linked citation back
 * to the source page. Both sides are HTML-safe.
 *
 * @param {{ text?: string, paragraph?: string, url?: string, title?: string, hostname?: string }} capture
 * @returns {{ front: string, back: string }}
 */
export function buildCardFields(capture) {
  const cap = capture || {};
  const text = (cap.text || "").trim();
  const paragraph = (cap.paragraph || "").trim();
  const url = (cap.url || "").trim();
  const title = (cap.title || cap.hostname || url || "source").trim();

  const front = escapeHtml(text).replace(/\n+/g, "<br>");

  const parts = [];
  if (paragraph && paragraph !== text) {
    parts.push(`<blockquote class="h2a-context">${escapeHtml(paragraph).replace(/\n+/g, "<br>")}</blockquote>`);
  }
  if (url) {
    const safeUrl = escapeHtml(url);
    const safeTitle = escapeHtml(title);
    parts.push(`<p class="h2a-source"><a href="${safeUrl}">${safeTitle}</a></p>`);
  } else if (title) {
    parts.push(`<p class="h2a-source">${escapeHtml(title)}</p>`);
  }
  return { front, back: parts.join("\n") };
}

/**
 * Add a basic note to Anki via AnkiConnect. Returns the created note
 * id on success. Caller decides whether to surface failure to the UI.
 *
 * @param {{ deckName: string, modelName: string, front: string, back: string, tags?: string[], allowDuplicate?: boolean, frontField?: string, backField?: string, timeoutMs?: number, url?: string }} args
 * @returns {Promise<number>}
 */
export async function addNote(args) {
  if (!args || typeof args !== "object") throw new Error("addNote: missing args");
  const deckName = (args.deckName || "").trim();
  const modelName = (args.modelName || "").trim();
  if (!deckName) throw new Error("addNote: deckName required");
  if (!modelName) throw new Error("addNote: modelName required");
  const frontField = (args.frontField || "Front").trim() || "Front";
  const backField = (args.backField || "Back").trim() || "Back";
  const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string" && t.length) : [];
  const params = {
    note: {
      deckName,
      modelName,
      fields: { [frontField]: args.front || "", [backField]: args.back || "" },
      tags,
      options: { allowDuplicate: !!args.allowDuplicate },
    },
  };
  const result = await invoke("addNote", params, { timeoutMs: args.timeoutMs, url: args.url });
  const id = typeof result === "number" ? result : Number(result);
  if (!Number.isFinite(id) || id <= 0) throw new Error("addNote: AnkiConnect returned no note id");
  return id;
}

/**
 * Fetch the list of deck names from AnkiConnect.
 * @param {{ timeoutMs?: number, url?: string }=} opts
 * @returns {Promise<string[]>}
 */
export async function deckNames(opts = {}) {
  const result = await invoke("deckNames", {}, opts);
  if (!Array.isArray(result)) throw new Error("deckNames: unexpected payload");
  return result.filter((s) => typeof s === "string");
}

/**
 * Fetch the list of note/model names from AnkiConnect.
 * @param {{ timeoutMs?: number, url?: string }=} opts
 * @returns {Promise<string[]>}
 */
export async function modelNames(opts = {}) {
  const result = await invoke("modelNames", {}, opts);
  if (!Array.isArray(result)) throw new Error("modelNames: unexpected payload");
  return result.filter((s) => typeof s === "string");
}

/**
 * Lightweight health probe. Returns a structured status object the UI
 * can render without further branching.
 *
 * @param {{ timeoutMs?: number, url?: string }=} opts
 * @returns {Promise<{ ok: boolean, version: number|null, error: string|null, url: string, checkedAt: string }>}
 */
export async function healthCheck(opts = {}) {
  const url = opts.url || ANKI_CONNECT_URL;
  const checkedAt = new Date().toISOString();
  try {
    const version = await invoke("version", {}, opts);
    const v = typeof version === "number" ? version : Number(version);
    if (!Number.isFinite(v)) {
      return { ok: false, version: null, error: "Unexpected version payload", url, checkedAt };
    }
    return { ok: true, version: v, error: null, url, checkedAt };
  } catch (err) {
    return {
      ok: false,
      version: null,
      error: err && err.message ? err.message : "Unknown error",
      url,
      checkedAt,
    };
  }
}
