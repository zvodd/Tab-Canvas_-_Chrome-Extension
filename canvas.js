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

  /* ---------- rendering ---------- */

  async function render() {
    const snap = await TabMap.snapshot();
    const windows = await chrome.windows.getAll({});
    const focusedWindowId = windows.find((w) => w.focused)?.id;
    const groups = TabMap.groupByWindows(snap.tabs);

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
      for (const tab of group.tabs) selected.add(tab.tabId);
      syncSelectionUI();
    });
    header.appendChild(selectWindowBtn);

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
    if (on) selected.add(tabId);
    else selected.delete(tabId);
    syncSelectionUI();
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

  /* ---------- lasso ---------- */
  // Drag on empty canvas space draws a rectangle; any tab row it touches
  // is added to the selection. Ctrl/Shift-drag adds to the selection,
  // plain drag replaces it.

  let lassoStart = null;

  canvasEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".tab-row, .window-header, button")) return;

    lassoStart = { x: e.clientX, y: e.clientY, additive: e.ctrlKey || e.shiftKey };
    canvasEl.setPointerCapture(e.pointerId);
  });

  canvasEl.addEventListener("pointermove", (e) => {
    if (!lassoStart) return;

    const x1 = Math.min(lassoStart.x, e.clientX);
    const y1 = Math.min(lassoStart.y, e.clientY);
    const x2 = Math.max(lassoStart.x, e.clientX);
    const y2 = Math.max(lassoStart.y, e.clientY);

    const canvasRect = canvasEl.getBoundingClientRect();
    lassoEl.classList.remove("hidden");
    lassoEl.style.left = `${x1 - canvasRect.left + canvasEl.scrollLeft}px`;
    lassoEl.style.top = `${y1 - canvasRect.top + canvasEl.scrollTop}px`;
    lassoEl.style.width = `${x2 - x1}px`;
    lassoEl.style.height = `${y2 - y1}px`;

    lassoStart.rect = { left: x1, top: y1, right: x2, bottom: y2 };
    previewLasso(lassoStart.rect, lassoStart.additive);
  });

  canvasEl.addEventListener("pointerup", () => {
    if (!lassoStart) return;
    if (lassoStart.rect) applyLasso(lassoStart.rect, lassoStart.additive);
    lassoStart = null;
    lassoEl.classList.add("hidden");
  });

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

  function previewLasso(rect, additive) {
    const hitRows = new Set(rowsInRect(rect));
    for (const row of canvasEl.querySelectorAll(".tab-row")) {
      const on = hitRows.has(row) || (additive && selected.has(Number(row.dataset.tabId)));
      row.classList.toggle("selected", on);
    }
  }

  function applyLasso(rect, additive) {
    if (!additive) selected.clear();
    for (const row of rowsInRect(rect)) {
      selected.add(Number(row.dataset.tabId));
    }
    syncSelectionUI();
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
    const snap = await TabMap.snapshot();
    for (const tab of snap.tabs) selected.add(tab.tabId);
    syncSelectionUI();
  });

  document.getElementById("clear-selection").addEventListener("click", () => {
    selected.clear();
    syncSelectionUI();
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
