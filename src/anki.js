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
 * Resolve the AnkiConnect field-name set for a given deck. Each user
 * can register per-deck overrides in settings under `fieldTemplates`,
 * keyed by deck name; this lets, for example, a Vocabulary deck map
 * the selection to a `Word`/`Definition` pair instead of the default
 * `Front`/`Back`. Returns a fully-populated object so callers can
 * pass the result straight to {@link addNote}/{@link addClozeNote}.
 *
 * @param {{ fieldTemplates?: Record<string, {frontField?:string, backField?:string, textField?:string, extraField?:string}> }|undefined|null} settings
 * @param {string|undefined|null} deckName
 * @returns {{ frontField: string, backField: string, textField: string, extraField: string }}
 */
export function resolveFieldNames(settings, deckName) {
  const defaults = { frontField: "Front", backField: "Back", textField: "Text", extraField: "Back Extra" };
  if (!settings || !settings.fieldTemplates || !deckName) return defaults;
  const tpl = settings.fieldTemplates[deckName];
  if (!tpl || typeof tpl !== "object") return defaults;
  const pick = (val, fallback) => {
    const s = typeof val === "string" ? val.trim() : "";
    return s || fallback;
  };
  return {
    frontField: pick(tpl.frontField, defaults.frontField),
    backField: pick(tpl.backField, defaults.backField),
    textField: pick(tpl.textField, defaults.textField),
    extraField: pick(tpl.extraField, defaults.extraField),
  };
}

/**
 * Normalise a hostname for site-rule matching: lowercase, trimmed,
 * with a leading `www.` stripped so subdomain canonicals collapse to
 * the apex variant. Returns an empty string when nothing usable is
 * supplied so callers can short-circuit.
 *
 * @param {string|undefined|null} h
 * @returns {string}
 */
export function normaliseRuleHost(h) {
  if (h == null) return "";
  let s = String(h).trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("www.")) s = s.slice(4);
  return s.replace(/\s+/g, "");
}

/**
 * Resolve a per-site default deck from a list of user-configured
 * rules. Each rule is `{ hostname, deck }`. Matching prefers an exact
 * hostname hit, falling back to the longest suffix match so a rule
 * for `example.com` also picks up `blog.example.com` (but not
 * `notexample.com`). Returns the matched rule's deck name or `null`.
 *
 * @param {Array<{ hostname?: string, deck?: string }>|undefined|null} rules
 * @param {string|undefined|null} hostname
 * @returns {string|null}
 */
export function resolveSiteDeck(rules, hostname) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const host = normaliseRuleHost(hostname);
  if (!host) return null;
  let best = null;
  let bestLen = -1;
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const ruleHost = normaliseRuleHost(rule.hostname);
    const deck = typeof rule.deck === "string" ? rule.deck.trim() : "";
    if (!ruleHost || !deck) continue;
    if (host === ruleHost) return deck;
    if (host.endsWith(`.${ruleHost}`) && ruleHost.length > bestLen) {
      best = deck;
      bestLen = ruleHost.length;
    }
  }
  return best;
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
 * Build an AnkiConnect search query that matches notes likely to be
 * duplicates of a given selection. We scope the search to a single
 * deck (when supplied) and look for the selection text appearing in
 * any field. The selection is truncated to a reasonable length so the
 * query stays well below AnkiConnect's request size limits and we
 * strip newlines/quotes that would otherwise break the search syntax.
 *
 * Returns an empty string when there is no meaningful text to search
 * for so callers can short-circuit the round-trip.
 *
 * @param {{ deck?: string, text?: string }} args
 * @returns {string}
 */
export function buildDuplicateQuery(args) {
  const a = args || {};
  const raw = String(a.text == null ? "" : a.text);
  // Anki's full-text search treats quotes specially. Collapse whitespace
  // and drop characters that have no meaning inside a quoted phrase.
  const cleaned = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/["\\]+/g, "")
    .trim();
  if (cleaned.length < 4) return "";
  // Cap at 96 chars — long enough to be specific, short enough to avoid
  // 414-style failures and keep the query snappy on big collections.
  const phrase = cleaned.length > 96 ? cleaned.slice(0, 96) : cleaned;
  const deck = (a.deck || "").trim();
  const parts = [];
  if (deck) {
    const safeDeck = deck.replace(/["\\]+/g, "");
    parts.push(`deck:"${safeDeck}"`);
  }
  parts.push(`"${phrase}"`);
  return parts.join(" ");
}

/**
 * Run an AnkiConnect `findNotes` query. Returns an array of note ids
 * (possibly empty). Throws on malformed payload so the caller surfaces
 * a clear error to the UI.
 *
 * @param {string} query
 * @param {{ timeoutMs?: number, url?: string }=} opts
 * @returns {Promise<number[]>}
 */
export async function findNotes(query, opts = {}) {
  const q = String(query == null ? "" : query).trim();
  if (!q) return [];
  const result = await invoke("findNotes", { query: q }, opts);
  if (!Array.isArray(result)) throw new Error("findNotes: unexpected payload");
  return result.filter((n) => Number.isFinite(n));
}

/**
 * Convenience: search Anki for notes likely to duplicate the supplied
 * selection. Returns a structured payload the UI can render directly,
 * including the actual query used so debugging is easier.
 *
 * @param {{ deck?: string, text?: string, timeoutMs?: number, url?: string }} args
 * @returns {Promise<{ query: string, noteIds: number[], count: number }>}
 */
export async function findDuplicates(args) {
  const a = args || {};
  const query = buildDuplicateQuery({ deck: a.deck, text: a.text });
  if (!query) return { query: "", noteIds: [], count: 0 };
  const noteIds = await findNotes(query, { timeoutMs: a.timeoutMs, url: a.url });
  return { query, noteIds, count: noteIds.length };
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
