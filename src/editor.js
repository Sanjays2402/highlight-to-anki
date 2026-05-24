// Highlight to Anki — edit-before-send dialog.
//
// Loaded into a small chrome.windows.create popup. The capture id is
// passed via the URL hash (`#id=…`). On boot we ask the service worker
// for the staged capture, the configured settings, and the available
// deck / model lists. The user edits the card and clicks Send; we
// forward the edited fields back to the service worker which calls
// AnkiConnect with them verbatim (no template re-derivation).

import { initTheme } from "./theme.js";

const TAG = "[highlight-to-anki:editor]";

const els = {
  statusPill: document.getElementById("status-pill"),
  statusText: document.getElementById("status-text"),
  formCard: document.getElementById("form-card"),
  emptyCard: document.getElementById("empty-card"),
  segBtns: Array.from(document.querySelectorAll(".seg-btn")),
  deck: document.getElementById("deck-select"),
  model: document.getElementById("model-select"),
  modelLabel: document.getElementById("model-label"),
  frontField: document.getElementById("front-field"),
  backField: document.getElementById("back-field"),
  clozeField: document.getElementById("cloze-field"),
  extraField: document.getElementById("extra-field"),
  front: document.getElementById("front-input"),
  back: document.getElementById("back-input"),
  cloze: document.getElementById("cloze-input"),
  extra: document.getElementById("extra-input"),
  tags: document.getElementById("tags-input"),
  source: document.getElementById("source-link"),
  errorRow: document.getElementById("error-row"),
  errorText: document.getElementById("error-text"),
  dupRow: document.getElementById("dup-row"),
  dupText: document.getElementById("dup-text"),
  sendBtn: document.getElementById("send-btn"),
  sendLabel: document.getElementById("send-label"),
  cancelBtn: document.getElementById("cancel-btn"),
};

const state = {
  captureId: null,
  capture: null,
  settings: null,
  decks: [],
  models: [],
  mode: "basic",
};

function setStatus(stateName, label) {
  if (!els.statusPill) return;
  els.statusPill.dataset.state = stateName;
  if (els.statusText) els.statusText.textContent = label;
}

function showError(msg) {
  if (!els.errorRow || !els.errorText) return;
  if (!msg) {
    els.errorRow.hidden = true;
    els.errorText.textContent = "—";
    return;
  }
  els.errorRow.hidden = false;
  els.errorText.textContent = msg;
}

function showDuplicate(payload) {
  if (!els.dupRow || !els.dupText) return;
  if (!payload) {
    els.dupRow.hidden = true;
    els.dupText.textContent = "Looks like a duplicate";
    els.dupRow.dataset.kind = "";
    return;
  }
  const exact = payload.count || 0;
  const fuzzy = payload.fuzzyCount || 0;
  if (!exact && !fuzzy) {
    els.dupRow.hidden = true;
    els.dupText.textContent = "Looks like a duplicate";
    els.dupRow.dataset.kind = "";
    return;
  }
  if (exact) {
    const noun = exact === 1 ? "note" : "notes";
    els.dupText.textContent = `${exact} existing ${noun} match this selection in this deck.`;
    els.dupRow.dataset.kind = "exact";
  } else {
    const noun = fuzzy === 1 ? "note" : "notes";
    const best = Array.isArray(payload.fuzzyMatches) && payload.fuzzyMatches[0];
    const pct = best && typeof best.score === "number" ? Math.round(best.score * 100) : null;
    const suffix = pct != null ? ` (best match ${pct}%)` : "";
    els.dupText.textContent = `${fuzzy} similar ${noun} found in this deck${suffix}.`;
    els.dupRow.dataset.kind = "fuzzy";
  }
  els.dupRow.hidden = false;
}

let dupCheckSeq = 0;
async function checkDuplicates() {
  if (!state.capture) return;
  const text = state.mode === "cloze" ? (state.capture.text || els.cloze.value) : (state.capture.text || els.front.value);
  const deck = els.deck && els.deck.value ? els.deck.value : "";
  if (!text || text.trim().length < 4) {
    showDuplicate(null);
    return;
  }
  const seq = ++dupCheckSeq;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:find-duplicates", payload: { deck, text } });
    if (seq !== dupCheckSeq) return; // stale
    if (reply && reply.ok && reply.payload) {
      showDuplicate(reply.payload);
    } else {
      showDuplicate(null);
    }
  } catch (_err) {
    if (seq !== dupCheckSeq) return;
    showDuplicate(null);
  }
}

function parseQueryId() {
  const hash = (location.hash || "").replace(/^#/, "");
  const search = (location.search || "").replace(/^\?/, "");
  const params = new URLSearchParams(hash || search);
  return params.get("id");
}

function populateSelect(sel, values, preferred) {
  if (!sel) return;
  sel.innerHTML = "";
  const arr = Array.isArray(values) ? values : [];
  for (const v of arr) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  if (preferred && arr.includes(preferred)) {
    sel.value = preferred;
  } else if (arr.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(none available)";
    sel.appendChild(opt);
    sel.disabled = true;
  } else {
    sel.disabled = false;
  }
}

function setMode(next) {
  state.mode = next === "cloze" ? "cloze" : "basic";
  for (const btn of els.segBtns) {
    const active = btn.dataset.mode === state.mode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  const isCloze = state.mode === "cloze";
  if (els.frontField) els.frontField.hidden = isCloze;
  if (els.backField) els.backField.hidden = isCloze;
  if (els.clozeField) els.clozeField.hidden = !isCloze;
  if (els.extraField) els.extraField.hidden = !isCloze;
  if (els.modelLabel) els.modelLabel.textContent = isCloze ? "Cloze note type" : "Note type";
  if (state.settings && state.models.length) {
    const preferred = isCloze
      ? (state.settings.clozeModel || state.settings.defaultModel)
      : state.settings.defaultModel;
    if (preferred && state.models.includes(preferred)) {
      els.model.value = preferred;
    }
  }
}

function parseTags(raw) {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function defaultFront(capture) {
  return capture && capture.text ? capture.text : "";
}

function defaultBack(capture) {
  if (!capture) return "";
  const parts = [];
  if (capture.paragraph && capture.paragraph !== capture.text) {
    parts.push(`<blockquote>${escapeHtml(capture.paragraph)}</blockquote>`);
  }
  if (capture.url) {
    const label = escapeHtml(capture.title || capture.url);
    parts.push(`<p><a href="${escapeHtml(capture.url)}">${label}</a></p>`);
  }
  return parts.join("\n");
}

function defaultClozeText(capture) {
  if (!capture) return "";
  const sel = (capture.text || "").trim();
  const para = (capture.paragraph || "").trim();
  if (para && sel && para.includes(sel)) {
    return para.replace(sel, `{{c1::${sel}}}`);
  }
  return sel ? `{{c1::${sel}}}` : "";
}

function defaultExtra(capture) {
  if (!capture || !capture.url) return "";
  const label = escapeHtml(capture.title || capture.url);
  return `<a href="${escapeHtml(capture.url)}">${label}</a>`;
}

function defaultTags(capture) {
  const tags = ["highlight-to-anki"];
  if (capture && capture.hostname) {
    const host = String(capture.hostname).toLowerCase().replace(/^www\./, "").replace(/\s+/g, "");
    if (host) tags.push(`site:${host}`);
  }
  return tags.join(" ");
}

function hydrate(capture, settings, decks, models) {
  state.capture = capture;
  state.settings = settings || { defaultDeck: "", defaultModel: "", clozeModel: "" };
  state.decks = decks || [];
  state.models = models || [];

  populateSelect(els.deck, state.decks, state.settings.defaultDeck);
  populateSelect(els.model, state.models, state.settings.defaultModel);

  els.front.value = defaultFront(capture);
  els.back.value = defaultBack(capture);
  els.cloze.value = defaultClozeText(capture);
  els.extra.value = defaultExtra(capture);
  els.tags.value = defaultTags(capture);

  if (capture && capture.url) {
    els.source.href = capture.url;
    els.source.textContent = capture.title || capture.url;
  } else {
    els.source.removeAttribute("href");
    els.source.textContent = "(no source URL)";
  }

  // If the capture already has cloze syntax somewhere, switch into cloze
  // mode by default — it's a strong signal that's what the user wanted.
  const seemsCloze = /\{\{c\d+::/.test(els.cloze.value);
  setMode(seemsCloze ? "cloze" : "basic");

  showDuplicate(null);
  // Kick off a duplicate check in the background — stale replies are
  // ignored so swapping decks before this resolves stays consistent.
  checkDuplicates();

  const ready = state.decks.length > 0 && state.models.length > 0;
  els.sendBtn.disabled = !ready;
  setStatus(ready ? "ok" : "bad", ready ? "Ready" : "Configure deck/model first");
  if (!ready) {
    showError("No deck or note type configured. Open the options page and pick a default deck and note type, then try again.");
  } else {
    showError("");
  }
}

async function loadInitial() {
  setStatus("checking", "Loading…");
  state.captureId = parseQueryId();
  if (!state.captureId) {
    els.emptyCard.hidden = false;
    els.formCard.hidden = true;
    setStatus("bad", "No capture");
    return;
  }
  try {
    const [captureReply, settingsReply, decksReply, modelsReply] = await Promise.all([
      chrome.runtime.sendMessage({ type: "h2a:get-pending-entry", payload: { id: state.captureId } }),
      chrome.runtime.sendMessage({ type: "h2a:get-settings" }),
      chrome.runtime.sendMessage({ type: "h2a:list-decks" }).catch(() => ({ ok: false, payload: [] })),
      chrome.runtime.sendMessage({ type: "h2a:list-models" }).catch(() => ({ ok: false, payload: [] })),
    ]);
    if (!captureReply || !captureReply.ok || !captureReply.payload) {
      els.emptyCard.hidden = false;
      els.formCard.hidden = true;
      setStatus("bad", "Capture not found");
      return;
    }
    hydrate(
      captureReply.payload,
      (settingsReply && settingsReply.payload) || null,
      (decksReply && decksReply.ok && decksReply.payload) || [],
      (modelsReply && modelsReply.ok && modelsReply.payload) || [],
    );
  } catch (err) {
    console.warn(TAG, "load failed:", err);
    showError(err && err.message ? err.message : "Failed to load capture");
    setStatus("bad", "Error");
  }
}

async function handleSend() {
  if (!state.capture) return;
  showError("");
  els.sendBtn.disabled = true;
  if (els.sendLabel) els.sendLabel.textContent = "Sending…";
  setStatus("checking", "Sending…");
  const payload = {
    id: state.captureId,
    mode: state.mode,
    deck: els.deck.value || "",
    model: els.model.value || "",
    tags: parseTags(els.tags.value),
  };
  if (state.mode === "cloze") {
    payload.text = els.cloze.value || "";
    payload.extra = els.extra.value || "";
  } else {
    payload.front = els.front.value || "";
    payload.back = els.back.value || "";
  }
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:send-edited-capture", payload });
    if (reply && reply.ok) {
      setStatus("ok", `Sent · note #${(reply.payload && reply.payload.noteId) || "?"}`);
      if (els.sendLabel) els.sendLabel.textContent = "Sent";
      setTimeout(() => window.close(), 700);
      return;
    }
    const msg = (reply && (reply.error || (reply.payload && reply.payload.error))) || "Send failed";
    showError(msg);
    setStatus("bad", "Failed");
    els.sendBtn.disabled = false;
    if (els.sendLabel) els.sendLabel.textContent = "Retry send";
  } catch (err) {
    showError(err && err.message ? err.message : "Send failed");
    setStatus("bad", "Failed");
    els.sendBtn.disabled = false;
    if (els.sendLabel) els.sendLabel.textContent = "Retry send";
  }
}

for (const btn of els.segBtns) {
  btn.addEventListener("click", () => { setMode(btn.dataset.mode); checkDuplicates(); });
}
els.deck?.addEventListener("change", () => checkDuplicates());
els.sendBtn?.addEventListener("click", handleSend);
els.cancelBtn?.addEventListener("click", () => window.close());
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") window.close();
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") handleSend();
});

const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
document.body.dataset.theme = prefersLight ? "light" : "dark";
initTheme();

loadInitial();
