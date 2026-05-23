// Highlight to Anki — content script scaffolding
// Runs in the page context. Captures the current selection plus
// minimal source metadata and forwards it to the background service
// worker on request. Kept intentionally small; feature modules will
// hang off the message router below.

(() => {
  if (window.__highlightToAnkiContentLoaded) return;
  window.__highlightToAnkiContentLoaded = true;

  const TAG = "[highlight-to-anki:content]";
  const SHOT_OVERLAY_ID = "__h2a_shot_overlay__";

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
    if (msg.type === "h2a:start-region-capture") {
      try {
        startRegionCapture()
          .then((rect) => sendResponse({ ok: !!rect, payload: rect || null }))
          .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
      return true;
    }
    return false;
  });

  /**
   * Mount a liquid-glass selection overlay on top of the page and
   * resolve with the chosen rectangle (in CSS viewport pixels) plus
   * the source URL/title context. Resolves with null when the user
   * cancels with Escape or right-clicks.
   *
   * @returns {Promise<{ rect: {x:number,y:number,width:number,height:number}, devicePixelRatio:number, url:string, title:string, hostname:string }|null>}
   */
  function startRegionCapture() {
    const existing = document.getElementById(SHOT_OVERLAY_ID);
    if (existing) existing.remove();

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.id = SHOT_OVERLAY_ID;
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-label", "Drag to capture a screenshot region");
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483646",
        cursor: "crosshair",
        background: "rgba(8, 10, 18, 0.32)",
        backdropFilter: "blur(2px) saturate(120%)",
        webkitBackdropFilter: "blur(2px) saturate(120%)",
        userSelect: "none",
      });

      const hint = document.createElement("div");
      hint.textContent = "Drag to capture · Esc to cancel";
      Object.assign(hint.style, {
        position: "absolute",
        top: "16px",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "8px 14px",
        borderRadius: "999px",
        font: "500 12px/1.4 -apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Text', system-ui, sans-serif",
        letterSpacing: "-0.01em",
        color: "rgba(255,255,255,0.92)",
        background: "rgba(20, 22, 32, 0.55)",
        border: "1px solid rgba(255,255,255,0.18)",
        backdropFilter: "blur(20px) saturate(160%)",
        webkitBackdropFilter: "blur(20px) saturate(160%)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18)",
        pointerEvents: "none",
      });
      overlay.appendChild(hint);

      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "0",
        height: "0",
        border: "1.5px solid rgba(120, 170, 255, 0.95)",
        background: "rgba(120, 170, 255, 0.10)",
        boxShadow: "0 0 0 9999px rgba(8,10,18,0.18), inset 0 0 0 1px rgba(255,255,255,0.45)",
        borderRadius: "3px",
        pointerEvents: "none",
        display: "none",
      });
      overlay.appendChild(box);

      const dims = document.createElement("div");
      Object.assign(dims.style, {
        position: "absolute",
        padding: "3px 8px",
        borderRadius: "6px",
        font: "500 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "rgba(255,255,255,0.95)",
        background: "rgba(20, 22, 32, 0.78)",
        border: "1px solid rgba(255,255,255,0.15)",
        pointerEvents: "none",
        display: "none",
        transform: "translate(0, -110%)",
      });
      overlay.appendChild(dims);

      document.documentElement.appendChild(overlay);

      let start = null;

      const cleanup = () => {
        window.removeEventListener("keydown", onKey, true);
        overlay.removeEventListener("mousedown", onDown, true);
        overlay.removeEventListener("mousemove", onMove, true);
        overlay.removeEventListener("mouseup", onUp, true);
        overlay.removeEventListener("contextmenu", onContext, true);
        overlay.remove();
      };

      const finish = (rect) => {
        cleanup();
        if (!rect) return resolve(null);
        resolve({
          rect,
          devicePixelRatio: window.devicePixelRatio || 1,
          url: location.href,
          title: document.title,
          hostname: location.hostname,
        });
      };

      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      };

      const onContext = (e) => {
        e.preventDefault();
        finish(null);
      };

      const onDown = (e) => {
        if (e.button !== 0) return;
        start = { x: e.clientX, y: e.clientY };
        box.style.display = "block";
        dims.style.display = "block";
        updateBox(e.clientX, e.clientY);
        e.preventDefault();
      };

      const updateBox = (cx, cy) => {
        if (!start) return;
        const x = Math.min(start.x, cx);
        const y = Math.min(start.y, cy);
        const w = Math.abs(cx - start.x);
        const h = Math.abs(cy - start.y);
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
        dims.textContent = `${Math.round(w)} × ${Math.round(h)}`;
        dims.style.left = `${x}px`;
        dims.style.top = `${y - 4}px`;
      };

      const onMove = (e) => updateBox(e.clientX, e.clientY);

      const onUp = (e) => {
        if (!start) return;
        const x = Math.min(start.x, e.clientX);
        const y = Math.min(start.y, e.clientY);
        const w = Math.abs(e.clientX - start.x);
        const h = Math.abs(e.clientY - start.y);
        if (w < 4 || h < 4) {
          finish(null);
          return;
        }
        finish({ x, y, width: w, height: h });
      };

      window.addEventListener("keydown", onKey, true);
      overlay.addEventListener("mousedown", onDown, true);
      overlay.addEventListener("mousemove", onMove, true);
      overlay.addEventListener("mouseup", onUp, true);
      overlay.addEventListener("contextmenu", onContext, true);
    });
  }

  console.debug(TAG, "ready", location.host);
})();
