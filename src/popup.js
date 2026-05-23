// Highlight to Anki — popup entry point.
//
// On open, asks the background service worker to probe AnkiConnect and
// renders the result into the health card. The pill animates between
// checking → ok / bad. All state changes go through `renderHealth()`
// so the DOM stays in sync.

const TAG = "[highlight-to-anki:popup]";

const els = {
  pill: document.getElementById("health-pill"),
  pillText: document.querySelector("#health-pill .pill-text"),
  endpoint: document.getElementById("health-endpoint"),
  version: document.getElementById("health-version"),
  errorRow: document.getElementById("health-error-row"),
  error: document.getElementById("health-error"),
  checked: document.getElementById("health-checked"),
  refresh: document.getElementById("health-refresh"),
  settings: document.getElementById("settings-btn"),
};

function setPill(state, label) {
  if (!els.pill) return;
  els.pill.dataset.state = state;
  if (els.pillText) els.pillText.textContent = label;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function renderHealth(status) {
  if (!status) {
    setPill("checking", "Checking…");
    return;
  }
  if (els.endpoint && status.url) els.endpoint.textContent = status.url;
  els.checked.textContent = fmtTime(status.checkedAt);
  if (status.ok) {
    setPill("ok", "Connected");
    els.version.textContent = `v${status.version}`;
    els.errorRow.hidden = true;
    els.error.textContent = "—";
  } else {
    setPill("bad", "Offline");
    els.version.textContent = "—";
    els.errorRow.hidden = false;
    els.error.textContent = status.error || "Unknown error";
  }
}

async function checkHealth() {
  setPill("checking", "Checking…");
  if (els.errorRow) els.errorRow.hidden = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:anki-health" });
    if (reply && reply.ok && reply.payload) {
      renderHealth(reply.payload);
    } else {
      renderHealth({
        ok: false,
        version: null,
        error: "No response from service worker",
        url: els.endpoint?.textContent || "",
        checkedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn(TAG, "health check failed:", err);
    renderHealth({
      ok: false,
      version: null,
      error: err && err.message ? err.message : "Unknown error",
      url: els.endpoint?.textContent || "",
      checkedAt: new Date().toISOString(),
    });
  }
}

els.refresh?.addEventListener("click", checkHealth);
els.settings?.addEventListener("click", () => {
  // Settings UI lands in a later roadmap item.
  setPill(els.pill?.dataset.state || "checking", "Settings coming soon");
  setTimeout(checkHealth, 1200);
});

// Match system theme for the first paint.
const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
document.body.dataset.theme = prefersLight ? "light" : "dark";

checkHealth();
