// Turns exported text into a blob URL the service worker can hand to chrome.downloads.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.cmd !== 'blob-url') return;
  try {
    const blob = new Blob([msg.content], { type: `${msg.mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    sendResponse({ url });
  } catch (e) {
    sendResponse({ error: e.message });
  }
});
