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
  templatesList: document.getElementById("templates-list"),
  templatesEmpty: document.getElementById("templates-empty"),
  templatesSaveState: document.getElementById("templates-save-state"),
  addTemplate: document.getElementById("add-template-btn"),
};

const state = {
  settings: { defaultDeck: "", defaultModel: "", clozeModel: "", fieldTemplates: {} },
  decks: [],
  models: [],
  dirty: false,
  templates: [],
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
        fieldTemplates: reply.payload.fieldTemplates && typeof reply.payload.fieldTemplates === "object"
          ? reply.payload.fieldTemplates
          : {},
      };
      state.templates = Object.entries(state.settings.fieldTemplates).map(([deck, tpl]) => ({
        deck,
        frontField: (tpl && tpl.frontField) || "",
        backField: (tpl && tpl.backField) || "",
        textField: (tpl && tpl.textField) || "",
        extraField: (tpl && tpl.extraField) || "",
      }));
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
  renderTemplates();

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
      fieldTemplates: templatesToMap(),
    });
    if (reply && reply.ok) {
      state.settings.defaultDeck = reply.payload.defaultDeck;
      state.settings.defaultModel = reply.payload.defaultModel;
      state.settings.clozeModel = reply.payload.clozeModel || "";
      state.settings.fieldTemplates = reply.payload.fieldTemplates || {};
      state.dirty = false;
      setSaveState("saved", "Saved");
      setTemplatesSaveState("saved", "Saved");
      setTimeout(() => { setSaveState("", ""); setTemplatesSaveState("", ""); }, 1800);
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
if (els.addTemplate) els.addTemplate.addEventListener("click", addTemplate);

function templatesToMap() {
  const out = {};
  for (const t of state.templates) {
    const deck = (t.deck || "").trim();
    if (!deck) continue;
    const entry = {};
    for (const key of ["frontField", "backField", "textField", "extraField"]) {
      const v = (t[key] || "").trim();
      if (v) entry[key] = v;
    }
    if (Object.keys(entry).length) out[deck] = entry;
  }
  return out;
}

function setTemplatesSaveState(stateName, text) {
  if (!els.templatesSaveState) return;
  els.templatesSaveState.dataset.state = stateName || "";
  els.templatesSaveState.textContent = text || "";
}

function renderTemplates() {
  if (!els.templatesList) return;
  els.templatesList.innerHTML = "";
  if (!state.templates.length) {
    if (els.templatesEmpty) els.templatesEmpty.hidden = false;
    return;
  }
  if (els.templatesEmpty) els.templatesEmpty.hidden = true;

  const decks = state.decks.slice();
  state.templates.forEach((tpl, idx) => {
    const row = document.createElement("div");
    row.className = "template-row";
    row.dataset.idx = String(idx);

    const head = document.createElement("div");
    head.className = "template-row-head";
    const deckWrap = document.createElement("div");
    deckWrap.className = "select-wrap template-deck-wrap";
    deckWrap.innerHTML = `
      <svg class="select-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 7h13l-3-3M3 7l3 3"/>
        <path d="M21 17H8l3 3M21 17l-3-3"/>
      </svg>
      <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    `;
    const deckSel = document.createElement("select");
    deckSel.dataset.idx = String(idx);
    deckSel.dataset.key = "deck";
    deckSel.setAttribute("aria-label", "Deck");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— Select a deck —";
    deckSel.appendChild(blank);
    let matched = !tpl.deck;
    for (const name of decks) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      if (name === tpl.deck) { o.selected = true; matched = true; }
      deckSel.appendChild(o);
    }
    if (!matched && tpl.deck) {
      const o = document.createElement("option");
      o.value = tpl.deck;
      o.textContent = `${tpl.deck} (missing)`;
      o.selected = true;
      deckSel.appendChild(o);
    }
    deckSel.addEventListener("change", onTemplateChange);
    deckWrap.appendChild(deckSel);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "template-remove";
    remove.dataset.idx = String(idx);
    remove.setAttribute("aria-label", "Remove deck override");
    remove.title = "Remove deck override";
    remove.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 7V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>`;
    remove.addEventListener("click", onTemplateRemove);
    head.appendChild(deckWrap);
    head.appendChild(remove);
    row.appendChild(head);

    const fields = document.createElement("div");
    fields.className = "template-fields";
    const inputs = [
      { key: "frontField", label: "Front field", placeholder: "Front" },
      { key: "backField", label: "Back field", placeholder: "Back" },
      { key: "textField", label: "Cloze text field", placeholder: "Text" },
      { key: "extraField", label: "Cloze extra field", placeholder: "Back Extra" },
    ];
    for (const cfg of inputs) {
      const field = document.createElement("div");
      field.className = "field";
      const lbl = document.createElement("label");
      lbl.textContent = cfg.label;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "template-input";
      input.placeholder = cfg.placeholder;
      input.value = tpl[cfg.key] || "";
      input.dataset.idx = String(idx);
      input.dataset.key = cfg.key;
      input.spellcheck = false;
      input.autocomplete = "off";
      input.addEventListener("input", onTemplateChange);
      lbl.htmlFor = `tpl-${idx}-${cfg.key}`;
      input.id = lbl.htmlFor;
      field.appendChild(lbl);
      field.appendChild(input);
      fields.appendChild(field);
    }
    row.appendChild(fields);
    els.templatesList.appendChild(row);
  });
}

function onTemplateChange(ev) {
  const idx = Number(ev.currentTarget.dataset.idx);
  const key = ev.currentTarget.dataset.key;
  if (!Number.isFinite(idx) || !state.templates[idx] || !key) return;
  state.templates[idx][key] = ev.currentTarget.value;
  onChange();
  setTemplatesSaveState("", "Unsaved changes");
}

function onTemplateRemove(ev) {
  const idx = Number(ev.currentTarget.dataset.idx);
  if (!Number.isFinite(idx)) return;
  state.templates.splice(idx, 1);
  renderTemplates();
  onChange();
  setTemplatesSaveState("", "Unsaved changes");
}

function addTemplate() {
  state.templates.push({ deck: "", frontField: "", backField: "", textField: "", extraField: "" });
  renderTemplates();
  // Focus the deck dropdown of the newly added row.
  const rows = els.templatesList.querySelectorAll(".template-row");
  const last = rows[rows.length - 1];
  if (last) {
    const sel = last.querySelector("select");
    if (sel) sel.focus();
  }
  onChange();
  setTemplatesSaveState("", "Unsaved changes");
}


const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
document.body.dataset.theme = prefersLight ? "light" : "dark";

(async () => {
  await loadSettings();
  await refresh();
})();
