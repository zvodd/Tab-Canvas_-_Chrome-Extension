/* canvas.js — renders window groups, handles lasso + checkbox selection,
   and wires the JSON remap panel to the TabMap API. */
(function () {
  "use strict";

  const canvasEl = document.getElementById("canvas");
  const lassoEl = document.getElementById("lasso");
  const jsonPanel = document.getElementById("json-panel");
  const jsonEditor = document.getElementById("json-editor");
  const jsonStatus = document.getElementById("json-status");
  const selectionCount = document.getElementById("selection-count");
  const stashListEl = document.getElementById("stash-list");
  const trashListEl = document.getElementById("trash-list");
  const stashCountEl = document.getElementById("stash-count");
  const trashCountEl = document.getElementById("trash-count");
  const sidePanel = document.getElementById("side-panel");
  const sideResizer = document.getElementById("side-resizer");

  /** Set of selected tabIds. */
  const selected = new Set();

  /** Stash entries: [{ url, title, favIconUrl, stashedAt }]. Persisted.
   *  A reading list — stashing closes the tab and keeps it here for reopening
   *  or markdown export. */
  let stash = [];
  /** Trash entries: [{ url, title, favIconUrl, closedAt }]. Persisted. */
  let trash = [];

  /** This extension page's own tab, so we can refocus it and avoid stashing it. */
  let selfTab = null;

  async function ensureSelfTab() {
    if (!selfTab) {
      try { selfTab = await chrome.tabs.getCurrent(); } catch { selfTab = null; }
    }
    return selfTab;
  }

  /** Bring the Tab Reorganizer window + tab back to the front. Call after any
   *  operation that may have shifted focus to another window. */
  async function refocusSelf() {
    const me = await ensureSelfTab();
    if (!me) return;
    try {
      await chrome.windows.update(me.windowId, { focused: true });
    } catch { /* window may be gone */ }
    try {
      await chrome.tabs.update(me.id, { active: true });
    } catch { /* tab may be gone */ }
  }

  /** Undo/redo stacks of selection snapshots (cloned Sets of tabIds). */
  const history = {
    undoStack: [],
    redoStack: [],
    commit(prevState) {
      this.undoStack.push(prevState);
      this.redoStack = [];
    },
    snapshot() {
      return new Set(selected);
    },
    undo() {
      if (this.undoStack.length === 0) return false;
      this.redoStack.push(new Set(selected));
      replaceSelection(this.undoStack.pop());
      return true;
    },
    redo() {
      if (this.redoStack.length === 0) return false;
      this.undoStack.push(new Set(selected));
      replaceSelection(this.redoStack.pop());
      return true;
    },
  };

  function replaceSelection(newSet) {
    selected.clear();
    for (const id of newSet) selected.add(id);
    syncSelectionUI();
  }

  /* ---------- rendering ---------- */

  async function render() {
    await ensureSelfTab();
    const snap = await TabMap.snapshot();
    const windows = await chrome.windows.getAll({});
    const focusedWindowId = windows.find((w) => w.focused)?.id;
    const groups = TabMap.groupByWindows(snap.tabs);

    // A re-render recreates rows; any in-flight lasso preview is now stale.
    cancelLasso();
    canvasEl.querySelectorAll(".window-group, #empty-state").forEach((el) => el.remove());

    if (groups.length === 0) {
      const empty = document.createElement("div");
      empty.id = "empty-state";
      empty.textContent = "No tabs found.";
      canvasEl.appendChild(empty);
    } else {
      for (const group of groups) {
        canvasEl.appendChild(renderWindowGroup(group, group.windowId === focusedWindowId));
      }
    }

    renderSidePanel();
    // Drop selection entries whose tabs no longer exist.
    const liveTabIds = new Set(snap.tabs.map((t) => t.tabId));
    for (const id of [...selected]) if (!liveTabIds.has(id)) selected.delete(id);
    syncSelectionUI();
  }

  function renderWindowGroup(group, isFocused) {
    const box = document.createElement("section");
    box.className = "window-group";
    box.dataset.windowId = group.windowId;

    const header = document.createElement("div");
    header.className = "window-header";

    const title = document.createElement("span");
    title.textContent = `Window ${group.windowId} `;
    title.title = "Drag here to lasso-select";
    header.appendChild(title);

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${group.tabs.length} tab${group.tabs.length === 1 ? "" : "s"}`;
    header.appendChild(count);

    if (isFocused) {
      const dot = document.createElement("span");
      dot.className = "focused-dot";
      dot.title = "Focused window";
      header.appendChild(dot);
    }

    const selectWindowBtn = document.createElement("button");
    selectWindowBtn.textContent = "select";
    selectWindowBtn.title = "Select all tabs in this window";
    selectWindowBtn.addEventListener("click", () => {
      const prev = history.snapshot();
      for (const tab of group.tabs) selected.add(tab.tabId);
      syncSelectionUI();
      history.commit(prev);
    });
    header.appendChild(selectWindowBtn);

    const clearWindowBtn = document.createElement("button");
    clearWindowBtn.textContent = "clear";
    clearWindowBtn.title = "Deselect all tabs in this window";
    clearWindowBtn.addEventListener("click", () => {
      const prev = history.snapshot();
      for (const tab of group.tabs) selected.delete(tab.tabId);
      syncSelectionUI();
      history.commit(prev);
    });
    header.appendChild(clearWindowBtn);

    const list = document.createElement("div");
    list.className = "tab-list";

    for (const tab of group.tabs) {
      list.appendChild(renderTabRow(tab));
    }

    box.appendChild(header);
    box.appendChild(list);
    return box;
  }

  function renderTabRow(tab) {
    const row = document.createElement("div");
    row.className = "tab-row";
    row.dataset.tabId = tab.tabId;

    if (tab.favIconUrl) {
      const fav = document.createElement("img");
      fav.src = tab.favIconUrl;
      fav.onerror = () => fav.remove();
      fav.alt = "";
      row.appendChild(fav);
    }

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title || tab.url || "(untitled)";
    title.title = tab.url;
    row.appendChild(title);

    const id = document.createElement("span");
    id.className = "tab-id";
    id.textContent = `#${tab.tabId}`;
    row.appendChild(id);

    // Checkbox pinned to the right of the row.
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(tab.tabId);
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      setSelected(tab.tabId, checkbox.checked);
    });
    row.appendChild(checkbox);

    row.addEventListener("click", () => {
      setSelected(tab.tabId, !selected.has(tab.tabId));
    });

    return row;
  }

  /* ---------- selection ---------- */

  function setSelected(tabId, on) {
    const prev = history.snapshot();
    if (on) selected.add(tabId);
    else selected.delete(tabId);
    syncSelectionUI();
    history.commit(prev);
  }

  function syncSelectionUI() {
    for (const row of canvasEl.querySelectorAll(".tab-row")) {
      const on = selected.has(Number(row.dataset.tabId));
      row.classList.toggle("selected", on);
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = on;
    }
    selectionCount.textContent = selected.size ? `${selected.size} selected` : "";
  }

  /* ---------- side panel: stash + trash ---------- */

  function renderSidePanel() {
    // Stash — newest first.
    stashListEl.replaceChildren();
    stashCountEl.textContent = stash.length ? `${stash.length}` : "";
    if (stash.length === 0) {
      stashListEl.appendChild(emptyHint("Stashed tabs appear here"));
    } else {
      for (const item of [...stash].reverse()) stashListEl.appendChild(stashItem(item));
    }

    // Trash — newest first.
    trashListEl.replaceChildren();
    trashCountEl.textContent = trash.length ? `${trash.length}` : "";
    if (trash.length === 0) {
      trashListEl.appendChild(emptyHint("Closed tabs appear here"));
    } else {
      for (const item of [...trash].reverse()) trashListEl.appendChild(trashItem(item));
    }
  }

  function emptyHint(text) {
    const el = document.createElement("div");
    el.className = "side-empty";
    el.textContent = text;
    return el;
  }

  function stashItem(item) {
    const row = document.createElement("div");
    row.className = "side-item";

    if (item.favIconUrl) {
      const fav = document.createElement("img");
      fav.src = item.favIconUrl;
      fav.onerror = () => fav.remove();
      fav.alt = "";
      row.appendChild(fav);
    }

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = item.title || item.url || "(untitled)";
    title.title = item.url || "";
    row.appendChild(title);

    const restore = document.createElement("button");
    restore.className = "restore-btn";
    restore.textContent = "open";
    restore.title = "Reopen in a new window";
    restore.addEventListener("click", () => reopenStashItem(item));
    row.appendChild(restore);

    const rm = document.createElement("button");
    rm.className = "rm-btn";
    rm.textContent = "×";
    rm.title = "Remove from stash";
    rm.addEventListener("click", () => removeFromStash(item));
    row.appendChild(rm);
    return row;
  }

  function trashItem(item) {
    const row = document.createElement("div");
    row.className = "side-item";

    if (item.favIconUrl) {
      const fav = document.createElement("img");
      fav.src = item.favIconUrl;
      fav.onerror = () => fav.remove();
      fav.alt = "";
      row.appendChild(fav);
    }

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = item.title || item.url || "(untitled)";
    title.title = item.url || "";
    row.appendChild(title);

    const restore = document.createElement("button");
    restore.className = "restore-btn";
    restore.textContent = "restore";
    restore.title = "Reopen in a new window";
    restore.addEventListener("click", () => restoreFromTrash(item));
    row.appendChild(restore);

    const rm = document.createElement("button");
    rm.className = "rm-btn";
    rm.textContent = "×";
    rm.title = "Forget this entry";
    rm.addEventListener("click", () => removeFromTrash(item));
    row.appendChild(rm);
    return row;
  }

  async function reopenStashItem(item) {
    try {
      await chrome.windows.create({ url: item.url, focused: false });
    } catch (err) {
      setStatus(`Reopen failed: ${err.message}`, true);
      return;
    }
    await refocusSelf();
  }

  async function removeFromStash(item) {
    stash = stash.filter((t) => t !== item);
    await persistStash();
    await render();
  }

  async function exportStashMarkdown() {
    if (stash.length === 0) {
      setStatus("Stash is empty.", true);
      return;
    }
    const md = [...stash].reverse()
      .map((t) => `- [${t.title || "(untitled)"}](${t.url || ""})`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(md);
      setStatus(`Copied ${stash.length} stash item(s) as markdown.`);
    } catch (err) {
      setStatus(`Copy failed: ${err.message}`, true);
    }
  }

  async function restoreFromTrash(item) {
    try {
      await chrome.windows.create({ url: item.url, focused: false });
    } catch (err) {
      setStatus(`Reopen failed: ${err.message}`, true);
      return;
    }
    trash = trash.filter((t) => t !== item);
    await persistTrash();
    await render();
    await refocusSelf();
  }

  async function removeFromTrash(item) {
    trash = trash.filter((t) => t !== item);
    await persistTrash();
    await render();
  }

  /* ---------- persistence ---------- */

  async function persistStash() {
    try {
      await chrome.storage.local.set({ stash });
    } catch { /* storage unavailable */ }
  }

  async function persistTrash() {
    try {
      await chrome.storage.local.set({ trash });
    } catch { /* storage unavailable */ }
  }

  async function loadPersisted() {
    try {
      const data = await chrome.storage.local.get(["stash", "trash"]);
      stash = Array.isArray(data.stash) ? data.stash : [];
      trash = Array.isArray(data.trash) ? data.trash : [];
    } catch {
      stash = [];
      trash = [];
    }
  }

  /* ---------- lasso (state machine) ----------
     States: idle (lasso === null) | pending | active.

     The golden rule: the `.selected` class always mirrors the `selected` Set.
     During a drag, hits are shown with a *transient* `.lasso-hit` class, never
     by writing `.selected`. The Set is only mutated on a committed pointerup.
     Every terminal event — pointerup, pointercancel, lostpointercapture, or a
     re-render — runs endLasso(), which is idempotent, so the preview/state can
     never get stuck and lie about the real selection. */

  const DRAG_THRESHOLD = 4; // px before a pointerdown becomes a lasso
  let lasso = null;

  canvasEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, .tab-row")) return; // they have their own clicks

    // Defensive: abandon any lasso that never received a terminal event.
    if (lasso) endLasso(false);

    lasso = {
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      additive: e.ctrlKey || e.shiftKey,
      onBackground: e.target === canvasEl,
      rect: null,
    };
    try {
      canvasEl.setPointerCapture(e.pointerId);
    } catch {
      /* element detached or capture unavailable */
    }
  });

  canvasEl.addEventListener("pointermove", (e) => {
    if (!lasso || e.pointerId !== lasso.pointerId) return;

    const dx = e.clientX - lasso.sx;
    const dy = e.clientY - lasso.sy;
    if (!lasso.rect && Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // still a click

    const x1 = Math.min(lasso.sx, e.clientX);
    const y1 = Math.min(lasso.sy, e.clientY);
    const x2 = Math.max(lasso.sx, e.clientX);
    const y2 = Math.max(lasso.sy, e.clientY);

    const canvasRect = canvasEl.getBoundingClientRect();
    lassoEl.classList.remove("hidden");
    lassoEl.style.left = `${x1 - canvasRect.left + canvasEl.scrollLeft}px`;
    lassoEl.style.top = `${y1 - canvasRect.top + canvasEl.scrollTop}px`;
    lassoEl.style.width = `${x2 - x1}px`;
    lassoEl.style.height = `${y2 - y1}px`;

    lasso.rect = { left: x1, top: y1, right: x2, bottom: y2 };
    preview(lasso.rect);
  });

  canvasEl.addEventListener("pointerup", (e) => {
    if (!lasso || e.pointerId !== lasso.pointerId) return;
    endLasso(true);
  });

  // pointercancel: OS/browser took over (touch scroll, context menu, blur…).
  // lostpointercapture: capture released unexpectedly. Both must discard the
  // in-flight lasso without committing — no desync, no stale box.
  canvasEl.addEventListener("pointercancel", (e) => {
    if (lasso && lasso.pointerId === e.pointerId) endLasso(false);
  });
  canvasEl.addEventListener("lostpointercapture", (e) => {
    if (lasso && lasso.pointerId === e.pointerId) endLasso(false);
  });

  function endLasso(commit) {
    if (!lasso) return;
    const state = lasso;
    lasso = null;
    try {
      canvasEl.releasePointerCapture(state.pointerId);
    } catch {
      /* already released */
    }
    lassoEl.classList.add("hidden");

    if (commit && state.rect) {
      applyLasso(state.rect, state.additive);
    } else if (commit && !state.rect && state.onBackground) {
      // plain click on the black canvas → deselect everything
      const prev = history.snapshot();
      selected.clear();
      clearPreview();
      syncSelectionUI();
      history.commit(prev);
    } else {
      // cancel: discard preview, leave the selection model untouched
      clearPreview();
    }
  }

  function cancelLasso() {
    endLasso(false);
  }

  // A row's own getBoundingClientRect() ignores clipping: a row scrolled out
  // of view inside a scrollable ancestor (.tab-list, .window-group, #canvas)
  // still reports its full geometric rect, so a lasso drawn over the visible
  // card would otherwise also snag tabs hidden behind that overflow. Clip the
  // row's rect down to the visible intersection of every scrolling ancestor
  // up to (and including) the canvas before testing overlap.
  function visibleRect(el) {
    let rect = el.getBoundingClientRect();
    let node = el.parentElement;
    while (node) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) {
        const cr = node.getBoundingClientRect();
        rect = {
          left: Math.max(rect.left, cr.left),
          top: Math.max(rect.top, cr.top),
          right: Math.min(rect.right, cr.right),
          bottom: Math.min(rect.bottom, cr.bottom),
        };
      }
      if (node === canvasEl) break;
      node = node.parentElement;
    }
    return rect;
  }

  function rowsInRect(rect) {
    const hits = [];
    for (const row of canvasEl.querySelectorAll(".tab-row")) {
      const r = visibleRect(row);
      if (r.left >= r.right || r.top >= r.bottom) continue; // fully clipped, not actually visible
      const overlaps =
        r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top;
      if (overlaps) hits.push(row);
    }
    return hits;
  }

  // Transient preview only — never touches `.selected`.
  function preview(rect) {
    const hits = new Set(rowsInRect(rect));
    for (const row of canvasEl.querySelectorAll(".tab-row")) {
      row.classList.toggle("lasso-hit", hits.has(row));
    }
  }

  function clearPreview() {
    for (const row of canvasEl.querySelectorAll(".tab-row.lasso-hit")) {
      row.classList.remove("lasso-hit");
    }
  }

  function applyLasso(rect, additive) {
    clearPreview();
    const prev = history.snapshot();
    if (!additive) selected.clear();
    for (const row of rowsInRect(rect)) {
      selected.add(Number(row.dataset.tabId));
    }
    syncSelectionUI();
    history.commit(prev);
  }

  /* ---------- JSON remap panel ---------- */

  document.getElementById("toggle-json").addEventListener("click", () => {
    jsonPanel.classList.toggle("hidden");
  });

  document.getElementById("export-json").addEventListener("click", async () => {
    // This JSON is prompt material for an LLM: include enough signal (title,
    // url, current window, pinned/active) for a model to cluster tabs by topic
    // and emit a remap of { tabId, windowId } (windowId = existing id or a
    // string key like "new:research" to create a new window).
    const snap = await TabMap.snapshot();
    let tabs = snap.tabs.map((t) => ({
      tabId: t.tabId,
      title: t.title,
      url: t.url,
      windowId: t.windowId,
      pinned: t.pinned,
      active: t.active,
    }));
    if (selected.size > 0) {
      tabs = tabs.filter((t) => selected.has(t.tabId));
    }
    const doc = {
      instructions:
        "Group these browser tabs by topic into windows. Output a JSON array remapping each tab: [{\"tabId\":<id>,\"windowId\":<existingWindowId or \"new:<topic>\">}]. Tabs sharing the same \"new:<topic>\" key go into the same new window.",
      tabs,
    };
    jsonEditor.value = JSON.stringify(doc, null, 2);
    jsonPanel.classList.remove("hidden");
    setStatus(`Exported ${tabs.length} tab${tabs.length === 1 ? "" : "s"}.`);
  });

  document.getElementById("copy-json").addEventListener("click", async () => {
    await navigator.clipboard.writeText(jsonEditor.value);
    setStatus("Copied to clipboard.");
  });

  document.getElementById("apply-remap").addEventListener("click", async () => {
    let remap;
    try {
      remap = JSON.parse(jsonEditor.value);
    } catch (err) {
      setStatus(`Invalid JSON: ${err.message}`, true);
      return;
    }
    setStatus("Applying…");
    const result = await TabMap.applyRemap(remap);
    if (result.errors.length > 0) {
      setStatus(`Moved ${result.moved}. Errors: ${result.errors.join("; ")}`, true);
    } else {
      const created =
        result.createdWindows.length > 0
          ? `, created window(s) ${result.createdWindows.map((w) => w.windowId).join(", ")}`
          : "";
      setStatus(`Moved ${result.moved} tab(s)${created}.`);
    }
    await render();
    await refocusSelf();
  });

  /* ---------- misc toolbar ---------- */

  document.getElementById("refresh").addEventListener("click", render);

  document.getElementById("stash-export-md").addEventListener("click", exportStashMarkdown);

  /* ---------- resizable side panel ---------- */

  function setSideWidth(px) {
    const clamped = Math.max(180, Math.min(px, Math.floor(window.innerWidth * 0.7)));
    sidePanel.style.setProperty("--side-w", `${clamped}px`);
    return clamped;
  }

  // Restore persisted width on load.
  chrome.storage.local.get("sideW").then((d) => {
    if (typeof d.sideW === "number") setSideWidth(d.sideW);
  });

  let resizing = null;
  sideResizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    resizing = { startX: e.clientX, startW: sidePanel.getBoundingClientRect().width };
    sideResizer.setPointerCapture(e.pointerId);
    sideResizer.classList.add("dragging");
  });
  sideResizer.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const dx = e.clientX - resizing.startX;
    setSideWidth(resizing.startW + dx);
  });
  const endResize = (e) => {
    if (!resizing) return;
    resizing = null;
    sideResizer.classList.remove("dragging");
    const w = sidePanel.getBoundingClientRect().width;
    chrome.storage.local.set({ sideW: w });
  };
  sideResizer.addEventListener("pointerup", endResize);
  sideResizer.addEventListener("pointercancel", endResize);

  document.getElementById("select-all").addEventListener("click", async () => {
    const prev = history.snapshot();
    const snap = await TabMap.snapshot();
    for (const tab of snap.tabs) selected.add(tab.tabId);
    syncSelectionUI();
    history.commit(prev);
  });

  document.getElementById("clear-selection").addEventListener("click", () => {
    const prev = history.snapshot();
    selected.clear();
    syncSelectionUI();
    history.commit(prev);
  });

  document.getElementById("close-selected").addEventListener("click", async () => {
    if (selected.size === 0) {
      setStatus("No tabs selected to close.", true);
      return;
    }
    const ids = [...selected];
    if (ids.length > 1 && !confirm(`Close ${ids.length} selected tabs?`)) return;
    // Record each closed tab into the trash list before removing it, so the
    // side panel can offer a one-click reopen.
    const snap = await TabMap.snapshot();
    const byId = new Map(snap.tabs.map((t) => [t.tabId, t]));
    for (const id of ids) {
      const t = byId.get(id);
      if (!t || !t.url) continue;
      trash.push({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, closedAt: Date.now() });
    }
    await persistTrash();
    try {
      await chrome.tabs.remove(ids);
    } catch (err) {
      setStatus(`Close failed: ${err.message}`, true);
      return;
    }
    selected.clear();
    syncSelectionUI();
    await render();
    await refocusSelf();
  });

  document.getElementById("merge-selected").addEventListener("click", async () => {
    if (selected.size === 0) {
      setStatus("No tabs selected to merge.", true);
      return;
    }
    // Merging is just a remap where every selected tab targets the same new
    // window key — TabMap.applyRemap creates one new window and moves the rest
    // in. No reuse-existing-window branch: if a source window is fully
    // selected it empties and Chrome closes it, ending in the same one-window
    // result with less code.
    const remap = [...selected].map((tabId) => ({ tabId, windowId: "new:merged" }));
    setStatus("Merging…");
    const result = await TabMap.applyRemap(remap);
    if (result.errors.length > 0) {
      setStatus(`Merged ${result.moved}, errors: ${result.errors.join("; ")}`, true);
    } else {
      setStatus(`Merged ${result.moved} tab(s) into new window.`);
    }
    await render();
    await refocusSelf();
  });

  document.getElementById("stash-selected").addEventListener("click", async () => {
    if (selected.size === 0) {
      setStatus("No tabs selected to stash.", true);
      return;
    }
    await ensureSelfTab();
    // Never stash the Tab Reorganizer tab itself — it would close this UI.
    const ids = [...selected].filter((id) => id !== selfTab?.id);
    if (ids.length === 0) {
      setStatus("Nothing stashable selected.", true);
      return;
    }
    if (ids.length > 1 && !confirm(`Stash ${ids.length} tabs to the reading list?`)) return;
    // Record each tab into the stash list (url/title/favicon), then close it.
    const snap = await TabMap.snapshot();
    const byId = new Map(snap.tabs.map((t) => [t.tabId, t]));
    const entries = [];
    for (const id of ids) {
      const t = byId.get(id);
      if (!t || !t.url) continue;
      entries.push({ url: t.url, title: t.title, favIconUrl: t.favIconUrl, stashedAt: Date.now() });
    }
    stash = [...stash, ...entries];
    await persistStash();
    try {
      await chrome.tabs.remove(ids);
    } catch (err) {
      setStatus(`Stash failed: ${err.message}`, true);
      await render();
      return;
    }
    selected.clear();
    syncSelectionUI();
    setStatus(`Stashed ${entries.length} tab(s) to reading list.`);
    await render();
    await refocusSelf();
  });

  // Undo/redo of the selection area: Ctrl-Z / Ctrl-Shift-Z / Ctrl-Y.
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const key = e.key.toLowerCase();
    const isRedo = (e.shiftKey && key === "z") || key === "y";
    const isUndo = key === "z" && !e.shiftKey;
    if (!isUndo && !isRedo) return;
    // Don't hijack typing in the JSON editor or other inputs.
    if (e.target.closest("input, textarea")) return;
    e.preventDefault();
    const ok = isUndo ? history.undo() : history.redo();
    if (!ok) setStatus(isUndo ? "Nothing to undo" : "Nothing to redo", true);
  });

  function setStatus(msg, isError = false) {
    jsonStatus.textContent = msg;
    jsonStatus.style.color = isError ? "#ff7b72" : "";
  }

  // Auto-refresh when tabs change elsewhere in the browser.
  const refreshSoon = debounce(render, 300);
  for (const event of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved]) {
    event.addListener(refreshSoon);
  }

  function debounce(fn, ms) {
    let timer;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  // Boot: load persisted stash/trash state, then render.
  loadPersisted().then(render);
})();
