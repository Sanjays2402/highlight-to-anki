# Highlight to Anki

Select text → send to local Anki via AnkiConnect with source URL auto-cited.

> Status: **v0.1.0 — scaffold**. Features ship every 15 minutes via an autonomous agent. See `ROADMAP.md` for what's next.

## Install (dev)

```
git clone https://github.com/Sanjays2402/highlight-to-anki.git
cd highlight-to-anki
```

Then in Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → select this folder.

## Permissions

- `contextMenus`
- `storage`
- `activeTab`
- `scripting`

**Host permissions:**
- `<all_urls>`
- `http://127.0.0.1:8765/*`

## Roadmap

- [ ] MV3 manifest + content script scaffolding
- [ ] Context menu: 'Send to Anki' on selection
- [ ] AnkiConnect health check + version display
- [ ] Default deck/model selection in options
- [ ] Card front: selection text, back: source URL + paragraph
- [ ] Cloze deletion mode (turn selection into cloze)
- [ ] Auto-tag with hostname
- [ ] Image capture: select image → add as front
- [ ] Batch mode: multi-select on page, one card per selection
- [ ] Recent cards history in popup
- [ ] Edit-before-send dialog
- [ ] Field templates per deck
- [ ] Sync status indicator
- [ ] Liquid-glass popup UI
- [ ] Dark/light theme

## License

MIT — see [LICENSE](LICENSE).
