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

    // Derive the surrounding sentence so the back of the card can
    // carry it as an extra field. Mirrors src/anki.js#extractSentence
    // but lives inline because the content script is not a module.
    let sentence = "";
    if (paragraph && text && paragraph !== text && paragraph.indexOf(text) !== -1) {
      const parts = paragraph
        .split(/(?<=[.!?\u2026])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const s of parts) {
        if (s.indexOf(text) !== -1) {
          if (s !== text && s !== paragraph) sentence = s;
          break;
        }
      }
    }

    return {
      text,
      html,
      url: location.href,
      title: document.title,
      hostname: location.hostname,
      paragraph,
      sentence,
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
    if (msg.type === "h2a:start-reading-mode") {
      try {
        startReadingMode(msg.payload || {})
          .then((verdict) => sendResponse({ ok: true, payload: verdict }))
          .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
      return true;
    }
    return false;
  });

  /**
   * Mount a distraction-free reading overlay on top of the page,
   * surfacing the staged capture (selection text, surrounding
   * paragraph, source) in a calm, focused surface. Resolves with
   * `{ action: "confirm" }` when the user presses Cmd/Ctrl+Enter or
   * clicks Send, or `{ action: "cancel" }` for Escape / Cancel /
   * backdrop click. Mirrors the liquid-glass aesthetic.
   *
   * @param {object} entry pending capture entry
   * @returns {Promise<{ action: "confirm" | "cancel" }>}
   */
  function startReadingMode(entry) {
    const READ_OVERLAY_ID = "__h2a_read_overlay__";
    const existing = document.getElementById(READ_OVERLAY_ID);
    if (existing) existing.remove();

    return new Promise((resolve) => {
      const text = (entry && entry.text) || "";
      const paragraph = (entry && entry.paragraph) || "";
      const title = (entry && entry.title) || document.title || "";
      const url = (entry && entry.url) || location.href || "";
      const hostname = (entry && entry.hostname) || location.hostname || "";

      const overlay = document.createElement("div");
      overlay.id = READ_OVERLAY_ID;
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Reading mode");
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483646",
        background: "radial-gradient(ellipse at 20% 10%, rgba(120,170,255,0.18), transparent 55%), radial-gradient(ellipse at 80% 90%, rgba(180,120,255,0.16), transparent 60%), rgba(8, 10, 18, 0.72)",
        backdropFilter: "blur(24px) saturate(140%)",
        webkitBackdropFilter: "blur(24px) saturate(140%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 24px",
        opacity: "0",
        transition: "opacity 220ms cubic-bezier(0.16,1,0.3,1)",
      });

      const card = document.createElement("div");
      Object.assign(card.style, {
        position: "relative",
        width: "min(720px, 100%)",
        maxHeight: "calc(100vh - 80px)",
        overflow: "auto",
        padding: "32px 36px 28px",
        borderRadius: "24px",
        background: "rgba(20, 22, 32, 0.62)",
        border: "1px solid rgba(255,255,255,0.14)",
        boxShadow: "0 30px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.16)",
        backdropFilter: "blur(40px) saturate(180%)",
        webkitBackdropFilter: "blur(40px) saturate(180%)",
        color: "rgba(245,247,253,0.94)",
        font: "400 16px/1.55 -apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Text', system-ui, sans-serif",
        letterSpacing: "-0.01em",
        transform: "translateY(6px) scale(0.985)",
        transition: "transform 220ms cubic-bezier(0.16,1,0.3,1)",
      });

      const accent = document.createElement("div");
      Object.assign(accent.style, {
        position: "absolute",
        top: "-60px",
        right: "-40px",
        width: "220px",
        height: "220px",
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(120,170,255,0.45), transparent 70%)",
        filter: "blur(40px)",
        pointerEvents: "none",
      });
      card.appendChild(accent);

      const meta = document.createElement("div");
      meta.style.cssText = "display:flex;align-items:center;gap:10px;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:rgba(245,247,253,0.62);margin-bottom:18px;";
      const dot = document.createElement("span");
      dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:rgb(120,170,255);box-shadow:0 0 12px rgba(120,170,255,0.8);";
      const metaLabel = document.createElement("span");
      metaLabel.textContent = "Reading mode";
      const sep = document.createElement("span");
      sep.textContent = "\u00b7";
      sep.style.opacity = "0.5";
      const host = document.createElement("span");
      host.textContent = hostname || "";
      host.style.textTransform = "none";
      host.style.letterSpacing = "0";
      meta.append(dot, metaLabel);
      if (hostname) meta.append(sep, host);
      card.appendChild(meta);

      if (title) {
        const h = document.createElement("div");
        h.textContent = title;
        h.style.cssText = "font-size:13px;color:rgba(245,247,253,0.72);margin-bottom:14px;letter-spacing:0;";
        card.appendChild(h);
      }

      const passage = document.createElement("blockquote");
      passage.style.cssText = "margin:0 0 22px;padding:0 0 0 18px;border-left:2px solid rgba(120,170,255,0.6);font-size:22px;line-height:1.5;color:rgba(255,255,255,0.96);font-weight:500;";
      passage.textContent = text || "(no selection)";
      card.appendChild(passage);

      if (paragraph && paragraph !== text) {
        const ctx = document.createElement("div");
        ctx.style.cssText = "font-size:15px;line-height:1.6;color:rgba(245,247,253,0.74);margin-bottom:24px;";
        const idx = text ? paragraph.indexOf(text) : -1;
        if (idx >= 0 && text) {
          ctx.appendChild(document.createTextNode(paragraph.slice(0, idx)));
          const mark = document.createElement("mark");
          mark.textContent = text;
          mark.style.cssText = "background:rgba(120,170,255,0.22);color:rgba(255,255,255,0.98);padding:0 2px;border-radius:3px;";
          ctx.appendChild(mark);
          ctx.appendChild(document.createTextNode(paragraph.slice(idx + text.length)));
        } else {
          ctx.textContent = paragraph;
        }
        card.appendChild(ctx);
      }

      const footer = document.createElement("div");
      footer.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:8px;padding-top:18px;border-top:1px solid rgba(255,255,255,0.08);";

      const src = document.createElement("a");
      src.href = url || "#";
      src.target = "_blank";
      src.rel = "noopener";
      src.textContent = (url || "").replace(/^https?:\/\//, "").slice(0, 60);
      src.style.cssText = "font-size:12px;color:rgba(245,247,253,0.55);text-decoration:none;letter-spacing:0;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:10px;";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = "appearance:none;padding:10px 16px;border-radius:12px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.04);color:rgba(245,247,253,0.85);font:500 13px/1 -apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;letter-spacing:-0.01em;cursor:pointer;transition:background 180ms cubic-bezier(0.16,1,0.3,1),border-color 180ms cubic-bezier(0.16,1,0.3,1);";
      cancelBtn.addEventListener("mouseenter", () => { cancelBtn.style.background = "rgba(255,255,255,0.08)"; });
      cancelBtn.addEventListener("mouseleave", () => { cancelBtn.style.background = "rgba(255,255,255,0.04)"; });

      const sendBtn = document.createElement("button");
      sendBtn.type = "button";
      const sendIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      sendIcon.setAttribute("width", "14");
      sendIcon.setAttribute("height", "14");
      sendIcon.setAttribute("viewBox", "0 0 24 24");
      sendIcon.setAttribute("fill", "none");
      sendIcon.setAttribute("stroke", "currentColor");
      sendIcon.setAttribute("stroke-width", "1.5");
      sendIcon.setAttribute("stroke-linecap", "round");
      sendIcon.setAttribute("stroke-linejoin", "round");
      sendIcon.innerHTML = '<path d="M5 12l14-7-4 14-3-6-7-1z"/>';
      const sendLabel = document.createElement("span");
      sendLabel.textContent = "Send to Anki";
      sendBtn.append(sendIcon, sendLabel);
      sendBtn.style.cssText = "appearance:none;display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:12px;border:1px solid rgba(120,170,255,0.55);background:linear-gradient(180deg, rgba(120,170,255,0.95), rgba(90,140,235,0.95));color:rgb(8,12,22);font:600 13px/1 -apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif;letter-spacing:-0.01em;cursor:pointer;box-shadow:0 6px 24px rgba(120,170,255,0.35), inset 0 1px 0 rgba(255,255,255,0.6);transition:transform 180ms cubic-bezier(0.16,1,0.3,1),box-shadow 180ms cubic-bezier(0.16,1,0.3,1);";
      sendBtn.addEventListener("mouseenter", () => { sendBtn.style.transform = "translateY(-1px)"; });
      sendBtn.addEventListener("mouseleave", () => { sendBtn.style.transform = "translateY(0)"; });

      actions.append(cancelBtn, sendBtn);
      footer.append(src, actions);
      card.appendChild(footer);
      overlay.appendChild(card);
      document.documentElement.appendChild(overlay);

      requestAnimationFrame(() => {
        overlay.style.opacity = "1";
        card.style.transform = "translateY(0) scale(1)";
      });

      let settled = false;
      const finish = (action) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("keydown", onKey, true);
        overlay.style.opacity = "0";
        card.style.transform = "translateY(4px) scale(0.985)";
        setTimeout(() => { try { overlay.remove(); } catch (_) {} }, 180);
        resolve({ action });
      };

      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish("cancel"); }
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); finish("confirm"); }
      };
      window.addEventListener("keydown", onKey, true);
      cancelBtn.addEventListener("click", () => finish("cancel"));
      sendBtn.addEventListener("click", () => finish("confirm"));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) finish("cancel"); });
      setTimeout(() => { try { sendBtn.focus(); } catch (_) {} }, 60);
    });
  }

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
