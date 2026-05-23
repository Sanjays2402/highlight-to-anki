// Highlight to Anki — popup entry point.
//
// On open, asks the background service worker to probe AnkiConnect and
// renders the result into the health card. The pill animates between
// checking → ok / bad. All state changes go through `renderHealth()`
// so the DOM stays in sync.

import { initTheme } from "./theme.js";
import {
  buildCardFields,
  buildClozeFields,
  buildImageCardFields,
  escapeHtml,
} from "./anki.js";

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
  recentPill: document.getElementById("recent-pill"),
  recentCount: document.getElementById("recent-count"),
  recentEmpty: document.getElementById("recent-empty"),
  recentList: document.getElementById("recent-list"),
  recentClear: document.getElementById("recent-clear"),
  syncPill: document.getElementById("sync-pill"),
  syncStatusText: document.getElementById("sync-status-text"),
  syncInflight: document.getElementById("sync-inflight"),
  syncLast: document.getElementById("sync-last"),
  syncTotal: document.getElementById("sync-total"),
  syncErrorRow: document.getElementById("sync-error-row"),
  syncError: document.getElementById("sync-error"),
  previewCard: document.getElementById("preview-card"),
  previewPill: document.getElementById("preview-pill"),
  previewModeLabel: document.getElementById("preview-mode-label"),
  previewFront: document.getElementById("preview-front"),
  previewBack: document.getElementById("preview-back"),
  previewSource: document.getElementById("preview-source"),
  previewErrorRow: document.getElementById("preview-error-row"),
  previewError: document.getElementById("preview-error"),
  previewDismiss: document.getElementById("preview-dismiss"),
  previewEdit: document.getElementById("preview-edit"),
  previewSend: document.getElementById("preview-send"),
  previewSendLabel: document.getElementById("preview-send-label"),
};

let activePreviewId = null;

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
    loadSync();
  }
  if (msg && (msg.type === "h2a:history-updated" || msg.type === "h2a:capture-sent")) {
    loadHistory();
    loadSync();
    if (msg.type === "h2a:capture-sent") {
      const payload = msg.payload || {};
      const entry = payload.entry;
      if (entry && entry.id === activePreviewId) {
        if (payload.ok) hidePreview();
        else showPreviewError(payload.error || "Send failed");
      }
    }
  }
  if (msg && msg.type === "h2a:capture-staged") {
    loadSync();
    const entry = msg.payload;
    if (entry && (entry.text || entry.imageUrl)) renderPreview(entry);
  }
});

/** Render recent-history entries (newest first). */
function fmtRelative(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Date.now() - then);
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function renderHistory(items) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (els.recentCount) els.recentCount.textContent = n === 1 ? "1 sent" : `${n} sent`;
  if (els.recentPill) els.recentPill.dataset.state = n > 0 ? "ok" : "idle";
  if (els.recentEmpty) els.recentEmpty.hidden = n > 0;
  if (els.recentList) {
    els.recentList.hidden = n === 0;
    els.recentList.innerHTML = "";
    for (const row of list) {
      const li = document.createElement("li");
      li.className = "recent-item";

      const text = document.createElement("span");
      text.className = "recent-item-text";
      const previewSource = row.mode === "image" && !row.text
        ? (row.title || row.imageUrl || "Image card")
        : (row.text || row.title || "(no text)");
      text.textContent = previewSource.slice(0, 200);
      li.appendChild(text);

      const mode = document.createElement("span");
      mode.className = "recent-item-mode";
      mode.dataset.mode = row.mode || "basic";
      mode.textContent = row.mode === "cloze" ? "Cloze"
        : row.mode === "image" ? "Image"
        : "Card";
      li.appendChild(mode);

      const meta = document.createElement("span");
      meta.className = "recent-item-meta";
      const when = document.createElement("span");
      when.textContent = fmtRelative(row.sentAt);
      meta.appendChild(when);
      if (row.hostname) {
        const sep = document.createElement("span");
        sep.className = "dot-sep";
        sep.textContent = "\u00B7";
        meta.appendChild(sep);
        if (row.url) {
          const a = document.createElement("a");
          a.className = "recent-item-link";
          a.href = row.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = row.hostname;
          meta.appendChild(a);
        } else {
          const span = document.createElement("span");
          span.textContent = row.hostname;
          meta.appendChild(span);
        }
      }
      if (row.deck) {
        const sep2 = document.createElement("span");
        sep2.className = "dot-sep";
        sep2.textContent = "\u00B7";
        meta.appendChild(sep2);
        const deck = document.createElement("span");
        deck.textContent = row.deck;
        meta.appendChild(deck);
      }
      li.appendChild(meta);
      els.recentList.appendChild(li);
    }
  }
  if (els.recentClear) els.recentClear.disabled = n === 0;
}

async function loadHistory() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:list-history" });
    if (reply && reply.ok) renderHistory(reply.payload || []);
  } catch (err) {
    console.warn(TAG, "history load failed:", err);
  }
}

async function clearHistory() {
  try {
    await chrome.runtime.sendMessage({ type: "h2a:clear-history" });
  } catch (err) {
    console.warn(TAG, "history clear failed:", err);
  }
  renderHistory([]);
}

els.recentClear?.addEventListener("click", clearHistory);

/** Render the sync indicator card. */
function renderSync(s) {
  const state = (s && s.state) || "idle";
  const labels = { idle: "Idle", syncing: "Syncing…", synced: "Synced", error: "Error" };
  if (els.syncPill) els.syncPill.dataset.state = state === "syncing" ? "checking" : state === "synced" ? "ok" : state === "error" ? "bad" : "idle";
  if (els.syncStatusText) els.syncStatusText.textContent = labels[state] || "Idle";
  if (els.syncInflight) els.syncInflight.textContent = String((s && s.inFlight) || 0);
  if (els.syncTotal) els.syncTotal.textContent = String((s && s.totalSent) || 0);
  if (els.syncLast) els.syncLast.textContent = s && s.lastSyncAt ? `${fmtRelative(s.lastSyncAt)} · ${fmtTime(s.lastSyncAt)}` : "—";
  if (els.syncErrorRow && els.syncError) {
    if (s && s.lastError && state === "error") {
      els.syncError.textContent = s.lastError;
      els.syncErrorRow.hidden = false;
    } else {
      els.syncErrorRow.hidden = true;
    }
  }
}

async function loadSync() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:sync-status" });
    if (reply && reply.ok) renderSync(reply.payload || {});
  } catch (err) {
    console.warn(TAG, "sync status failed:", err);
  }
}

function hidePreview() {
  activePreviewId = null;
  if (els.previewCard) els.previewCard.hidden = true;
  if (els.previewErrorRow) els.previewErrorRow.hidden = true;
  if (els.previewSend) {
    els.previewSend.disabled = false;
    if (els.previewSendLabel) els.previewSendLabel.textContent = "Send";
  }
}

function showPreviewError(msg) {
  if (!els.previewErrorRow || !els.previewError) return;
  els.previewError.textContent = msg || "Unknown error";
  els.previewErrorRow.hidden = false;
  if (els.previewPill) els.previewPill.dataset.state = "bad";
  if (els.previewSend) {
    els.previewSend.disabled = false;
    if (els.previewSendLabel) els.previewSendLabel.textContent = "Retry";
  }
}

function renderPreview(entry) {
  if (!entry || !els.previewCard) return;
  activePreviewId = entry.id || null;
  if (els.previewErrorRow) els.previewErrorRow.hidden = true;
  if (els.previewSend) {
    els.previewSend.disabled = false;
    if (els.previewSendLabel) els.previewSendLabel.textContent = "Send";
  }
  const isImage = !!entry.imageUrl && !entry.text;
  const isCloze = entry.mode === "cloze";
  let mode = "basic";
  if (isImage) mode = "image";
  else if (isCloze) mode = "cloze";
  if (els.previewPill) {
    els.previewPill.dataset.state = "ok";
    els.previewPill.dataset.mode = mode;
  }
  if (els.previewModeLabel) {
    els.previewModeLabel.textContent = mode === "cloze" ? "Cloze" : mode === "image" ? "Image" : "Card";
  }
  if (els.previewFront && els.previewBack) {
    if (mode === "image") {
      const { back } = buildImageCardFields(entry);
      const safeImg = escapeHtml(entry.imageUrl || "");
      els.previewFront.innerHTML = safeImg ? `<img src="${safeImg}" alt="">` : "";
      els.previewBack.innerHTML = back || "";
    } else if (mode === "cloze") {
      const { text, extra } = buildClozeFields(entry);
      // Render {{c1::X}} as a styled span for preview only.
      const rendered = (text || "").replace(/\{\{c\d+::(.+?)\}\}/g, '<span class="cloze">$1</span>');
      els.previewFront.innerHTML = rendered;
      els.previewBack.innerHTML = extra || "";
    } else {
      const { front, back } = buildCardFields(entry);
      els.previewFront.innerHTML = front || "";
      els.previewBack.innerHTML = back || "";
    }
  }
  if (els.previewSource) {
    if (entry.url) {
      const safeUrl = escapeHtml(entry.url);
      const label = escapeHtml(entry.hostname || entry.url);
      els.previewSource.innerHTML = `<a class="src" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } else {
      els.previewSource.textContent = "—";
    }
  }
  els.previewCard.hidden = false;
}

async function loadInitialPreview() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:list-pending" });
    if (!reply || !reply.ok) return;
    const list = Array.isArray(reply.payload) ? reply.payload : [];
    const pending = list.find((e) => e && (e.status === "staged" || e.status === "failed" || e.status === "needs-config"));
    if (pending) {
      renderPreview(pending);
      if (pending.status === "failed" && pending.error) showPreviewError(pending.error);
      if (pending.status === "needs-config") showPreviewError(pending.error || "No default deck/model configured");
    }
  } catch (err) {
    console.warn(TAG, "initial preview load failed:", err);
  }
}

els.previewDismiss?.addEventListener("click", () => {
  hidePreview();
});
els.previewEdit?.addEventListener("click", async () => {
  if (!activePreviewId) return;
  try {
    await chrome.runtime.sendMessage({ type: "h2a:open-editor", payload: { id: activePreviewId } });
    window.close();
  } catch (err) {
    console.warn(TAG, "preview edit failed:", err);
  }
});
els.previewSend?.addEventListener("click", async () => {
  if (!activePreviewId) return;
  if (els.previewSend) {
    els.previewSend.disabled = true;
    if (els.previewSendLabel) els.previewSendLabel.textContent = "Sending…";
  }
  if (els.previewPill) els.previewPill.dataset.state = "checking";
  if (els.previewErrorRow) els.previewErrorRow.hidden = true;
  const mode = els.previewPill?.dataset.mode || "basic";
  const type = mode === "cloze" ? "h2a:send-capture-cloze"
    : mode === "image" ? "h2a:send-capture-image"
    : "h2a:send-capture";
  try {
    const reply = await chrome.runtime.sendMessage({ type, payload: { id: activePreviewId } });
    if (reply && reply.ok) {
      hidePreview();
    } else {
      showPreviewError((reply && reply.error) || "Send failed");
    }
  } catch (err) {
    showPreviewError(err && err.message ? err.message : "Send failed");
  }
});

// Match system theme for the first paint.
const themeCtl = initTheme({
  onChange: ({ preference }) => {
    const btns = document.querySelectorAll(".theme-btn");
    for (const b of btns) {
      const active = b.dataset.themePref === preference;
      b.setAttribute("aria-checked", active ? "true" : "false");
    }
  },
});
for (const btn of document.querySelectorAll(".theme-btn")) {
  btn.addEventListener("click", () => themeCtl.setPreference(btn.dataset.themePref));
}

checkHealth();
loadBatch();
loadHistory();
loadSync();
loadInitialPreview();

// Light polling while popup is open so in-flight sends animate without push.
const syncPoll = setInterval(loadSync, 2500);
window.addEventListener("unload", () => clearInterval(syncPoll));
