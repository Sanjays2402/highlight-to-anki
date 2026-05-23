// Highlight to Anki — options page.
//
// Lets the user pick a default deck and note type. Deck/model names come
// from AnkiConnect via the service worker so we keep all network calls in
// one place. Selections are persisted in chrome.storage.sync under
// `h2a:settings` and consumed by future card-send logic.

const TAG = "[highlight-to-anki:options]";

import { initTheme } from "./theme.js";

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
  ankiHost: document.getElementById("anki-host"),
  ankiPort: document.getElementById("anki-port"),
  connectionUrl: document.getElementById("connection-url"),
  connectionTest: document.getElementById("connection-test"),
  testConnection: document.getElementById("test-connection-btn"),
  resetConnection: document.getElementById("reset-connection-btn"),
  templatesList: document.getElementById("templates-list"),
  templatesEmpty: document.getElementById("templates-empty"),
  templatesSaveState: document.getElementById("templates-save-state"),
  addTemplate: document.getElementById("add-template-btn"),
  siteRulesList: document.getElementById("site-rules-list"),
  siteRulesEmpty: document.getElementById("site-rules-empty"),
  siteRulesSaveState: document.getElementById("site-rules-save-state"),
  addSiteRule: document.getElementById("add-site-rule-btn"),
  deckStylesList: document.getElementById("deck-styles-list"),
  deckStylesEmpty: document.getElementById("deck-styles-empty"),
  deckStylesSaveState: document.getElementById("deck-styles-save-state"),
  addDeckStyle: document.getElementById("add-deck-style-btn"),
};

const state = {
  settings: { defaultDeck: "", defaultModel: "", clozeModel: "", fieldTemplates: {}, deckStyles: {}, siteRules: [], ankiHost: "127.0.0.1", ankiPort: 8765 },
  decks: [],
  models: [],
  dirty: false,
  templates: [],
  siteRules: [],
  deckStyles: [],
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
        deckStyles: reply.payload.deckStyles && typeof reply.payload.deckStyles === "object"
          ? reply.payload.deckStyles
          : {},
        siteRules: Array.isArray(reply.payload.siteRules) ? reply.payload.siteRules : [],
        ankiHost: reply.payload.ankiHost || "127.0.0.1",
        ankiPort: Number.isFinite(reply.payload.ankiPort) ? reply.payload.ankiPort : 8765,
      };
      state.templates = Object.entries(state.settings.fieldTemplates).map(([deck, tpl]) => ({
        deck,
        frontField: (tpl && tpl.frontField) || "",
        backField: (tpl && tpl.backField) || "",
        textField: (tpl && tpl.textField) || "",
        extraField: (tpl && tpl.extraField) || "",
      }));
      state.siteRules = state.settings.siteRules.map((r) => ({
        hostname: (r && r.hostname) || "",
        deck: (r && r.deck) || "",
      }));
      state.deckStyles = Object.entries(state.settings.deckStyles).map(([deck, css]) => ({
        deck,
        css: typeof css === "string" ? css : "",
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
  renderSiteRules();
  renderDeckStyles();

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
      siteRules: siteRulesToList(),
      deckStyles: deckStylesToMap(),
      ankiHost: els.ankiHost ? els.ankiHost.value : undefined,
      ankiPort: els.ankiPort ? els.ankiPort.value : undefined,
    });
    if (reply && reply.ok) {
      state.settings.defaultDeck = reply.payload.defaultDeck;
      state.settings.defaultModel = reply.payload.defaultModel;
      state.settings.clozeModel = reply.payload.clozeModel || "";
      state.settings.fieldTemplates = reply.payload.fieldTemplates || {};
      state.settings.siteRules = Array.isArray(reply.payload.siteRules) ? reply.payload.siteRules : [];
      state.settings.deckStyles = reply.payload.deckStyles || {};
      state.settings.ankiHost = reply.payload.ankiHost || "127.0.0.1";
      state.settings.ankiPort = Number.isFinite(reply.payload.ankiPort) ? reply.payload.ankiPort : 8765;
      if (els.ankiHost) els.ankiHost.value = state.settings.ankiHost;
      if (els.ankiPort) els.ankiPort.value = String(state.settings.ankiPort);
      updateConnectionUrl();
      state.dirty = false;
      setSaveState("saved", "Saved");
      setTemplatesSaveState("saved", "Saved");
      setSiteRulesSaveState("saved", "Saved");
      setTimeout(() => { setSaveState("", ""); setTemplatesSaveState("", ""); setSiteRulesSaveState("", ""); }, 1800);
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
if (els.ankiHost) {
  els.ankiHost.addEventListener("input", () => { onChange(); updateConnectionUrl(); });
}
if (els.ankiPort) {
  els.ankiPort.addEventListener("input", () => { onChange(); updateConnectionUrl(); });
}
if (els.testConnection) els.testConnection.addEventListener("click", testConnection);
if (els.resetConnection) els.resetConnection.addEventListener("click", resetConnection);
if (els.addTemplate) els.addTemplate.addEventListener("click", addTemplate);
if (els.addSiteRule) els.addSiteRule.addEventListener("click", addSiteRule);
if (els.addDeckStyle) els.addDeckStyle.addEventListener("click", addDeckStyle);

function normaliseHostInput(raw) {
  let h = String(raw == null ? "" : raw).trim();
  if (!h) return "";
  h = h.replace(/^https?:\/\//i, "");
  h = h.split("/")[0].split("?")[0];
  h = h.replace(/:\d+$/, "");
  return h.toLowerCase();
}

function currentConnection() {
  const host = normaliseHostInput(els.ankiHost ? els.ankiHost.value : "") || "127.0.0.1";
  let port = els.ankiPort ? Number(els.ankiPort.value) : 8765;
  if (!Number.isFinite(port) || port < 1 || port > 65535) port = 8765;
  return { host, port, url: `http://${host}:${port}` };
}

function updateConnectionUrl() {
  if (!els.connectionUrl) return;
  els.connectionUrl.textContent = currentConnection().url;
}

function setConnectionTestState(stateName, text) {
  if (!els.connectionTest) return;
  els.connectionTest.dataset.state = stateName || "";
  els.connectionTest.textContent = text || "";
}

async function testConnection() {
  if (!els.testConnection) return;
  const conn = currentConnection();
  els.testConnection.disabled = true;
  setConnectionTestState("checking", "Testing…");
  try {
    const reply = await sendMsg("h2a:test-connection", { ankiHost: conn.host, ankiPort: conn.port });
    const payload = reply && reply.ok ? reply.payload : null;
    if (payload && payload.ok) {
      setConnectionTestState("ok", `Connected · v${payload.version}`);
    } else {
      const err = payload && payload.error ? payload.error : "Unreachable";
      setConnectionTestState("bad", err);
    }
  } catch (err) {
    setConnectionTestState("bad", err && err.message ? err.message : "Unreachable");
  } finally {
    els.testConnection.disabled = false;
  }
}

function resetConnection() {
  if (els.ankiHost) els.ankiHost.value = "127.0.0.1";
  if (els.ankiPort) els.ankiPort.value = "8765";
  updateConnectionUrl();
  setConnectionTestState("", "");
  onChange();
}

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

function siteRulesToList() {
  const out = [];
  for (const r of state.siteRules) {
    let host = (r.hostname || "").trim().toLowerCase();
    const deck = (r.deck || "").trim();
    if (!host || !deck) continue;
    if (host.startsWith("www.")) host = host.slice(4);
    out.push({ hostname: host, deck });
  }
  return out;
}

function setSiteRulesSaveState(stateName, text) {
  if (!els.siteRulesSaveState) return;
  els.siteRulesSaveState.dataset.state = stateName || "";
  els.siteRulesSaveState.textContent = text || "";
}

function renderSiteRules() {
  if (!els.siteRulesList) return;
  els.siteRulesList.innerHTML = "";
  if (!state.siteRules.length) {
    if (els.siteRulesEmpty) els.siteRulesEmpty.hidden = false;
    return;
  }
  if (els.siteRulesEmpty) els.siteRulesEmpty.hidden = true;

  const decks = state.decks.slice();
  state.siteRules.forEach((rule, idx) => {
    const row = document.createElement("div");
    row.className = "site-rule-row";
    row.dataset.idx = String(idx);

    const hostField = document.createElement("div");
    hostField.className = "field site-rule-host";
    const hostLbl = document.createElement("label");
    hostLbl.textContent = "Hostname";
    const hostInput = document.createElement("input");
    hostInput.type = "text";
    hostInput.placeholder = "example.com";
    hostInput.value = rule.hostname || "";
    hostInput.dataset.idx = String(idx);
    hostInput.dataset.key = "hostname";
    hostInput.spellcheck = false;
    hostInput.autocomplete = "off";
    hostInput.id = `site-rule-${idx}-host`;
    hostLbl.htmlFor = hostInput.id;
    hostInput.addEventListener("input", onSiteRuleChange);
    hostField.appendChild(hostLbl);
    hostField.appendChild(hostInput);

    const deckField = document.createElement("div");
    deckField.className = "field site-rule-deck";
    const deckLbl = document.createElement("label");
    deckLbl.textContent = "Deck";
    const deckWrap = document.createElement("div");
    deckWrap.className = "select-wrap";
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
    deckSel.id = `site-rule-${idx}-deck`;
    deckLbl.htmlFor = deckSel.id;
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— Select a deck —";
    deckSel.appendChild(blank);
    let matched = !rule.deck;
    for (const name of decks) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      if (name === rule.deck) { o.selected = true; matched = true; }
      deckSel.appendChild(o);
    }
    if (!matched && rule.deck) {
      const o = document.createElement("option");
      o.value = rule.deck;
      o.textContent = `${rule.deck} (missing)`;
      o.selected = true;
      deckSel.appendChild(o);
    }
    deckSel.addEventListener("change", onSiteRuleChange);
    deckWrap.appendChild(deckSel);
    deckField.appendChild(deckLbl);
    deckField.appendChild(deckWrap);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "site-rule-remove";
    remove.dataset.idx = String(idx);
    remove.setAttribute("aria-label", "Remove site rule");
    remove.title = "Remove site rule";
    remove.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 7V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>`;
    remove.addEventListener("click", onSiteRuleRemove);

    row.appendChild(hostField);
    row.appendChild(deckField);
    row.appendChild(remove);
    els.siteRulesList.appendChild(row);
  });
}

function onSiteRuleChange(ev) {
  const idx = Number(ev.currentTarget.dataset.idx);
  const key = ev.currentTarget.dataset.key;
  if (!Number.isFinite(idx) || !state.siteRules[idx] || !key) return;
  state.siteRules[idx][key] = ev.currentTarget.value;
  onChange();
  setSiteRulesSaveState("", "Unsaved changes");
}

function onSiteRuleRemove(ev) {
  const idx = Number(ev.currentTarget.dataset.idx);
  if (!Number.isFinite(idx)) return;
  state.siteRules.splice(idx, 1);
  renderSiteRules();
  onChange();
  setSiteRulesSaveState("", "Unsaved changes");
}

function addSiteRule() {
  state.siteRules.push({ hostname: "", deck: "" });
  renderSiteRules();
  const rows = els.siteRulesList.querySelectorAll(".site-rule-row");
  const last = rows[rows.length - 1];
  if (last) {
    const input = last.querySelector("input");
    if (input) input.focus();
  }
  onChange();
  setSiteRulesSaveState("", "Unsaved changes");
}

// ---------------------------------------------------------------------------
// Per-deck custom CSS
// ---------------------------------------------------------------------------

function deckStylesToMap() {
  const out = {};
  for (const row of state.deckStyles) {
    const deck = (row.deck || "").trim();
    const css = (row.css || "").replace(/^\s+|\s+$/g, "");
    if (!deck || !css) continue;
    out[deck] = css;
  }
  return out;
}

function setDeckStylesSaveState(stateName, text) {
  if (!els.deckStylesSaveState) return;
  els.deckStylesSaveState.dataset.state = stateName || "";
  els.deckStylesSaveState.textContent = text || "";
}

function renderDeckStyles() {
  if (!els.deckStylesList) return;
  els.deckStylesList.innerHTML = "";
  if (!state.deckStyles.length) {
    if (els.deckStylesEmpty) els.deckStylesEmpty.hidden = false;
    return;
  }
  if (els.deckStylesEmpty) els.deckStylesEmpty.hidden = true;

  const decks = state.decks.slice();
  state.deckStyles.forEach((entry, idx) => {
    const row = document.createElement("div");
    row.className = "deck-style-row";
    row.dataset.idx = String(idx);

    const head = document.createElement("div");
    head.className = "deck-style-row-head";
    const deckWrap = document.createElement("div");
    deckWrap.className = "select-wrap deck-style-deck-wrap";
    deckWrap.innerHTML = `
      <svg class="select-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h10"/>
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
    let matched = !entry.deck;
    for (const name of decks) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      if (name === entry.deck) { o.selected = true; matched = true; }
      deckSel.appendChild(o);
    }
    if (!matched && entry.deck) {
      const o = document.createElement("option");
      o.value = entry.deck;
      o.textContent = `${entry.deck} (missing)`;
      o.selected = true;
      deckSel.appendChild(o);
    }
    deckSel.addEventListener("change", onDeckStyleChange);
    deckWrap.appendChild(deckSel);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "deck-style-remove";
    remove.dataset.idx = String(idx);
    remove.setAttribute("aria-label", "Remove deck style");
    remove.title = "Remove deck style";
    remove.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 7V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>`;
    remove.addEventListener("click", onDeckStyleRemove);
    head.appendChild(deckWrap);
    head.appendChild(remove);
    row.appendChild(head);

    const cssField = document.createElement("div");
    cssField.className = "field deck-style-field";
    const lbl = document.createElement("label");
    lbl.textContent = "CSS";
    lbl.htmlFor = `deck-style-${idx}-css`;
    const ta = document.createElement("textarea");
    ta.id = lbl.htmlFor;
    ta.className = "deck-style-input";
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.rows = 6;
    ta.placeholder = ".h2a-source a { color: #6366f1; }";
    ta.value = entry.css || "";
    ta.dataset.idx = String(idx);
    ta.dataset.key = "css";
    ta.addEventListener("input", onDeckStyleChange);
    cssField.appendChild(lbl);
    cssField.appendChild(ta);
    row.appendChild(cssField);

    els.deckStylesList.appendChild(row);
  });
}

function onDeckStyleChange(ev) {
  const idx = Number(ev.currentTarget.dataset.idx);
  const key = ev.currentTarget.dataset.key;
  if (!Number.isFinite(idx) || !state.deckStyles[idx] || !key) return;
  state.deckStyles[idx][key] = ev.currentTarget.value;
  onChange();
  setDeckStylesSaveState("", "Unsaved changes");
}

function onDeckStyleRemove(ev) {
  const idx = Number(ev.currentTarget.dataset.idx);
  if (!Number.isFinite(idx)) return;
  state.deckStyles.splice(idx, 1);
  renderDeckStyles();
  onChange();
  setDeckStylesSaveState("", "Unsaved changes");
}

function addDeckStyle() {
  state.deckStyles.push({ deck: "", css: "" });
  renderDeckStyles();
  const rows = els.deckStylesList.querySelectorAll(".deck-style-row");
  const last = rows[rows.length - 1];
  if (last) {
    const sel = last.querySelector("select");
    if (sel) sel.focus();
  }
  onChange();
  setDeckStylesSaveState("", "Unsaved changes");
}


const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
document.body.dataset.theme = prefersLight ? "light" : "dark";

const themeCtl = initTheme({
  onChange: ({ preference }) => {
    for (const b of document.querySelectorAll(".theme-btn")) {
      b.setAttribute("aria-checked", b.dataset.themePref === preference ? "true" : "false");
    }
  },
});
for (const btn of document.querySelectorAll(".theme-btn")) {
  btn.addEventListener("click", () => themeCtl.setPreference(btn.dataset.themePref));
}

const replayBtn = document.getElementById("replay-tutorial");
if (replayBtn) {
  replayBtn.addEventListener("click", async () => {
    replayBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "h2a:open-onboarding" });
    } catch (err) {
      console.warn("[options] replay tutorial failed:", err && err.message);
    } finally {
      setTimeout(() => { replayBtn.disabled = false; }, 600);
    }
  });
}

(async () => {
  await loadSettings();
  if (els.ankiHost) els.ankiHost.value = state.settings.ankiHost || "127.0.0.1";
  if (els.ankiPort) els.ankiPort.value = String(state.settings.ankiPort || 8765);
  updateConnectionUrl();
  await refresh();
})();
