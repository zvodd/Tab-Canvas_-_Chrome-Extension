# Tab Canvas

A Chrome Manifest V3 extension for people who live with hundreds of open tabs.
It renders every tab and window as a canvas of flex-box groups you can
lasso-select, inspect, and reorganize — by hand, or via a JSON remap that an LLM
can produce. It also stashes tabs into a reading list and tracks what you close.

> Built for power-tabbers: no artificial caps, no truncation you can't scroll
> past, and operations that always return focus to the reorganizer.

---

## Goals

The project set out to solve a few concrete pain points for heavy tab users:

1. **See everything at once.** A flat tab strip is a poor tool for dozens of
   tabs across many windows. The extension extracts a per-tab data structure
   (each tab carrying its **parent window**) and lays it out as one canvas of
   flex-box window groups — one column per window, tabs as rows.

2. **Bulk-select with a lasso (model UI).** Checkboxes are tedious at scale. A
   lasso tool lets you sweep-select tabs by dragging on the canvas background
   or a window title. Selection is a real, inspectable state with undo/redo.

3. **Reorganize structurally, not just drag-and-drop.** A remap API takes a
   list of `{ tabId, windowId }` and moves tabs into windows. String window ids
   (`"new:research"`) mean "create a fresh window and group these tabs into it."
   This makes programmatic / AI-driven reorganization possible.

4. **LLM-driven regrouping.** The export is deliberately prompt-shaped: each
   tab carries title, url, current window, and metadata, plus an
   `instructions` field describing the remap schema. Hand the JSON to a model,
   it clusters by topic and returns a remap array you paste back and apply.

5. **Stash, don't just close.** A reading list on the right: stashing closes a
   tab but remembers it (url/title/favicon) for later reopening or markdown
   export. Kept separate from the "trash" list of accidentally-closed tabs.

6. **Stay oriented.** Any operation that touches tabs refocuses the Tab
   Reorganizer window/tab, so the canvas stays on top instead of getting
   stranded behind a window it just moved things into.

---

## What's done

### Data layer (`lib/tabmap-api.js`)
A `TabMap` API (also `module.exports`-able for tests):

| Function | Description |
|---|---|
| `snapshot()` | `{ takenAt, tabs: [{ tabId, windowId, title, url, index, active, pinned, favIconUrl }] }` |
| `groupByWindows(tabs)` | Group a flat tab list into `[{ windowId, tabs }]` |
| `toRemapList(snap)` | Minimal editable list: `[{ tabId, title, windowId }]` |
| `validateRemap(items)` | Dry-run a remap against live state without moving anything |
| `applyRemap(items)` | Move tabs per `[{ tabId, windowId }]`; string keys create new windows. Resolves `{ moved, createdWindows, errors }` |

Validated with a mocked `chrome` API covering snapshot → group → export →
validate → applyRemap (including the new-window-creation path).

### Canvas view (`canvas.html` / `canvas.css` / `canvas.js`)
- One flex-box group per window; tabs are rows with favicon, title, tab id, and a
  checkbox pinned to the right.
- **Horizontal scrolling** for long titles in both the main area and the side
  panel (rows grow to `max-content`; the checkbox / action buttons are
  sticky to the right edge so they stay reachable).
- Per-window `select` and `clear` buttons in each group header.

### Lasso selection (state machine)
- Drag on empty canvas space **or** on a window-group title (its title has no
  other function) to sweep-select; Ctrl/Shift-drag adds to the selection.
- Plain click on the black canvas background clears the selection.
- **Golden rule:** the `.selected` class always mirrors the `selected` Set.
  During a drag, hits use a *transient* `.lasso-hit` class; the Set is only
  mutated on a committed `pointerup`. This prevents the desync bugs that come
  from previewing selection by writing the real `.selected` class.
- Every terminal event is handled: `pointerup` commits, `pointercancel` /
  `lostpointercapture` / a re-render all discard cleanly via an idempotent
  `endLasso()`. Pointer capture is taken on pointerdown and released on end.
- Drag threshold (4px) distinguishes a click from a lasso.

### Undo / redo
- `Ctrl-Z` / `Ctrl-Shift-Z` / `Ctrl-Y` across **every** selection action:
  lasso commit, row/checkbox toggle, background deselect, per-window
  select/clear, toolbar select-all/clear.
- Selection history is a pair of cloned-`Set` stacks (`undoStack` / `redoStack`).
- Keyboard shortcuts skip when focus is in the JSON editor / inputs, and report
  "Nothing to undo/redo" when the relevant stack is empty.

### Toolbar operations
- **Refresh** — re-snapshot.
- **Select all / Clear selection**.
- **Close selected** — closes the selected tabs (`chrome.tabs.remove`), recording
  each into the **Trash** list first; confirms when >1.
- **Merge selected** — moves all selected tabs into one new window. Implemented
  as a remap where every tab targets the same `new:merged` key (so it reuses the
  `applyRemap` machinery). No reuse-existing-window branch: if a source window
  is fully selected it empties and Chrome closes it, yielding the same one-window
  result with less code.
- **Stash selected** — closes the selected tabs and records them into the
  **Stash** reading list (url/title/favicon). Never stashes the reorganizer's
  own tab.

### JSON remap panel
- **Export JSON** — emits an LLM-oriented object: `{ instructions, tabs: [...] }`
  where each tab carries `tabId, title, url, windowId, pinned, active`. Filtered
  to the current selection when one exists.
- **Apply remap** — parses the editor as a `[{ tabId, windowId }]` array and runs
  `TabMap.applyRemap`. Guarded: a non-array (e.g. an exported doc) yields
  "Remap must be an array…".
- **Copy** — copies the editor contents to clipboard.
- Self-focus after apply.

### Side panel — Stash + Trash (`#side-panel`)
Lives **outside the lasso zone**; resizable via a drag handle between it and the
canvas (width persisted to `chrome.storage.local`).
- **Stash** (reading list) — newest-first; each entry has **open** (reopen in a
  new window; keeps the entry, so it's reusable) and **×** (remove). A **Copy MD**
  button exports the entire stash as a markdown checklist to the clipboard.
- **Trash** (tabs closed via the UI) — newest-first; each entry has **restore**
  (reopen in a new window; consumes the entry) and **×** (forget).
- Both lists are unbounded and persisted in `chrome.storage.local` (no caps —
  built for 500+ tab sets). Entries persist across browser/session reloads.

### Focus management
`refocusSelf()` caches this page's own tab (`chrome.tabs.getCurrent`) and, after
any tab-affecting op (close, merge, stash, restore, apply-remap), refocuses the
reorganizer window and activates its tab — so focus doesn't get snatched by a
window it just touched.

### Live updates
`chrome.tabs.onCreated` / `onRemoved` / `onMoved` trigger a debounced re-render,
so the canvas tracks external tab changes. A re-render cancels any in-flight
lasso (its rows are now stale).

### Shell
- MV3 manifest with `tabs` + `storage` permissions.
- Background service worker opens the canvas page on the toolbar action,
  reusing an existing canvas tab if one is open.

---

## Install

1. `chrome://extensions` → enable **Developer mode`
2. **Load unpacked** → pick this folder
3. Click the toolbar icon to open the canvas

---

## Remap schema

```json
[
  { "tabId": 123, "windowId": 456 },
  { "tabId": 124, "windowId": "new:research" },
  { "tabId": 125, "windowId": "new:research" }
]
```

Tabs 124 and 125 end up together in one freshly created window; tab 123 moves to
the existing window 456. Tabs whose source window becomes empty are closed by
Chrome automatically.

## LLM workflow

1. Select tabs (or none) → **Export JSON**.
2. Paste the resulting object into your model. The `instructions` field tells it
   the exact remap schema to return.
3. The model clusters by topic and returns a `[{ "tabId", "windowId" }]` array
   (using `new:<topic>` keys to group).
4. Paste that array into the JSON panel → **Apply remap**.
