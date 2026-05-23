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
