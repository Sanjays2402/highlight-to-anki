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
  deckAccentRgb,
  escapeHtml,
  resolveSiteDeck,
} from "./anki.js";

const TAG = "[highlight-to-anki:popup]";

const STATS_TOP_N = 4;
const STATS_SPARK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_INITIAL = ["S", "M", "T", "W", "T", "F", "S"];

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
  pinsPill: document.getElementById("pins-pill"),
  pinsCount: document.getElementById("pins-count"),
  pinsEmpty: document.getElementById("pins-empty"),
  pinsList: document.getElementById("pins-list"),
  pinsClear: document.getElementById("pins-clear"),
  pinsToBatch: document.getElementById("pins-to-batch"),
  recentPill: document.getElementById("recent-pill"),
  recentCount: document.getElementById("recent-count"),
  recentEmpty: document.getElementById("recent-empty"),
  recentList: document.getElementById("recent-list"),
  recentClear: document.getElementById("recent-clear"),
  recentExport: document.getElementById("recent-export"),
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
  previewDeckRow: document.getElementById("preview-deck-row"),
  previewDeckChip: document.getElementById("preview-deck-chip"),
  previewDeckName: document.getElementById("preview-deck-name"),
  previewErrorRow: document.getElementById("preview-error-row"),
  previewError: document.getElementById("preview-error"),
  previewDismiss: document.getElementById("preview-dismiss"),
  previewEdit: document.getElementById("preview-edit"),
  previewSend: document.getElementById("preview-send"),
  previewSendLabel: document.getElementById("preview-send-label"),
  toastStack: document.getElementById("toast-stack"),
  statsPill: document.getElementById("stats-pill"),
  statsTotal: document.getElementById("stats-total"),
  statsEmpty: document.getElementById("stats-empty"),
  statsGrid: document.getElementById("stats-grid"),
  statsToday: document.getElementById("stats-today"),
  statsWeek: document.getElementById("stats-week"),
  statsStreak: document.getElementById("stats-streak"),
  statsSparkBars: document.getElementById("stats-spark-bars"),
  statsSparkAxis: document.getElementById("stats-spark-axis"),
  statsDecks: document.getElementById("stats-decks"),
  statsTags: document.getElementById("stats-tags"),
  reviewPill: document.getElementById("review-pill"),
  reviewCount: document.getElementById("review-count"),
  reviewEmpty: document.getElementById("review-empty"),
  reviewEmptyText: document.getElementById("review-empty-text"),
  reviewStage: document.getElementById("review-stage"),
  reviewQuestion: document.getElementById("review-question"),
  reviewAnswer: document.getElementById("review-answer"),
  reviewDivider: document.getElementById("review-divider"),
  reviewErrorRow: document.getElementById("review-error-row"),
  reviewError: document.getElementById("review-error"),
  reviewReveal: document.getElementById("review-reveal"),
  reviewGrades: document.getElementById("review-grades"),
};

/**
 * Pure helper: aggregate a recent-history list into the counts the
 * stats card renders. Exported via window for any future caller and
 * unit-testable in isolation (no DOM access).
 *
 * @param {object[]} history
 * @param {Date=} now
 */
function computeStats(history, now = new Date()) {
  const list = Array.isArray(history) ? history : [];
  const total = list.length;
  const startOfDay = (d) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return x.getTime();
  };
  const todayStart = startOfDay(now);
  const days = [];
  for (let i = STATS_SPARK_DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(todayStart - i * DAY_MS);
    days.push({ key: startOfDay(d), label: WEEKDAY_INITIAL[d.getDay()], count: 0 });
  }
  const dayIndex = new Map(days.map((d, i) => [d.key, i]));
  const decks = new Map();
  const tags = new Map();
  let today = 0;
  let week = 0;
  const dayKeysWithCards = new Set();
  for (const row of list) {
    if (!row) continue;
    const when = row.sentAt ? new Date(row.sentAt) : null;
    if (when && !Number.isNaN(when.getTime())) {
      const dKey = startOfDay(when);
      if (dKey === todayStart) today += 1;
      if (dKey > todayStart - STATS_SPARK_DAYS * DAY_MS) {
        week += 1;
        if (dayIndex.has(dKey)) days[dayIndex.get(dKey)].count += 1;
      }
      dayKeysWithCards.add(dKey);
    }
    const deckName = (row.deck || "").trim();
    if (deckName) decks.set(deckName, (decks.get(deckName) || 0) + 1);
    const mode = row.mode === "cloze" ? "cloze" : row.mode === "image" ? "image" : "basic";
    tags.set(mode, (tags.get(mode) || 0) + 1);
    const host = (row.hostname || "").trim().toLowerCase().replace(/^www\./, "");
    if (host) {
      const key = `site:${host}`;
      tags.set(key, (tags.get(key) || 0) + 1);
    }
  }
  // Streak: consecutive days ending today with at least 1 card.
  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const key = todayStart - i * DAY_MS;
    if (dayKeysWithCards.has(key)) streak += 1;
    else break;
  }
  const toEntries = (m) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    total,
    today,
    week,
    streak,
    days,
    topDecks: toEntries(decks).slice(0, STATS_TOP_N),
    topTags: toEntries(tags).slice(0, STATS_TOP_N),
  };
}

function renderStatsBarList(ul, entries) {
  if (!ul) return;
  ul.innerHTML = "";
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "stats-bar-empty";
    li.textContent = "—";
    ul.appendChild(li);
    return;
  }
  const max = entries[0][1] || 1;
  for (const [name, count] of entries) {
    const li = document.createElement("li");
    li.className = "stats-bar";
    const label = document.createElement("span");
    label.className = "stats-bar-label";
    label.textContent = name;
    label.title = name;
    const track = document.createElement("span");
    track.className = "stats-bar-track";
    const fill = document.createElement("span");
    fill.className = "stats-bar-fill";
    fill.style.width = `${Math.max(6, Math.round((count / max) * 100))}%`;
    track.appendChild(fill);
    const val = document.createElement("span");
    val.className = "stats-bar-count";
    val.textContent = String(count);
    li.appendChild(label);
    li.appendChild(track);
    li.appendChild(val);
    ul.appendChild(li);
  }
}

function renderStats(history) {
  const s = computeStats(history || []);
  if (els.statsTotal) els.statsTotal.textContent = s.total === 1 ? "1 total" : `${s.total} total`;
  if (els.statsPill) els.statsPill.dataset.state = s.total > 0 ? "ok" : "idle";
  const empty = s.total === 0;
  if (els.statsEmpty) els.statsEmpty.hidden = !empty;
  if (els.statsGrid) els.statsGrid.hidden = empty;
  if (empty) return;
  if (els.statsToday) els.statsToday.textContent = String(s.today);
  if (els.statsWeek) els.statsWeek.textContent = String(s.week);
  if (els.statsStreak) els.statsStreak.textContent = String(s.streak);
  if (els.statsSparkBars) {
    els.statsSparkBars.innerHTML = "";
    const max = Math.max(1, ...s.days.map((d) => d.count));
    for (const day of s.days) {
      const col = document.createElement("span");
      col.className = "stats-spark-col";
      col.title = `${day.count} card${day.count === 1 ? "" : "s"}`;
      const bar = document.createElement("span");
      bar.className = "stats-spark-bar";
      if (day.count === 0) bar.dataset.zero = "1";
      bar.style.height = `${Math.max(6, Math.round((day.count / max) * 100))}%`;
      col.appendChild(bar);
      els.statsSparkBars.appendChild(col);
    }
  }
  if (els.statsSparkAxis) {
    els.statsSparkAxis.innerHTML = "";
    for (const day of s.days) {
      const tick = document.createElement("span");
      tick.className = "stats-spark-tick";
      tick.textContent = day.label;
      els.statsSparkAxis.appendChild(tick);
    }
  }
  renderStatsBarList(els.statsDecks, s.topDecks);
  renderStatsBarList(els.statsTags, s.topTags);
}

// ----------------------------------------------------------------------
// Toast notifications
// ----------------------------------------------------------------------
// Liquid-glass slide-up surface anchored above the footer. Success
// toasts carry an Undo affordance that calls deleteNotes on the
// AnkiConnect side so a mis-fired card can be retracted in one click.
const TOAST_DURATION_MS = 6000;
const TOAST_LEAVE_MS = 220;

function iconSvg(name) {
  if (name === "check") {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4 4 10-10"/></svg>';
  }
  if (name === "alert") {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z"/></svg>';
  }
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
}

function dismissToast(toast) {
  if (!toast || toast.dataset.leaving === "1") return;
  toast.dataset.leaving = "1";
  if (toast._timer) { clearTimeout(toast._timer); toast._timer = null; }
  toast.classList.add("toast-leave");
  toast.classList.remove("toast-enter");
  setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, TOAST_LEAVE_MS);
}

function showToast({ tone = "ok", title, message, noteId = null, duration = TOAST_DURATION_MS } = {}) {
  if (!els.toastStack) return null;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.tone = tone === "bad" ? "bad" : "ok";
  if (noteId) toast.dataset.noteId = String(noteId);
  const ariaTitle = (title || "").replace(/[<>&"']/g, "");
  toast.setAttribute("role", tone === "bad" ? "alert" : "status");

  const icon = document.createElement("div");
  icon.className = "toast-icon";
  icon.innerHTML = iconSvg(tone === "bad" ? "alert" : "check");
  toast.appendChild(icon);

  const body = document.createElement("div");
  body.className = "toast-body";
  if (title) {
    const t = document.createElement("div");
    t.className = "toast-title";
    t.textContent = title;
    body.appendChild(t);
  }
  if (message) {
    const m = document.createElement("div");
    m.className = "toast-msg";
    m.textContent = message;
    body.appendChild(m);
  }
  toast.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "toast-actions";
  if (tone === "ok" && noteId) {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "toast-undo";
    undo.textContent = "Undo";
    undo.setAttribute("aria-label", `Undo send for note ${noteId}`);
    undo.addEventListener("click", async () => {
      if (undo.disabled) return;
      undo.disabled = true;
      const prev = undo.textContent;
      undo.textContent = "Undoing…";
      try {
        const reply = await chrome.runtime.sendMessage({ type: "h2a:undo-last-send", payload: { noteId } });
        if (reply && reply.ok) {
          dismissToast(toast);
          showToast({ tone: "ok", title: "Undone", message: `Note ${noteId} removed from Anki.`, duration: 3200 });
          loadHistory();
          loadSync();
        } else {
          undo.disabled = false;
          undo.textContent = prev;
          showToast({ tone: "bad", title: "Undo failed", message: (reply && reply.error) || "AnkiConnect rejected the delete." });
        }
      } catch (err) {
        undo.disabled = false;
        undo.textContent = prev;
        showToast({ tone: "bad", title: "Undo failed", message: err && err.message ? err.message : "Unknown error" });
      }
    });
    actions.appendChild(undo);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", `Dismiss ${ariaTitle || "notification"}`);
  close.innerHTML = iconSvg("x");
  close.addEventListener("click", () => dismissToast(toast));
  actions.appendChild(close);
  toast.appendChild(actions);

  const progress = document.createElement("div");
  progress.className = "toast-progress";
  progress.style.transition = `transform ${duration}ms linear`;
  toast.appendChild(progress);

  els.toastStack.appendChild(toast);
  // Force layout so the enter transition runs.
  // eslint-disable-next-line no-unused-expressions
  toast.offsetHeight;
  toast.classList.add("toast-enter");
  requestAnimationFrame(() => { progress.style.transform = "scaleX(0)"; });
  toast._timer = setTimeout(() => dismissToast(toast), duration);
  return toast;
}

let activePreviewId = null;
let cachedSettings = null;

async function loadSettings() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:get-settings" });
    if (reply && reply.ok) cachedSettings = reply.payload || {};
  } catch (err) {
    console.warn(TAG, "settings load failed:", err);
  }
  return cachedSettings || {};
}

/**
 * Resolve the deck name a capture would target based on cached
 * settings + per-site rules. Falls back to the configured default.
 */
function resolvePreviewDeck(entry) {
  if (!entry) return "";
  if (entry.deck) return entry.deck;
  const s = cachedSettings || {};
  const isCloze = entry.mode === "cloze";
  const fallback = (isCloze ? s.defaultClozeDeck : null) || s.defaultDeck || "";
  return resolveSiteDeck(s.siteRules, entry.hostname) || fallback;
}

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

/** Render the pinned-snippets list. */
function renderPins(items) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  if (els.pinsCount) els.pinsCount.textContent = n === 1 ? "1 pinned" : `${n} pinned`;
  if (els.pinsPill) els.pinsPill.dataset.state = n > 0 ? "ok" : "idle";
  if (els.pinsEmpty) els.pinsEmpty.hidden = n > 0;
  if (els.pinsList) {
    els.pinsList.hidden = n === 0;
    els.pinsList.innerHTML = "";
    for (const row of list) {
      const li = document.createElement("li");
      li.className = "pin-item";
      li.dataset.id = row.id;

      const text = document.createElement("span");
      text.className = "pin-item-text";
      const preview = row.text || row.title || row.imageUrl || "(no text)";
      text.textContent = preview.slice(0, 220);
      li.appendChild(text);

      const meta = document.createElement("span");
      meta.className = "pin-item-meta";
      const when = document.createElement("span");
      when.textContent = fmtRelative(row.pinnedAt);
      meta.appendChild(when);
      if (row.hostname) {
        const sep = document.createElement("span");
        sep.className = "dot-sep";
        sep.textContent = "\u00B7";
        meta.appendChild(sep);
        const host = document.createElement("span");
        host.textContent = row.hostname;
        meta.appendChild(host);
      }
      li.appendChild(meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pin-item-remove";
      remove.title = "Remove pin";
      remove.setAttribute("aria-label", "Remove pin");
      remove.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.addEventListener("click", () => removePin(row.id));
      li.appendChild(remove);

      els.pinsList.appendChild(li);
    }
  }
  if (els.pinsClear) els.pinsClear.disabled = n === 0;
  if (els.pinsToBatch) els.pinsToBatch.disabled = n === 0;
}

async function loadPins() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:list-pins" });
    if (reply && reply.ok) renderPins(reply.payload || []);
  } catch (err) {
    console.warn(TAG, "pins load failed:", err);
  }
}

async function clearPins() {
  try {
    await chrome.runtime.sendMessage({ type: "h2a:clear-pins" });
  } catch (err) {
    console.warn(TAG, "pins clear failed:", err);
  }
  renderPins([]);
}

async function removePin(id) {
  if (!id) return;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:remove-pin", payload: { id } });
    if (reply && reply.ok) renderPins(reply.payload || []);
  } catch (err) {
    console.warn(TAG, "pin remove failed:", err);
  }
}

async function pinsToBatch() {
  if (els.pinsToBatch) els.pinsToBatch.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:send-pins-to-batch" });
    if (reply && reply.ok) {
      const payload = reply.payload || {};
      renderPins(payload.pins || []);
      loadBatch();
      showToast({
        tone: "ok",
        title: payload.moved === 1 ? "1 pin queued" : `${payload.moved || 0} pins queued`,
        message: "Moved to the batch queue. Hit Send All to ship them.",
      });
    }
  } catch (err) {
    console.warn(TAG, "pins-to-batch failed:", err);
    showToast({ tone: "bad", title: "Queue failed", message: err && err.message ? err.message : "Unknown error" });
  } finally {
    if (els.pinsToBatch) els.pinsToBatch.disabled = false;
  }
}

els.pinsClear?.addEventListener("click", clearPins);
els.pinsToBatch?.addEventListener("click", pinsToBatch);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "h2a:pins-updated") {
    loadPins();
  }
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
      // Surface every send result as a toast, even when no preview was open.
      if (payload.ok) {
        const mode = (entry && entry.mode) || payload.mode || "basic";
        const label = mode === "cloze" ? "Cloze card" : mode === "image" ? "Image card" : "Card";
        const deck = (entry && entry.deck) || "Anki";
        showToast({ tone: "ok", title: `${label} sent`, message: deck ? `Added to ${deck}.` : "Added to Anki.", noteId: payload.noteId });
      } else if (payload && payload.error) {
        showToast({ tone: "bad", title: "Send failed", message: payload.error });
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
  renderStats(items);
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
  if (els.recentExport) els.recentExport.disabled = n === 0;
}

function tsForFilename(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function exportHistory() {
  if (!els.recentExport) return;
  const btn = els.recentExport;
  const label = btn.querySelector("span");
  const prev = label ? label.textContent : null;
  btn.disabled = true;
  if (label) label.textContent = "Exporting…";
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:list-history" });
    const list = reply && reply.ok && Array.isArray(reply.payload) ? reply.payload : [];
    const doc = {
      schema: "highlight-to-anki.history.v1",
      exportedAt: new Date().toISOString(),
      count: list.length,
      items: list,
    };
    const json = JSON.stringify(doc, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `highlight-to-anki-history-${tsForFilename(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    console.warn(TAG, "history export failed:", err);
  } finally {
    if (label && prev !== null) label.textContent = prev;
    btn.disabled = false;
  }
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
els.recentExport?.addEventListener("click", exportHistory);

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
  // Per-deck accent tint: hash the resolved deck name into a stable
  // palette and override --accent on this card only. CSS already
  // drives every accent surface from `rgb(var(--accent) / a)`.
  const previewDeck = resolvePreviewDeck(entry);
  const accent = deckAccentRgb(previewDeck);
  els.previewCard.style.setProperty("--accent", accent);
  els.previewCard.style.setProperty("--accent-strong", accent);
  if (els.previewDeckName) els.previewDeckName.textContent = previewDeck || "Default deck";
  if (els.previewDeckRow) els.previewDeckRow.hidden = false;
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
      const payload = reply.payload || {};
      const entry = payload.entry || {};
      const label = mode === "cloze" ? "Cloze card" : mode === "image" ? "Image card" : "Card";
      const deck = entry.deck || "Anki";
      showToast({ tone: "ok", title: `${label} sent`, message: deck ? `Added to ${deck}.` : "Added to Anki.", noteId: payload.noteId || null });
      loadHistory();
      loadSync();
    } else {
      const errMsg = (reply && reply.error) || "Send failed";
      showPreviewError(errMsg);
      showToast({ tone: "bad", title: "Send failed", message: errMsg });
    }
  } catch (err) {
    const errMsg = err && err.message ? err.message : "Send failed";
    showPreviewError(errMsg);
    showToast({ tone: "bad", title: "Send failed", message: errMsg });
  }
});

// ---------------------------------------------------------------------------
// Spaced-review queue
// ---------------------------------------------------------------------------

const reviewState = {
  cardIds: [],
  current: null,
  revealed: false,
  deck: "",
  loading: false,
};

function setReviewPill(state, label) {
  if (!els.reviewPill) return;
  els.reviewPill.dataset.state = state;
  els.reviewPill.className = `pill pill-${state}`;
  if (els.reviewCount) els.reviewCount.textContent = label;
}

function stripCardHtml(html) {
  // Anki returns the full card template including {{FrontSide}} and
  // injected styling — strip stray <style>/<script> blocks but keep
  // structural markup so cloze deletions, images, and code render.
  return String(html == null ? "" : html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
}

function renderReviewCard(card) {
  if (!card || !els.reviewQuestion) return;
  els.reviewQuestion.innerHTML = stripCardHtml(card.question || "");
  els.reviewAnswer.innerHTML = stripCardHtml(card.answer || "");
  els.reviewAnswer.hidden = true;
  els.reviewDivider.hidden = true;
  els.reviewGrades.hidden = true;
  if (els.reviewReveal) {
    els.reviewReveal.disabled = false;
    els.reviewReveal.hidden = false;
  }
  reviewState.revealed = false;
  if (els.reviewErrorRow) els.reviewErrorRow.hidden = true;
}

function renderReviewState() {
  const total = reviewState.cardIds.length;
  if (total === 0) {
    setReviewPill("idle", "0 due");
    if (els.reviewEmpty) els.reviewEmpty.hidden = false;
    if (els.reviewStage) els.reviewStage.hidden = true;
    if (els.reviewReveal) {
      els.reviewReveal.disabled = true;
      els.reviewReveal.hidden = true;
    }
    if (els.reviewGrades) els.reviewGrades.hidden = true;
    return;
  }
  setReviewPill("ok", `${total} due`);
  if (els.reviewEmpty) els.reviewEmpty.hidden = true;
  if (els.reviewStage) els.reviewStage.hidden = false;
  if (reviewState.current) renderReviewCard(reviewState.current);
}

function showReviewError(msg) {
  if (els.reviewErrorRow) els.reviewErrorRow.hidden = false;
  if (els.reviewError) els.reviewError.textContent = msg;
}

async function loadReview() {
  if (!els.reviewPill) return;
  if (reviewState.loading) return;
  reviewState.loading = true;
  setReviewPill("checking", "Checking…");
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:review-queue" });
    if (!reply || !reply.ok) {
      setReviewPill("bad", "Offline");
      if (els.reviewEmpty) els.reviewEmpty.hidden = false;
      if (els.reviewStage) els.reviewStage.hidden = true;
      if (els.reviewEmptyText && reply && reply.error) {
        els.reviewEmptyText.textContent = `Couldn’t reach AnkiConnect: ${reply.error}`;
      }
      return;
    }
    const payload = reply.payload || {};
    reviewState.cardIds = Array.isArray(payload.cardIds) ? payload.cardIds.slice() : [];
    reviewState.current = payload.current || null;
    reviewState.deck = payload.deck || "";
    renderReviewState();
  } catch (err) {
    setReviewPill("bad", "Error");
    showReviewError(err && err.message ? err.message : String(err));
  } finally {
    reviewState.loading = false;
  }
}

async function advanceReview() {
  reviewState.cardIds.shift();
  reviewState.current = null;
  reviewState.revealed = false;
  if (reviewState.cardIds.length === 0) {
    renderReviewState();
    return;
  }
  // Hydrate the next card. Keep the pill alive while we fetch so the
  // review surface doesn't flash empty between answers.
  setReviewPill("checking", `${reviewState.cardIds.length} due`);
  try {
    const reply = await chrome.runtime.sendMessage({
      type: "h2a:review-card",
      payload: { cardId: reviewState.cardIds[0] },
    });
    if (reply && reply.ok && reply.payload) {
      reviewState.current = reply.payload;
    }
  } catch (_err) { /* swallow, render below */ }
  renderReviewState();
}

if (els.reviewReveal) {
  els.reviewReveal.addEventListener("click", () => {
    if (!reviewState.current) return;
    reviewState.revealed = true;
    els.reviewAnswer.hidden = false;
    els.reviewDivider.hidden = false;
    els.reviewGrades.hidden = false;
    els.reviewReveal.hidden = true;
  });
}

if (els.reviewGrades) {
  els.reviewGrades.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-ease]");
    if (!btn) return;
    const ease = Number(btn.dataset.ease);
    const card = reviewState.current;
    if (!card || !Number.isFinite(ease)) return;
    for (const b of els.reviewGrades.querySelectorAll("button")) b.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({
        type: "h2a:review-answer",
        payload: { cardId: card.cardId, ease },
      });
      if (!reply || !reply.ok) {
        showToast({ tone: "bad", title: "Review failed", message: (reply && reply.error) || "AnkiConnect rejected the grade" });
      } else {
        const labels = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
        showToast({ tone: "ok", title: `Graded ${labels[ease] || ease}`, message: `${reviewState.cardIds.length - 1} card(s) left in queue.` });
      }
    } catch (err) {
      showToast({ tone: "bad", title: "Review failed", message: err && err.message ? err.message : String(err) });
    } finally {
      for (const b of els.reviewGrades.querySelectorAll("button")) b.disabled = false;
      await advanceReview();
    }
  });
}

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
loadPins();
loadHistory();
loadSync();
loadReview();
loadSettings().then(loadInitialPreview);

// Light polling while popup is open so in-flight sends animate without push.
const syncPoll = setInterval(loadSync, 2500);
window.addEventListener("unload", () => clearInterval(syncPoll));
