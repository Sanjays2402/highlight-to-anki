# Highlight to Anki

Select text on any page and send it to your local Anki deck via AnkiConnect — with the
source URL auto-cited and a card preview before anything is created.

## Requirements

- [Anki](https://apps.ankiweb.net/) desktop installed and running
- The [AnkiConnect](https://foosoft.net/projects/anki-connect) add-on installed
  (exposes `http://127.0.0.1:8765` locally)

## Install (dev)

```sh
git clone https://github.com/Sanjays2402/highlight-to-anki.git
cd highlight-to-anki
```

Then in Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → select this folder.
A first-run onboarding flow walks you through the AnkiConnect connection.

## Usage

Select any text on a page, then:

- **Right-click → Send to Anki** — creates a card from the selection
- **Right-click → Send to Anki as Cloze** — turns the selection into a cloze deletion
- **Right-click → Send to Anki (Reverse)** — generates a front/back-swapped card on demand
- **Right-click → Edit & Send to Anki…** — review and edit fields before sending
- **Right-click an image → Send Image to Anki** — uses the image as the card front
- **Ctrl+Shift+Y** (Mac: **Cmd+Shift+Y**) — send the current selection without the context menu

Card front: the selected text. Card back: the surrounding paragraph or sentence, the source
URL and page title as a citation link. Hostname and detected language are auto-tagged, and
bold/italic/code Markdown in the selection is preserved.

## Features

- **Duplicate detection** — warns before sending if the selection already exists as a card
  (exact match plus fuzzy Levenshtein matching)
- **Edit-before-send dialog** — preview and adjust fields before anything is created
- **Field templates per deck** and custom CSS injection for card styling per deck
- **Per-site default deck rules** — pick a deck once per site; selections follow it automatically
- **Batch mode** — queue multiple selections on a page, then send one card per selection
- **Pinned snippets** — save selections to send later in bulk
- **Selection screenshot mode** — capture a region of the page as a card image
- **Reading mode** — a distraction-free overlay to review before sending
- **Recent cards history** in the popup, with export to JSON
- **Card statistics dashboard** — counts by deck, tag, and day
- **Spaced-review queue** — an in-popup mini-reviewer for due cards via AnkiConnect
- **Toast notifications** with undo on send success/failure
- **AnkiConnect health check** with version display, plus configurable host/port
- Dark/light theme and a liquid-glass popup UI

## Options

Open the options page (extension options in `chrome://extensions`) to configure:

- Default deck and note model
- Per-deck field templates and card CSS
- Per-site default deck rules
- AnkiConnect host/port (defaults to `127.0.0.1:8765`)

## Permissions

- `contextMenus`, `storage`, `activeTab`, `scripting`
- Host access: `<all_urls>` (to read page selections) and `http://127.0.0.1:8765/*` (AnkiConnect)

All traffic to Anki stays on your machine; nothing leaves your browser.

## Troubleshooting

- **"AnkiConnect unreachable"** — make sure Anki desktop is open and the AnkiConnect add-on
  is installed and enabled, then use the health check in the popup to verify.
- **Cards not landing in the right deck** — check the default deck in options and any
  per-site deck rules you configured.
- **Nothing happens on shortcut** — the shortcut only fires when a tab has a live selection;
  right-click → "Send to Anki" works the same way.

## Development

```sh
npm test   # manifest + feature-wiring smoke tests
npm run lint
```

## License

MIT — see [LICENSE](LICENSE).
