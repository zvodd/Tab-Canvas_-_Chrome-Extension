// background.js — opens the canvas page when the toolbar action is clicked.

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("canvas.html");
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0 && existing[0].windowId != null && existing[0].id != null) {
    await chrome.windows.update(existing[0].windowId, { focused: true });
    await chrome.tabs.update(existing[0].id, { active: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
