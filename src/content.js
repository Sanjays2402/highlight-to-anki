// Highlight to Anki — content script scaffolding
// Runs in the page context. Captures the current selection plus
// minimal source metadata and forwards it to the background service
// worker on request. Kept intentionally small; feature modules will
// hang off the message router below.

(() => {
  if (window.__highlightToAnkiContentLoaded) return;
  window.__highlightToAnkiContentLoaded = true;

  const TAG = "[highlight-to-anki:content]";

  /**
   * Return a structured snapshot of the current page selection.
   * @returns {{text: string, html: string, url: string, title: string, hostname: string, paragraph: string, capturedAt: string}}
   */
  function captureSelection() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    let html = "";
    let paragraph = "";

    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const container = document.createElement("div");
      container.appendChild(range.cloneContents());
      html = container.innerHTML;

      let node = range.commonAncestorContainer;
      if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      const block = node && node.closest
        ? node.closest("p, li, blockquote, figcaption, article, section, td, div")
        : null;
      if (block) paragraph = (block.innerText || block.textContent || "").trim();
    }

    return {
      text,
      html,
      url: location.href,
      title: document.title,
      hostname: location.hostname,
      paragraph,
      capturedAt: new Date().toISOString(),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "h2a:capture-selection") {
      try {
        sendResponse({ ok: true, payload: captureSelection() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
      return true;
    }
    if (msg.type === "h2a:ping") {
      sendResponse({ ok: true, pong: true });
      return true;
    }
    return false;
  });

  console.debug(TAG, "ready", location.host);
})();
