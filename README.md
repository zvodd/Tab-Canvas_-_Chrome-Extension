# Tab Canvas

A Chrome Manifest V3 extension that renders every open tab as a canvas of
flex-box windows you can lasso-select and reorganize via JSON.

## Features

- **Canvas view** — one flex-box group per window; each tab is a row with
  favicon, title, tab id, and a checkbox pinned to the right.
- **Lasso selection** — drag on empty canvas space, or on a window-group title
  (it's just a drag handle), to sweep-select tabs. Ctrl/Shift-drag adds to the
  selection. Click rows or checkboxes to toggle.
- **Undo/redo selection** — Ctrl-Z / Ctrl-Shift-Z / Ctrl-Y across every
  selection action (lasso, toggle, select-all, clear, per-window select/clear,
  background deselect).
- **Background click** — a plain click on the black canvas clears the selection.
- **Per-window buttons** — `select` and `clear` act on a single window's tabs.
- **Remap API** — export tabs as JSON, edit the window ids, and apply:
  `windowId` may be a real window id or a string key like `"new:work"` to
  create a new window.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick this folder
3. Click the toolbar icon to open the canvas

## API (`lib/tabmap-api.js`, global `TabMap`)

| Function | Description |
|---|---|
| `snapshot()` | `Promise<{ takenAt, tabs: [{ tabId, windowId, title, url, index, active, pinned, favIconUrl }] }>` |
| `groupByWindows(tabs)` | Group a flat tab list into `[{ windowId, tabs }]` |
| `toRemapList(snap)` | Minimal editable list: `[{ tabId, title, windowId }]` |
| `validateRemap(items)` | Check a remap list against live state without moving anything |
| `applyRemap(items)` | Move tabs per `[{ tabId, windowId }]`; string keys create new windows. Resolves `{ moved, createdWindows, errors }` |

Example:

```json
[
  { "tabId": 123, "windowId": 456 },
  { "tabId": 124, "windowId": "new:research" },
  { "tabId": 125, "windowId": "new:research" }
]
```

Tabs 124 and 125 end up together in one freshly created window.
