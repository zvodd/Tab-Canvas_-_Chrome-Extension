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

  /** Set of selected tabIds. */
  const selected = new Set();

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
      return;
    }

    for (const group of groups) {
      canvasEl.appendChild(renderWindowGroup(group, group.windowId === focusedWindowId));
    }
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

  function rowsInRect(rect) {
    const hits = [];
    for (const row of canvasEl.querySelectorAll(".tab-row")) {
      const r = row.getBoundingClientRect();
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
    const snap = await TabMap.snapshot();
    let list = TabMap.toRemapList(snap);
    if (selected.size > 0) {
      list = list.filter((item) => selected.has(item.tabId));
    }
    jsonEditor.value = JSON.stringify(list, null, 2);
    jsonPanel.classList.remove("hidden");
    setStatus(`Exported ${list.length} tab${list.length === 1 ? "" : "s"}.`);
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
  });

  /* ---------- misc toolbar ---------- */

  document.getElementById("refresh").addEventListener("click", render);

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

  render();
})();
