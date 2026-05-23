// Highlight to Anki — shared theme controller.
//
// Resolves the user's preferred theme (auto/dark/light) from
// chrome.storage.sync (under `h2a:settings.theme`, default `"auto"`),
// stamps `data-theme` onto <body>, and keeps every surface (popup,
// options, editor) in sync when:
//   • the setting changes (storage event), or
//   • the OS scheme changes (matchMedia event, while `auto`).
//
// Exports:
//   THEME_VALUES        — allowed values ["auto","dark","light"].
//   resolveTheme(pref)  — pure: maps a preference to "dark"|"light".
//   applyTheme(node, theme) — stamps `data-theme` on the body-like node.
//   initTheme(opts)     — wires storage + matchMedia listeners; returns
//                         { dispose, getPreference, setPreference, current }.

const SETTINGS_KEY = "h2a:settings";
export const THEME_VALUES = Object.freeze(["auto", "dark", "light"]);

/** Map a stored preference string to the concrete theme to render. */
export function resolveTheme(preference, mediaMatchesLight) {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return mediaMatchesLight ? "light" : "dark";
}

/** Stamp the concrete theme onto a body-like node. */
export function applyTheme(node, theme) {
  if (!node) return;
  node.dataset.theme = theme === "light" ? "light" : "dark";
}

/** Coerce arbitrary input to a known preference value. */
export function coercePreference(pref) {
  return THEME_VALUES.includes(pref) ? pref : "auto";
}

async function readPreferenceFromStorage() {
  try {
    const area = chrome.storage && (chrome.storage.sync || chrome.storage.local);
    if (!area) return "auto";
    const store = await area.get(SETTINGS_KEY);
    const raw = store && store[SETTINGS_KEY];
    return coercePreference(raw && raw.theme);
  } catch {
    return "auto";
  }
}

async function writePreferenceToStorage(pref) {
  const area = chrome.storage && (chrome.storage.sync || chrome.storage.local);
  if (!area) return;
  const store = await area.get(SETTINGS_KEY);
  const current = (store && store[SETTINGS_KEY]) || {};
  await area.set({
    [SETTINGS_KEY]: { ...current, theme: coercePreference(pref), updatedAt: new Date().toISOString() },
  });
}

/**
 * Initialise the theme on a body-like node. Returns a controller with
 * dispose() so callers (e.g. tests) can tear down listeners.
 */
export function initTheme(opts = {}) {
  const node = opts.node || (typeof document !== "undefined" ? document.body : null);
  const onChange = typeof opts.onChange === "function" ? opts.onChange : null;
  let preference = "auto";
  let mql = null;

  const matchesLight = () => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    if (!mql) mql = window.matchMedia("(prefers-color-scheme: light)");
    return !!mql.matches;
  };

  const render = () => {
    const theme = resolveTheme(preference, matchesLight());
    applyTheme(node, theme);
    if (onChange) onChange({ preference, theme });
  };

  // Initial paint from media query while we wait for storage.
  applyTheme(node, matchesLight() ? "light" : "dark");

  // First-paint sync from persisted preference.
  readPreferenceFromStorage().then((p) => {
    preference = p;
    render();
  });

  // Live: storage changes (other surfaces updating).
  const storageListener = (changes, areaName) => {
    if (areaName !== "sync" && areaName !== "local") return;
    const next = changes[SETTINGS_KEY];
    if (!next) return;
    const nv = (next.newValue && next.newValue.theme) || "auto";
    preference = coercePreference(nv);
    render();
  };
  try { chrome.storage.onChanged.addListener(storageListener); } catch { /* ignore */ }

  // Live: OS scheme changes (only matters in `auto`).
  let mqListener = null;
  try {
    mql = window.matchMedia("(prefers-color-scheme: light)");
    mqListener = () => { if (preference === "auto") render(); };
    if (mql.addEventListener) mql.addEventListener("change", mqListener);
    else if (mql.addListener) mql.addListener(mqListener);
  } catch { /* ignore */ }

  return {
    get current() { return resolveTheme(preference, matchesLight()); },
    getPreference() { return preference; },
    async setPreference(pref) {
      preference = coercePreference(pref);
      render();
      await writePreferenceToStorage(preference);
    },
    dispose() {
      try { chrome.storage.onChanged.removeListener(storageListener); } catch { /* ignore */ }
      try {
        if (mql && mqListener) {
          if (mql.removeEventListener) mql.removeEventListener("change", mqListener);
          else if (mql.removeListener) mql.removeListener(mqListener);
        }
      } catch { /* ignore */ }
    },
  };
}
