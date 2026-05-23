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
 * Convert a hostname into an Anki-safe tag. Anki tags cannot contain
 * whitespace and are conventionally lowercase; we also strip a leading
 * `www.` to keep tags stable across canonical/subdomain variants. The
 * tag is namespaced under `site:` so it groups cleanly in the browser.
 *
 * Returns `null` when no usable hostname is supplied so callers can
 * skip the tag entirely (e.g. local files, `about:` pages).
 *
 * @param {string|undefined|null} hostname
 * @returns {string|null}
 */
export function hostnameTag(hostname) {
  if (hostname == null) return null;
  let h = String(hostname).trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith("www.")) h = h.slice(4);
  // Anki disallows whitespace in tags; collapse any internal whitespace.
  h = h.replace(/\s+/g, "");
  // Keep only characters that are safe and meaningful in a hostname tag.
  h = h.replace(/[^a-z0-9.\-:]/g, "");
  if (!h) return null;
  return `site:${h}`;
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
 * Build cloze-deletion fields from a capture. The selection is wrapped
 * in a `{{c1::…}}` marker. When the surrounding paragraph is available
 * and contains the selection verbatim, we splice the marker into the
 * paragraph so the reader sees full context with one word hidden; the
 * standalone selection is used as a fallback. The `extra` field carries
 * the source citation, matching the standard Anki Cloze note type's
 * "Back Extra" field.
 *
 * @param {{ text?: string, paragraph?: string, url?: string, title?: string, hostname?: string }} capture
 * @returns {{ text: string, extra: string }}
 */
export function buildClozeFields(capture) {
  const cap = capture || {};
  const selection = (cap.text || "").trim();
  const paragraph = (cap.paragraph || "").trim();
  const url = (cap.url || "").trim();
  const title = (cap.title || cap.hostname || url || "source").trim();

  const safeSel = escapeHtml(selection).replace(/\n+/g, "<br>");
  const cloze = `{{c1::${safeSel}}}`;

  let text;
  if (paragraph && paragraph !== selection && selection && paragraph.includes(selection)) {
    const escPara = escapeHtml(paragraph).replace(/\n+/g, "<br>");
    const escSel = escapeHtml(selection).replace(/\n+/g, "<br>");
    // Only replace the first occurrence to keep the cloze single-target.
    const idx = escPara.indexOf(escSel);
    text = idx >= 0
      ? escPara.slice(0, idx) + cloze + escPara.slice(idx + escSel.length)
      : `${cloze}<br><br>${escPara}`;
  } else if (paragraph && paragraph !== selection) {
    text = `${cloze}<br><br>${escapeHtml(paragraph).replace(/\n+/g, "<br>")}`;
  } else {
    text = cloze;
  }

  const parts = [];
  if (url) {
    const safeUrl = escapeHtml(url);
    const safeTitle = escapeHtml(title);
    parts.push(`<p class="h2a-source"><a href="${safeUrl}">${safeTitle}</a></p>`);
  } else if (title) {
    parts.push(`<p class="h2a-source">${escapeHtml(title)}</p>`);
  }
  return { text, extra: parts.join("\n") };
}

/**
 * Build a stable, filesystem-safe filename for an image we are about
 * to upload to Anki's media collection. We prefer the original
 * basename when it carries a sensible extension so Anki renders the
 * thumbnail correctly, and prefix with `h2a-<timestamp>` to avoid
 * collisions across captures.
 *
 * @param {string} srcUrl
 * @returns {string}
 */
export function buildImageFilename(srcUrl) {
  const ts = Date.now();
  const fallback = `h2a-${ts}.img`;
  if (!srcUrl) return fallback;
  try {
    if (/^data:/i.test(srcUrl)) {
      const m = /^data:image\/([a-z0-9+.-]+)/i.exec(srcUrl);
      const ext = m && m[1] ? m[1].toLowerCase().replace("jpeg", "jpg") : "img";
      return `h2a-${ts}.${ext}`;
    }
    const u = new URL(srcUrl);
    const last = u.pathname.split("/").filter(Boolean).pop() || "image";
    const safe = last.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-64);
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)$/i.test(safe)) {
      return `h2a-${ts}-${safe}`;
    }
    return `h2a-${ts}-${safe}.img`;
  } catch (_err) {
    return fallback;
  }
}

/**
 * Build fields for an image-front card. The `front` is intentionally
 * left blank because AnkiConnect's `picture` parameter will inject an
 * `<img src="…">` tag pointing at the saved media file. The `back`
 * carries the source page citation, mirroring the text-card layout.
 *
 * @param {{ imageUrl?: string, url?: string, title?: string, hostname?: string }} capture
 * @returns {{ front: string, back: string }}
 */
export function buildImageCardFields(capture) {
  const cap = capture || {};
  const url = (cap.url || "").trim();
  const title = (cap.title || cap.hostname || url || "source").trim();
  const parts = [];
  if (url) {
    parts.push(`<p class="h2a-source"><a href="${escapeHtml(url)}">${escapeHtml(title)}</a></p>`);
  } else if (title) {
    parts.push(`<p class="h2a-source">${escapeHtml(title)}</p>`);
  }
  return { front: "", back: parts.join("\n") };
}

/**
 * Add an image-front note via AnkiConnect. The image is referenced by
 * URL; AnkiConnect itself fetches and stores it in Anki's media folder
 * under the supplied filename, then replaces the named front field
 * with the appropriate `<img>` tag. The back field carries the source
 * citation.
 *
 * @param {{ deckName: string, modelName: string, imageUrl: string, back?: string, filename?: string, tags?: string[], allowDuplicate?: boolean, frontField?: string, backField?: string, timeoutMs?: number, url?: string }} args
 * @returns {Promise<number>}
 */
export async function addImageNote(args) {
  if (!args || typeof args !== "object") throw new Error("addImageNote: missing args");
  const deckName = (args.deckName || "").trim();
  const modelName = (args.modelName || "").trim();
  const imageUrl = (args.imageUrl || "").trim();
  if (!deckName) throw new Error("addImageNote: deckName required");
  if (!modelName) throw new Error("addImageNote: modelName required");
  if (!imageUrl) throw new Error("addImageNote: imageUrl required");
  const frontField = (args.frontField || "Front").trim() || "Front";
  const backField = (args.backField || "Back").trim() || "Back";
  const filename = (args.filename && args.filename.trim()) || buildImageFilename(imageUrl);
  const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string" && t.length) : [];
  const params = {
    note: {
      deckName,
      modelName,
      fields: { [frontField]: "", [backField]: args.back || "" },
      tags,
      options: { allowDuplicate: !!args.allowDuplicate },
      picture: [{ url: imageUrl, filename, fields: [frontField] }],
    },
  };
  const result = await invoke("addNote", params, { timeoutMs: args.timeoutMs ?? 10000, url: args.url });
  const id = typeof result === "number" ? result : Number(result);
  if (!Number.isFinite(id) || id <= 0) throw new Error("addImageNote: AnkiConnect returned no note id");
  return id;
}

/**
 * Add a cloze-deletion note via AnkiConnect. Uses the standard Cloze
 * note-type fields (`Text` + `Back Extra`) by default but the caller
 * may override either. AnkiConnect rejects cloze notes that contain no
 * `{{cN::…}}` marker, so we validate that here for a clearer error.
 *
 * @param {{ deckName: string, modelName: string, text: string, extra?: string, tags?: string[], allowDuplicate?: boolean, textField?: string, extraField?: string, timeoutMs?: number, url?: string }} args
 * @returns {Promise<number>}
 */
export async function addClozeNote(args) {
  if (!args || typeof args !== "object") throw new Error("addClozeNote: missing args");
  const deckName = (args.deckName || "").trim();
  const modelName = (args.modelName || "").trim();
  if (!deckName) throw new Error("addClozeNote: deckName required");
  if (!modelName) throw new Error("addClozeNote: modelName required");
  const textField = (args.textField || "Text").trim() || "Text";
  const extraField = (args.extraField || "Back Extra").trim() || "Back Extra";
  const text = args.text || "";
  if (!/\{\{c\d+::/.test(text)) {
    throw new Error("addClozeNote: text is missing a {{cN::…}} marker");
  }
  const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string" && t.length) : [];
  const params = {
    note: {
      deckName,
      modelName,
      fields: { [textField]: text, [extraField]: args.extra || "" },
      tags,
      options: { allowDuplicate: !!args.allowDuplicate },
    },
  };
  const result = await invoke("addNote", params, { timeoutMs: args.timeoutMs, url: args.url });
  const id = typeof result === "number" ? result : Number(result);
  if (!Number.isFinite(id) || id <= 0) throw new Error("addClozeNote: AnkiConnect returned no note id");
  return id;
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
