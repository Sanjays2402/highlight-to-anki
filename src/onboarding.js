// Highlight to Anki — first-run onboarding tutorial.
//
// A 4-step flow rendered as a stack of liquid-glass cards:
//   1) Welcome
//   2) Connect AnkiConnect (with live test)
//   3) Pick default deck + note type
//   4) Try a capture
//
// Triggered on the install event by the service worker, and re-runnable
// from the options screen ("Replay tutorial"). The wizard never sends
// network calls outside the user's AnkiConnect host.

import { initTheme } from "./theme.js";

const TAG = "[highlight-to-anki:onboarding]";
const TOTAL_STEPS = 4;
const ONBOARDING_KEY = "h2a:onboarding";

const els = {
  cards: Array.from(document.querySelectorAll(".onb-card")),
  steps: Array.from(document.querySelectorAll(".onb-step")),
  progress: document.querySelector(".onb-progress"),
  backBtn: document.getElementById("back-btn"),
  nextBtn: document.getElementById("next-btn"),
  nextLabel: document.getElementById("next-label"),
  skipBtn: document.getElementById("skip-btn"),
  stepIndicator: document.getElementById("step-indicator"),
  copyBtn: document.getElementById("copy-code-btn"),
  copyLabel: document.getElementById("copy-code-label"),
  ankiconnectCode: document.getElementById("ankiconnect-code"),
  testBtn: document.getElementById("test-btn"),
  testPill: document.getElementById("test-pill"),
  testPillText: document.getElementById("test-pill-text"),
  testDetail: document.getElementById("test-detail"),
  deckSelect: document.getElementById("onb-deck"),
  modelSelect: document.getElementById("onb-model"),
  defaultsHint: document.getElementById("onb-defaults-hint"),
  saveDefaultsBtn: document.getElementById("onb-save-defaults"),
  shortcut: document.getElementById("onb-shortcut"),
  openOptions: document.getElementById("onb-open-options"),
};

let current = 1;
let healthOk = false;
let decksLoaded = false;

function setStep(next) {
  const clamped = Math.max(1, Math.min(TOTAL_STEPS, next));
  current = clamped;
  for (const card of els.cards) {
    const active = Number(card.dataset.step) === clamped;
    card.classList.toggle("is-active", active);
  }
  for (const dot of els.steps) {
    const n = Number(dot.dataset.step);
    dot.classList.toggle("is-active", n === clamped);
    dot.classList.toggle("is-done", n < clamped);
  }
  els.progress.setAttribute("aria-valuenow", String(clamped));
  els.backBtn.disabled = clamped === 1;
  if (clamped === TOTAL_STEPS) {
    els.nextLabel.textContent = "Finish";
  } else {
    els.nextLabel.textContent = "Continue";
  }
  els.stepIndicator.textContent = `Step ${clamped} of ${TOTAL_STEPS}`;
  if (clamped === 3 && !decksLoaded && healthOk) {
    loadDeckChoices();
  }
}

function setTestPill(state, text, detail) {
  if (!els.testPill) return;
  els.testPill.dataset.state = state;
  els.testPill.classList.remove("pill-ok", "pill-bad", "pill-checking");
  els.testPill.classList.add(
    state === "ok" ? "pill-ok" : state === "bad" ? "pill-bad" : "pill-checking",
  );
  els.testPillText.textContent = text;
  if (detail) {
    els.testDetail.textContent = detail;
  } else {
    els.testDetail.textContent = "";
  }
}

async function testConnection() {
  setTestPill("checking", "Checking…", "Asking AnkiConnect for its version…");
  els.testBtn.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "h2a:anki-health" });
    const status = reply && reply.payload ? reply.payload : null;
    if (status && status.ok) {
      healthOk = true;
      setTestPill(
        "ok",
        `Connected · v${status.version || "?"}`,
        `Reached ${status.url || "AnkiConnect"} successfully.`,
      );
      // Pre-load deck choices in the background so Step 3 is instant.
      loadDeckChoices().catch(() => {});
    } else {
      healthOk = false;
      const errMsg = (status && status.error)
        || "Could not reach AnkiConnect. Is Anki running with the add-on installed?";
      setTestPill("bad", "Not connected", errMsg);
    }
  } catch (err) {
    healthOk = false;
    setTestPill(
      "bad",
      "Not connected",
      (err && err.message) || "Service worker did not respond.",
    );
  } finally {
    els.testBtn.disabled = false;
  }
}

async function loadDeckChoices() {
  if (!els.deckSelect || !els.modelSelect) return;
  els.defaultsHint.textContent = "Loading decks and note types…";
  els.deckSelect.innerHTML = `<option value="">Loading…</option>`;
  els.modelSelect.innerHTML = `<option value="">Loading…</option>`;
  try {
    const [decksReply, modelsReply, settingsReply] = await Promise.all([
      chrome.runtime.sendMessage({ type: "h2a:list-decks" }),
      chrome.runtime.sendMessage({ type: "h2a:list-models" }),
      chrome.runtime.sendMessage({ type: "h2a:get-settings" }),
    ]);
    const decks = (decksReply && decksReply.ok && Array.isArray(decksReply.payload)) ? decksReply.payload : [];
    const models = (modelsReply && modelsReply.ok && Array.isArray(modelsReply.payload)) ? modelsReply.payload : [];
    const settings = (settingsReply && settingsReply.payload) || {};
    fillSelect(els.deckSelect, decks, settings.defaultDeck);
    fillSelect(els.modelSelect, models, settings.defaultModel);
    decksLoaded = decks.length > 0 && models.length > 0;
    if (decksLoaded) {
      els.defaultsHint.textContent =
        "These power the right-click and ⌘⇧Y send. You can change them later.";
      els.saveDefaultsBtn.disabled = !(els.deckSelect.value && els.modelSelect.value);
    } else {
      els.defaultsHint.textContent =
        "No decks returned from Anki. Open Anki Desktop, create a deck and a note type, then come back to Step 2.";
    }
  } catch (err) {
    console.warn(TAG, "loadDeckChoices failed:", err && err.message);
    els.defaultsHint.textContent =
      "Couldn't load decks. Re-run the connection test in Step 2.";
    els.deckSelect.innerHTML = `<option value="">(none)</option>`;
    els.modelSelect.innerHTML = `<option value="">(none)</option>`;
  }
}

function fillSelect(select, items, selectedValue) {
  select.innerHTML = "";
  if (!items.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(none)";
    select.appendChild(opt);
    return;
  }
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = item;
    if (selectedValue && item === selectedValue) opt.selected = true;
    select.appendChild(opt);
  }
  if (!selectedValue) select.selectedIndex = 0;
}

async function saveDefaults() {
  const defaultDeck = els.deckSelect.value || "";
  const defaultModel = els.modelSelect.value || "";
  if (!defaultDeck || !defaultModel) return;
  els.saveDefaultsBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({
      type: "h2a:set-settings",
      payload: { defaultDeck, defaultModel },
    });
    els.defaultsHint.textContent = `Saved: ${defaultDeck} · ${defaultModel}`;
  } catch (err) {
    els.defaultsHint.textContent =
      (err && err.message) || "Couldn't save defaults.";
  } finally {
    els.saveDefaultsBtn.disabled = false;
  }
}

async function markComplete(reason) {
  try {
    await chrome.storage.local.set({
      [ONBOARDING_KEY]: {
        completed: true,
        reason: reason || "finished",
        completedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.warn(TAG, "markComplete failed:", err && err.message);
  }
}

function applyShortcutLabel() {
  // Best-effort: ask chrome.commands for the actual binding so the
  // label matches whatever the user has rebound it to.
  if (!chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll((cmds) => {
    if (!Array.isArray(cmds)) return;
    const c = cmds.find((x) => x && x.name === "send-selection");
    if (!c || !c.shortcut || !els.shortcut) return;
    els.shortcut.textContent = c.shortcut.replace(/\+/g, "");
  });
}

async function copyAddonCode() {
  const code = (els.ankiconnectCode && els.ankiconnectCode.textContent) || "";
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    els.copyLabel.textContent = "Copied";
    setTimeout(() => { if (els.copyLabel) els.copyLabel.textContent = "Copy"; }, 1400);
  } catch (err) {
    els.copyLabel.textContent = "Copy failed";
    setTimeout(() => { if (els.copyLabel) els.copyLabel.textContent = "Copy"; }, 1400);
  }
}

function openOptionsPage(evt) {
  if (evt) evt.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    return;
  }
  try {
    window.open(chrome.runtime.getURL("src/options.html"));
  } catch (_) { /* ignored */ }
}

// Wire up controls --------------------------------------------------------
els.nextBtn.addEventListener("click", async () => {
  if (current === TOTAL_STEPS) {
    await markComplete("finished");
    window.close();
    return;
  }
  setStep(current + 1);
});

els.backBtn.addEventListener("click", () => setStep(current - 1));
els.skipBtn.addEventListener("click", async () => {
  await markComplete("skipped");
  window.close();
});

if (els.testBtn) els.testBtn.addEventListener("click", () => { testConnection(); });
if (els.copyBtn) els.copyBtn.addEventListener("click", copyAddonCode);
if (els.saveDefaultsBtn) els.saveDefaultsBtn.addEventListener("click", saveDefaults);
for (const sel of [els.deckSelect, els.modelSelect]) {
  if (!sel) continue;
  sel.addEventListener("change", () => {
    els.saveDefaultsBtn.disabled = !(els.deckSelect.value && els.modelSelect.value);
  });
}
if (els.openOptions) els.openOptions.addEventListener("click", openOptionsPage);

// Theme parity with the rest of the extension.
initTheme();
setStep(1);
applyShortcutLabel();

// Auto-probe AnkiConnect once the user lands on Step 2 — saves a click
// when their setup is already working.
els.steps.forEach((dot) => {
  dot.addEventListener("click", () => setStep(Number(dot.dataset.step)));
});
let autoProbed = false;
const observer = new MutationObserver(() => {
  const activeCard = document.querySelector(".onb-card.is-active");
  if (activeCard && Number(activeCard.dataset.step) === 2 && !autoProbed) {
    autoProbed = true;
    testConnection().catch(() => {});
  }
});
observer.observe(document.querySelector(".onb-deck"), { attributes: true, subtree: true, attributeFilter: ["class"] });
