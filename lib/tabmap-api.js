/**
 * TabMap API — extract a flat tab/window structure, group it, and remap it.
 *
 * Data model:
 *   Snapshot  = { takenAt, tabs: TabEntry[] }
 *   TabEntry  = { tabId, windowId, title, url, index, active, pinned, favIconUrl }
 *   RemapItem = { tabId, windowId }        windowId may be a real window id
 *                                          or a string key ("new:work") for
 *                                          a window to be created.
 */
(function (global) {
  "use strict";

  /** Extract the current tab list with each tab's parent window. */
  async function snapshot() {
    const tabs = await chrome.tabs.query({});
    return {
      takenAt: Date.now(),
      tabs: tabs.map((t) => ({
        tabId: t.id,
        windowId: t.windowId,
        title: t.title ?? "",
        url: t.url ?? "",
        index: t.index,
        active: Boolean(t.active),
        pinned: Boolean(t.pinned),
        favIconUrl: t.favIconUrl ?? "",
      })),
    };
  }

  /** Group a flat tab list into windows: [{ windowId, tabs: [...] }] */
  function groupByWindows(tabs) {
    const order = [];
    const byWindow = new Map();
    for (const tab of tabs) {
      let group = byWindow.get(tab.windowId);
      if (!group) {
        group = { windowId: tab.windowId, tabs: [] };
        byWindow.set(tab.windowId, group);
        order.push(group);
      }
      group.tabs.push(tab);
    }
    for (const group of order) {
      group.tabs.sort((a, b) => a.index - b.index);
    }
    return order;
  }

  /** Minimal JSON form for hand editing: [{ tabId, title, windowId }] */
  function toRemapList(snapshotData) {
    return snapshotData.tabs.map((t) => ({
      tabId: t.tabId,
      title: t.title,
      windowId: t.windowId,
    }));
  }

  function isRealWindowId(windowId) {
    return typeof windowId === "number" && windowId >= 0;
  }

  /** Validate a remap list against current live state. Returns { errors, items }. */
  async function validateRemap(remapItems) {
    const errors = [];
    if (!Array.isArray(remapItems)) {
      return { errors: ["Remap must be an array of { tabId, windowId }"], items: [] };
    }
    const liveTabs = await chrome.tabs.query({});
    const liveTabIds = new Set(liveTabs.map((t) => t.id));
    const windows = await chrome.windows.getAll();
    const liveWindowIds = new Set(windows.map((w) => w.id));

    const items = [];
    remapItems.forEach((item, i) => {
      if (typeof item.tabId !== "number") {
        errors.push(`item ${i}: missing numeric tabId`);
        return;
      }
      if (!liveTabIds.has(item.tabId)) {
        errors.push(`item ${i}: tab ${item.tabId} no longer exists`);
        return;
      }
      if (typeof item.windowId === "number" && isRealWindowId(item.windowId)) {
        if (!liveWindowIds.has(item.windowId)) {
          errors.push(`item ${i}: window ${item.windowId} no longer exists`);
          return;
        }
      } else if (typeof item.windowId !== "string") {
        errors.push(`item ${i}: windowId must be an existing window id or a string key`);
        return;
      }
      items.push({ tabId: item.tabId, windowId: item.windowId });
    });
    return { errors, items };
  }

  /**
   * Apply a remap list. For each distinct real windowId, tabs are moved to the
   * end of that window. For each distinct string key, one new window is created
   * and the key's tabs land in it.
   *
   * Returns { moved, createdWindows, errors }.
   */
  async function applyRemap(remapItems) {
    const { errors, items } = await validateRemap(remapItems);

    const groups = new Map();
    for (const item of items) {
      const key = String(item.windowId);
      if (!groups.has(key)) groups.set(key, { windowId: item.windowId, tabIds: [] });
      groups.get(key).tabIds.push(item.tabId);
    }

    let moved = 0;
    const createdWindows = [];

    for (const { windowId, tabIds } of [...groups.values()].sort((a, b) =>
      typeof a.windowId === "number" ? -1 : typeof b.windowId === "number" ? 1 : 0
    )) {
      try {
        if (isRealWindowId(windowId)) {
          await chrome.tabs.move(tabIds, { windowId, index: -1 });
          moved += tabIds.length;
        } else {
          const first = tabIds[0];
          const rest = tabIds.slice(1);
          const win = await chrome.windows.create({ tabId: first, focused: false });
          createdWindows.push({ key: windowId, windowId: win.id });
          moved += 1;
          if (rest.length > 0) {
            await chrome.tabs.move(rest, { windowId: win.id, index: -1 });
            moved += rest.length;
          }
        }
      } catch (err) {
        errors.push(`group ${windowId}: ${err.message}`);
      }
    }

    return { moved, createdWindows, errors };
  }

  const api = { snapshot, groupByWindows, toRemapList, validateRemap, applyRemap };

  // Available as TabMap in the canvas page, and importable in tests.
  global.TabMap = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
