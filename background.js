// Opens a persistent popup window (not the default popup which closes on blur)
// Uses chrome.storage.session to track the window across service worker restarts

chrome.action.onClicked.addListener(async () => {
  const { popupWinId } = await chrome.storage.session.get('popupWinId').catch(() => ({}));
  if (popupWinId) {
    try {
      await chrome.windows.update(popupWinId, { focused: true });
      return;
    } catch {
      // window was closed, fall through to create a new one
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 460,
    height: 660,
    focused: true
  });
  await chrome.storage.session.set({ popupWinId: win.id });
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { popupWinId } = await chrome.storage.session.get('popupWinId').catch(() => ({}));
  if (id === popupWinId) await chrome.storage.session.remove('popupWinId');
});
