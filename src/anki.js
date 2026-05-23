// Highlight to Anki — AnkiConnect client.
//
// Thin wrapper around the AnkiConnect HTTP API exposed by the Anki
// desktop add-on (https://foosoft.net/projects/anki-connect). All
// traffic is local-only via http://127.0.0.1:8765, which is the host
// permission declared in the manifest.

export const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
export const ANKI_CONNECT_VERSION = 6;
export const DEFAULT_ANKI_HOST = "127.0.0.1";
export const DEFAULT_ANKI_PORT = 8765;

/**
 * Normalise a user-supplied AnkiConnect host. Strips whitespace, any
 * surrounding `http(s)://` scheme, a trailing slash, and an explicit
 * `:port` suffix so the host can be recombined cleanly with the port
 * value managed alongside it. Returns `""` when nothing usable was
 * supplied so callers can fall back to {@link DEFAULT_ANKI_HOST}.
 *
 * @param {string|undefined|null} raw
 * @returns {string}
 */
export function normaliseAnkiHost(raw) {
  if (raw == null) return "";
  let h = String(raw).trim();
  if (!h) return "";
  h = h.replace(/^https?:\/\//i, "");
  // Drop any trailing path/query so we only retain the host portion.
  h = h.split("/")[0].split("?")[0];
  // Trim a trailing `:port` so the port input is the single source of
  // truth; callers can still pass a port separately.
  h = h.replace(/:\d+$/, "");
  return h.toLowerCase();
}

/**
 * Coerce a port value to an integer in the valid TCP range. Returns
 * `null` when the input is missing or out of bounds so callers can
 * fall back to {@link DEFAULT_ANKI_PORT}.
 *
 * @param {number|string|undefined|null} raw
 * @returns {number|null}
 */
export function normaliseAnkiPort(raw) {
  if (raw === "" || raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 1 || i > 65535) return null;
  return i;
}

/**
 * Build the full AnkiConnect endpoint URL from a host + port pair.
 * Falls back to the documented defaults when either side is missing
 * or invalid so a single empty field never bricks the extension.
 *
 * @param {string|undefined|null} host
 * @param {number|string|undefined|null} port
 * @returns {string}
 */
export function buildAnkiConnectUrl(host, port) {
  const h = normaliseAnkiHost(host) || DEFAULT_ANKI_HOST;
  const p = normaliseAnkiPort(port) ?? DEFAULT_ANKI_PORT;
  return `http://${h}:${p}`;
}
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

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

// Stopword frequency tables for the Latin-alphabet languages we
// distinguish. Kept short on purpose: these are the highest-signal
// function words in each tongue and they're enough to disambiguate
// short selections (a paragraph or two) without pulling in a real NLP
// dependency. Lower-case, deduplicated, no diacritics required.
const LATIN_STOPWORDS = {
  en: ["the","and","that","have","for","not","with","you","this","but","his","from","they","she","will","would","there","their","what","about","which","when","your","can","said","each","been","were","are","was","has","had"],
  es: ["que","de","no","la","el","en","y","a","los","se","del","las","un","por","con","una","su","para","es","al","lo","como","mas","pero","sus","le","ya","o","este","si","porque","esta","entre","cuando","muy","sin","sobre","tambien"],
  fr: ["le","de","un","et","etre","avoir","que","pour","dans","ce","il","qui","ne","sur","se","pas","plus","par","avec","tout","faire","son","mais","ou","comme","nous","vous","leur","bien","sans","sous","meme","deja","alors","des","les","une","est","sont","cette","aussi"],
  de: ["der","die","und","in","den","von","zu","das","mit","sich","des","auf","fur","ist","im","dem","nicht","ein","eine","als","auch","es","an","werden","aus","er","hat","dass","sie","nach","wird","bei","einer","um","am","sind","noch","wie","einem","uber"],
  it: ["di","e","il","la","che","un","per","non","in","una","sono","si","con","come","le","piu","ma","se","lo","ho","ha","al","da","alla","questo","questa","loro","anche","quando","tutti","essere","fare","degli","della","dei","delle"],
  pt: ["de","a","o","que","e","do","da","em","um","para","com","nao","uma","os","no","se","na","por","mais","as","dos","como","mas","foi","ao","ele","das","tem","a","seu","sua","ou","quando","muito","nos","ja","eu"],
  nl: ["de","en","het","van","een","dat","is","in","op","te","voor","met","die","zijn","niet","aan","er","als","maar","ook","wij","door","deze","wel","zou","naar","of","uit","bij","nog"],
};

// Build a fast lookup once at module load.
const LATIN_STOPWORD_SETS = (() => {
  const out = {};
  for (const code of Object.keys(LATIN_STOPWORDS)) {
    out[code] = new Set(LATIN_STOPWORDS[code]);
  }
  return out;
})();

/**
 * Strip combining diacritical marks so frequency lookups can ignore
 * accents (`prèsentes` → `presentes`). NFD then drop U+0300-U+036F.
 * @param {string} s
 * @returns {string}
 */
function stripDiacritics(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Detect the dominant natural language of a text selection. Returns
 * an ISO 639-1 code (`"en"`, `"es"`, `"ja"`, …) or `null` when the
 * input is empty or no script signal can be extracted. The detector
 * is deliberately small and fully deterministic:
 *
 *   1. **Script-first.** Walk the codepoints once and count how many
 *      fall into each Unicode block we care about (CJK ideographs,
 *      Hiragana, Katakana, Hangul, Cyrillic, Arabic, Hebrew,
 *      Devanagari, Greek, Thai). The script with the most hits wins
 *      outright when it accounts for at least 30% of letter chars.
 *      Japanese is preferred over Chinese when *any* Hiragana or
 *      Katakana appears, since CJK ideographs are shared between the
 *      two and kana are the distinguishing signal.
 *   2. **Latin fallback.** When the script signal is Latin we score
 *      the text against a tiny stopword table (en / es / fr / de /
 *      it / pt / nl) and return the language with the highest match
 *      count. Ties resolve in favour of English so we don't flap
 *      between near-matches on three-word selections.
 *
 * @param {string|undefined|null} text
 * @returns {string|null}
 */
export function detectLanguage(text) {
  if (text == null) return null;
  const raw = String(text);
  if (!raw.trim()) return null;
  // Script tallies.
  let han = 0, hira = 0, kata = 0, hangul = 0;
  let cyrillic = 0, arabic = 0, hebrew = 0, devanagari = 0;
  let greek = 0, thai = 0, latin = 0;
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    if ((cp >= 0x3040 && cp <= 0x309f)) hira++;
    else if ((cp >= 0x30a0 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) kata++;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) hangul++;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) han++;
    else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic++;
    else if (cp >= 0x0600 && cp <= 0x06ff) arabic++;
    else if (cp >= 0x0590 && cp <= 0x05ff) hebrew++;
    else if (cp >= 0x0900 && cp <= 0x097f) devanagari++;
    else if (cp >= 0x0370 && cp <= 0x03ff) greek++;
    else if (cp >= 0x0e00 && cp <= 0x0e7f) thai++;
    else if ((cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a) || (cp >= 0x00c0 && cp <= 0x024f)) latin++;
  }
  const letters = han + hira + kata + hangul + cyrillic + arabic + hebrew + devanagari + greek + thai + latin;
  if (letters === 0) return null;
  // Japanese wins as soon as kana is present, even if CJK ideographs
  // dominate the count — kana are the disambiguator.
  if (hira + kata >= 1 && (hira + kata + han) / letters >= 0.3) return "ja";
  if (hangul / letters >= 0.3) return "ko";
  if (han / letters >= 0.3) return "zh";
  if (arabic / letters >= 0.3) return "ar";
  if (hebrew / letters >= 0.3) return "he";
  if (devanagari / letters >= 0.3) return "hi";
  if (cyrillic / letters >= 0.3) return "ru";
  if (greek / letters >= 0.3) return "el";
  if (thai / letters >= 0.3) return "th";
  if (latin / letters < 0.3) return null;
  // Latin: score against tiny stopword frequency tables.
  const tokens = stripDiacritics(raw.toLowerCase()).match(/[a-z]+/g) || [];
  if (!tokens.length) return null;
  const scores = { en: 0, es: 0, fr: 0, de: 0, it: 0, pt: 0, nl: 0 };
  for (const tok of tokens) {
    for (const code of Object.keys(scores)) {
      if (LATIN_STOPWORD_SETS[code].has(tok)) scores[code]++;
    }
  }
  let best = "en", bestScore = -1;
  // Iterate in a stable order so ties resolve deterministically; en
  // first so it wins on ties (most highlight-to-anki users read EN).
  for (const code of ["en","es","fr","de","it","pt","nl"]) {
    if (scores[code] > bestScore) { best = code; bestScore = scores[code]; }
  }
  // If nothing matched at all, only assert English when we have a
  // meaningful number of Latin tokens; otherwise return null so the
  // caller can skip the tag.
  if (bestScore === 0 && tokens.length < 4) return null;
  return best;
}

/**
 * Render a language code as an Anki tag. Returns `null` when the
 * input is missing so callers can `if (tag) tags.push(tag)` without
 * branching twice.
 *
 * @param {string|undefined|null} code
 * @returns {string|null}
 */
export function languageTag(code) {
  if (!code) return null;
  const c = String(code).trim().toLowerCase();
  if (!/^[a-z]{2,3}$/.test(c)) return null;
  return `lang:${c}`;
}

/**
 * Render a small, safe subset of inline Markdown into HTML. The
 * input MUST already be HTML-escaped (e.g. via {@link escapeHtml}); we
 * only convert the three formatting forms users routinely care about
 * when shipping selections to Anki:
 *
 *   - `**bold**` / `__bold__`     → `<strong>…</strong>`
 *   - `*italic*` / `_italic_`     → `<em>…</em>`
 *   - `` `code` ``                → `<code>…</code>`
 *
 * Code spans are tokenised first so any `*` / `_` inside them stay
 * literal. Emphasis matchers are bounded with non-word lookarounds so
 * an asterisk that's actually punctuation (e.g. `foo*`) is left
 * alone. The function is deliberately conservative — multi-line
 * blocks, links, lists, and headings are out of scope.
 *
 * @param {string} escapedHtml HTML-escaped source text.
 * @returns {string} HTML with inline-markdown spans applied.
 */
export function renderInlineMarkdown(escapedHtml) {
  if (escapedHtml == null) return "";
  let s = String(escapedHtml);
  // 1. Pull code spans out so their contents are immune to the
  //    bold/italic passes below.
  const codes = [];
  s = s.replace(/`([^`\n]+?)`/g, (_m, body) => {
    const idx = codes.length;
    codes.push(body);
    return `\u0000H2A_CODE_${idx}\u0000`;
  });
  // 2. Bold (greedy markers first so `**` doesn't get eaten by `*`).
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^_])__([^_\n]+?)__(?!_)/g, "$1<strong>$2</strong>");
  // 3. Italic. Require a non-`*`/`_` neighbour so we don't break
  //    snippets like `a**b**c` or words containing underscores.
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");
  // 4. Restore code spans.
  s = s.replace(/\u0000H2A_CODE_(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
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
 * Resolve the user-configured CSS for a given deck, if any. Returns
 * an empty string when no override exists so callers can short-circuit
 * cheaply. Whitespace-only entries are treated as empty.
 *
 * @param {{ deckStyles?: Record<string, string> }|undefined|null} settings
 * @param {string|undefined|null} deckName
 * @returns {string}
 */
export function resolveDeckCss(settings, deckName) {
  if (!settings || !settings.deckStyles || !deckName) return "";
  const raw = settings.deckStyles[deckName];
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  return trimmed;
}

/**
 * Build an inline `<style>` block carrying user-supplied CSS for a
 * single card. Anki renders fields as HTML and honours embedded
 * `<style>` tags at display time, which gives us per-deck styling
 * without needing to call AnkiConnect's `updateModelStyling` (which
 * is model-scoped, not deck-scoped, and would clobber other users of
 * the same note type).
 *
 * The CSS is HTML-escaped defensively and any `</style>` sequence is
 * neutralised so a misbehaving rule cannot break out of the block.
 * Returns `""` when no CSS is supplied so callers can concatenate the
 * result unconditionally.
 *
 * @param {string|undefined|null} css
 * @returns {string}
 */
export function buildStyleBlock(css) {
  if (css == null) return "";
  const raw = String(css).trim();
  if (!raw) return "";
  // Defang `</style>` (case-insensitive). Anki's renderer is lenient
  // but a stray closer would terminate the block early and leak the
  // remainder as visible text on the card.
  const safe = raw.replace(/<\s*\/\s*style\s*>/gi, "&lt;/style&gt;");
  return `<style class="h2a-deck-css">${safe}</style>`;
}

/**
 * Prepend a `<style>` block carrying `css` to an HTML field payload.
 * No-ops when `css` is empty so existing callers stay clean.
 *
 * @param {string} html
 * @param {string|undefined|null} css
 * @returns {string}
 */
export function applyDeckStyles(html, css) {
  const block = buildStyleBlock(css);
  if (!block) return html == null ? "" : String(html);
  return `${block}${html == null ? "" : String(html)}`;
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

  const front = renderInlineMarkdown(escapeHtml(text)).replace(/\n+/g, "<br>");

  const parts = [];
  if (paragraph && paragraph !== text) {
    parts.push(`<blockquote class="h2a-context">${renderInlineMarkdown(escapeHtml(paragraph)).replace(/\n+/g, "<br>")}</blockquote>`);
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

  const safeSel = renderInlineMarkdown(escapeHtml(selection)).replace(/\n+/g, "<br>");
  const cloze = `{{c1::${safeSel}}}`;

  let text;
  if (paragraph && paragraph !== selection && selection && paragraph.includes(selection)) {
    // Splice the cloze marker into the paragraph at the position of the
    // selection. We do the splice on the *escaped* paragraph (no
    // markdown yet) so we can locate the selection cleanly, then run
    // markdown over the surrounding context — masking the cloze marker
    // so its `*`/`_` neighbours can't trigger emphasis matchers.
    const escPara = escapeHtml(paragraph).replace(/\n+/g, "<br>");
    const escSel = escapeHtml(selection).replace(/\n+/g, "<br>");
    const idx = escPara.indexOf(escSel);
    if (idx >= 0) {
      const MARK = "\u0000H2A_CLOZE\u0000";
      const spliced = escPara.slice(0, idx) + MARK + escPara.slice(idx + escSel.length);
      text = renderInlineMarkdown(spliced).replace(MARK, cloze);
    } else {
      text = `${cloze}<br><br>${renderInlineMarkdown(escPara)}`;
    }
  } else if (paragraph && paragraph !== selection) {
    text = `${cloze}<br><br>${renderInlineMarkdown(escapeHtml(paragraph)).replace(/\n+/g, "<br>")}`;
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
 * Build reverse-card fields from a capture. Where the basic card asks
 * the user to recall the *context* given the selection, a reverse card
 * flips the prompt: the surrounding paragraph (with the highlighted
 * selection blanked out) becomes the front, and the selection itself
 * — the term you're trying to recall — becomes the back, alongside
 * the usual source citation.
 *
 * When no surrounding paragraph is available we fall back to using
 * the page title (or hostname) as the prompt so the card still has a
 * meaningful question rather than a blank front.
 *
 * @param {{ text?: string, paragraph?: string, url?: string, title?: string, hostname?: string }} capture
 * @returns {{ front: string, back: string }}
 */
export function buildReverseCardFields(capture) {
  const cap = capture || {};
  const selection = (cap.text || "").trim();
  const paragraph = (cap.paragraph || "").trim();
  const url = (cap.url || "").trim();
  const title = (cap.title || cap.hostname || url || "source").trim();

  const BLANK = '<span class="h2a-blank">_____</span>';
  let front;
  if (paragraph && selection && paragraph !== selection && paragraph.includes(selection)) {
    const escPara = escapeHtml(paragraph).replace(/\n+/g, "<br>");
    const escSel = escapeHtml(selection).replace(/\n+/g, "<br>");
    const idx = escPara.indexOf(escSel);
    const MARK = "\u0000H2A_BLANK\u0000";
    const spliced = escPara.slice(0, idx) + MARK + escPara.slice(idx + escSel.length);
    front = renderInlineMarkdown(spliced).replace(MARK, BLANK);
  } else if (paragraph && paragraph !== selection) {
    front = renderInlineMarkdown(escapeHtml(paragraph)).replace(/\n+/g, "<br>")
      + `<br><br>${BLANK}`;
  } else {
    front = `<p class="h2a-prompt">From: ${escapeHtml(title)}</p>${BLANK}`;
  }

  const answer = renderInlineMarkdown(escapeHtml(selection)).replace(/\n+/g, "<br>");
  const parts = [`<p class="h2a-answer">${answer}</p>`];
  if (url) {
    parts.push(`<p class="h2a-source"><a href="${escapeHtml(url)}">${escapeHtml(title)}</a></p>`);
  } else if (title) {
    parts.push(`<p class="h2a-source">${escapeHtml(title)}</p>`);
  }
  return { front, back: parts.join("\n") };
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
  // AnkiConnect supports either `url` (http(s)) or `data` (base64) for
  // picture attachments. Data URLs (used by screenshot captures) cannot
  // be fetched server-side so we split them and ship the base64 payload
  // directly.
  let picture;
  const dataMatch = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(imageUrl);
  if (dataMatch) {
    picture = [{ data: dataMatch[2], filename, fields: [frontField] }];
  } else {
    picture = [{ url: imageUrl, filename, fields: [frontField] }];
  }
  const params = {
    note: {
      deckName,
      modelName,
      fields: { [frontField]: "", [backField]: args.back || "" },
      tags,
      options: { allowDuplicate: !!args.allowDuplicate },
      picture,
    },
  };
  const result = await invoke("addNote", params, { timeoutMs: args.timeoutMs ?? 15000, url: args.url });
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
 * Delete one or more notes (and their cards) from Anki via
 * AnkiConnect. Used by the popup's toast Undo affordance so a card
 * sent in error can be retracted with one click. Returns the array
 * of ids that were submitted for deletion so the caller can confirm
 * the operation against its own bookkeeping; AnkiConnect itself
 * returns `null` on success.
 *
 * @param {Array<number|string>} noteIds
 * @param {{ timeoutMs?: number, url?: string }=} opts
 * @returns {Promise<number[]>}
 */
export async function deleteNotes(noteIds, opts = {}) {
  const list = Array.isArray(noteIds) ? noteIds : [];
  const ids = list
    .map((n) => (typeof n === "number" ? n : Number(n)))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return [];
  await invoke("deleteNotes", { notes: ids }, opts);
  return ids;
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
