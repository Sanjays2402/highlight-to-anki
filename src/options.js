// Highlight to Anki — options page.
//
// Lets the user pick a default deck and note type. Deck/model names come
// from AnkiConnect via the service worker so we keep all network calls in
// one place. Selections are persisted in chrome.storage.sync under
// `h2a:settings` and consumed by future card-send logic.

const TAG = "[highlight-to-anki:options]";

const els = {
  pill: document.getElementById("health-pill"),
  pillText: document.querySelector("#health-pill .pill-text"),
  deck: document.getElementById("deck-select"),
  model: document.getElementById("model-select"),
  clozeModel: document.getElementById("cloze-model-select"),
  save: document.getElementById("save-btn"),
  refresh: document.getElementById("refresh-btn"),
  saveState: document.getElementById("save-state"),
  empty: document.getElementById("empty-state"),
  card: document.getElementById("defaults-card"),
};

const state = {
  settings: { defaultDeck: "", defaultModel: "", clozeModel: "" },
  decks: [],
  models: [],
  dirty: false,
};

function setPill(stateName, label) {
  if (!els.pill) return;
  els.pill.dataset.state = stateName;
  if (els.pillText) els.pillText.textContent = label;
}

function setSaveState(stateName, text) {
  if (!els.saveState) return;
  els.saveState.dataset.state = stateName || "";
  els.saveState.textContent = text || "";
}

function populateSelect(select, items, current, placeholder) {
  if (!select) return;
  select.innerHTML = "";
  if (!items.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— None —";
  select.appendChild(blank);
  let matched = current === "";
  for (const name of items) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === current) {
      opt.selected = true;
      matched = true;
    }
    select.appendChild(opt);
  }
  if (!matched && current) {
    // Preserve previously-chosen value even if Anki no longer reports it.
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = `${current} (missing)`;
    opt.selected = true;
    select.appendChild(opt);
  }
  select.disabled = false;
}

async function sendMsg(type, payload) {
  return chrome.runtime.sendMessage(payload ? { type, payload } : { type });
}

async function loadSettings() {
  try {
    const reply = await sendMsg("h2a:get-settings");
    if (reply && reply.ok && reply.payload) {
      state.settings = {
        defaultDeck: reply.payload.defaultDeck || "",
        defaultModel: reply.payload.defaultModel || "",
        clozeModel: reply.payload.clozeModel || "",
      };
    }
  } catch (err) {
    console.warn(TAG, "loadSettings failed:", err);
  }
}

async function refresh() {
  setPill("checking", "Checking AnkiConnect…");
  setSaveState("", "");
  els.empty.hidden = true;
  els.card.hidden = false;
  els.deck.disabled = true;
  els.model.disabled = true;
  if (els.clozeModel) els.clozeModel.disabled = true;
  els.save.disabled = true;

  let health;
  try {
    const reply = await sendMsg("h2a:anki-health");
    health = reply && reply.ok ? reply.payload : null;
  } catch (err) {
    health = { ok: false, error: err && err.message ? err.message : "Unknown error" };
  }

  if (!health || !health.ok) {
    setPill("bad", health && health.error ? `Offline: ${health.error}` : "Offline");
    els.empty.hidden = false;
    populateSelect(els.deck, [], state.settings.defaultDeck, "Unavailable");
    populateSelect(els.model, [], state.settings.defaultModel, "Unavailable");
    if (els.clozeModel) populateSelect(els.clozeModel, [], state.settings.clozeModel, "Unavailable");
    return;
  }

  setPill("ok", `Connected · v${health.version}`);

  const [deckReply, modelReply] = await Promise.all([
    sendMsg("h2a:list-decks").catch((err) => ({ ok: false, error: err.message })),
    sendMsg("h2a:list-models").catch((err) => ({ ok: false, error: err.message })),
  ]);

  state.decks = deckReply && deckReply.ok ? deckReply.payload : [];
  state.models = modelReply && modelReply.ok ? modelReply.payload : [];

  populateSelect(els.deck, state.decks, state.settings.defaultDeck, "No decks");
  populateSelect(els.model, state.models, state.settings.defaultModel, "No note types");
  if (els.clozeModel) populateSelect(els.clozeModel, state.models, state.settings.clozeModel, "No note types");

  state.dirty = false;
  els.save.disabled = true;
}

function onChange() {
  state.dirty = true;
  els.save.disabled = false;
  setSaveState("", "");
}

async function save() {
  els.save.disabled = true;
  setSaveState("", "Saving…");
  try {
    const reply = await sendMsg("h2a:set-settings", {
      defaultDeck: els.deck.value,
      defaultModel: els.model.value,
      clozeModel: els.clozeModel ? els.clozeModel.value : "",
    });
    if (reply && reply.ok) {
      state.settings.defaultDeck = reply.payload.defaultDeck;
      state.settings.defaultModel = reply.payload.defaultModel;
      state.settings.clozeModel = reply.payload.clozeModel || "";
      state.dirty = false;
      setSaveState("saved", "Saved");
      setTimeout(() => setSaveState("", ""), 1800);
    } else {
      throw new Error(reply && reply.error ? reply.error : "Save failed");
    }
  } catch (err) {
    setSaveState("error", err && err.message ? err.message : "Save failed");
    els.save.disabled = false;
  }
}

els.deck.addEventListener("change", onChange);
els.model.addEventListener("change", onChange);
if (els.clozeModel) els.clozeModel.addEventListener("change", onChange);
els.save.addEventListener("click", save);
els.refresh.addEventListener("click", refresh);

const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
document.body.dataset.theme = prefersLight ? "light" : "dark";

(async () => {
  await loadSettings();
  await refresh();
})();
