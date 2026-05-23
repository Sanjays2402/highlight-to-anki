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
  batchPill: document.getElementById("batch-pill"),
  batchCount: document.getElementById("batch-count"),
  batchEmpty: document.getElementById("batch-empty"),
  batchList: document.getElementById("batch-list"),
  batchClear: document.getElementById("batch-clear"),
  batchSend: document.getElementById("batch-send"),
  batchErrorRow: document.getElementById("batch-error-row"),
  batchError: document.getElementById("batch-error"),
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
  if (chrome.runtime && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

/** Render batch state into the queue card. */
function renderBatch(items) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (els.batchCount) els.batchCount.textContent = `${n} queued`;
  if (els.batchPill) els.batchPill.dataset.state = n > 0 ? "ok" : "idle";
  if (els.batchEmpty) els.batchEmpty.hidden = n > 0;
  if (els.batchList) {
    els.batchList.hidden = n === 0;
    els.batchList.innerHTML = "";
    for (const entry of list) {
      const li = document.createElement("li");
      li.className = "batch-item";
      const text = document.createElement("span");
      text.className = "batch-item-text";
      text.textContent = (entry.text || "").slice(0, 140);
      const meta = document.createElement("span");
      meta.className = "batch-item-meta";
      meta.textContent = entry.hostname || "";
      li.appendChild(text);
      li.appendChild(meta);
      if (entry.error) {
        const err = document.createElement("span");
        err.className = "batch-item-err";
        err.textContent = entry.error;
        li.appendChild(err);
      }
      els.batchList.appendChild(li);
    }
  }
  if (els.batchClear) els.batchClear.disabled = n === 0;
  if (els.batchSend) els.batchSend.disabled = n === 0;
}

async function loadBatch() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:list-batch" });
    if (reply && reply.ok) renderBatch(reply.payload || []);
  } catch (err) {
    console.warn(TAG, "batch load failed:", err);
  }
}

async function clearBatch() {
  try {
    await chrome.runtime.sendMessage({ type: "h2a:clear-batch" });
  } catch (err) {
    console.warn(TAG, "batch clear failed:", err);
  }
  if (els.batchErrorRow) els.batchErrorRow.hidden = true;
  renderBatch([]);
}

async function sendBatch() {
  if (els.batchSend) {
    els.batchSend.disabled = true;
    const label = els.batchSend.querySelector("span");
    if (label) label.textContent = "Sending…";
  }
  if (els.batchPill) els.batchPill.dataset.state = "checking";
  if (els.batchErrorRow) els.batchErrorRow.hidden = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:send-batch" });
    const payload = reply && reply.payload;
    if (payload) {
      renderBatch(payload.remaining || []);
      if (payload.failed > 0 && els.batchErrorRow && els.batchError) {
        els.batchError.textContent = `${payload.failed} failed: ${(payload.errors || [])[0] || "unknown"}`;
        els.batchErrorRow.hidden = false;
      }
    } else {
      await loadBatch();
    }
  } catch (err) {
    console.warn(TAG, "batch send failed:", err);
    if (els.batchErrorRow && els.batchError) {
      els.batchError.textContent = err && err.message ? err.message : "Unknown error";
      els.batchErrorRow.hidden = false;
    }
  } finally {
    if (els.batchSend) {
      const label = els.batchSend.querySelector("span");
      if (label) label.textContent = "Send All";
    }
  }
}

els.batchClear?.addEventListener("click", clearBatch);
els.batchSend?.addEventListener("click", sendBatch);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "h2a:batch-updated") {
    loadBatch();
  }
});

// Match system theme for the first paint.
const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
document.body.dataset.theme = prefersLight ? "light" : "dark";

checkHealth();
loadBatch();
