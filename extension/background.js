import { runExport } from './lib/exporter.js';
import { getSettings } from './lib/settings.js';
import { fmt, t } from './lib/i18n.js';

const MENU_ITEMS = [
  { id: 'docs:clipboard', message: 'menuDocsClipboard' },
  { id: 'docs:download', message: 'menuDocsDownload' },
  { id: 'dom:clipboard', message: 'menuDomClipboard' },
  { id: 'dom:download', message: 'menuDomDownload' },
];
const CONTEXTS = ['page', 'selection', 'link', 'image'];

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'root', title: t('extName'), contexts: CONTEXTS });
  for (const { id, message } of MENU_ITEMS) {
    chrome.contextMenus.create({ id, title: t(message), parentId: 'root', contexts: CONTEXTS });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const [type, output] = String(info.menuItemId).split(':');
  if (!tab?.id || !output) return;

  const label = t(type === 'docs' ? 'typeDocs' : 'typeDom');
  try {
    const settings = { ...(await getSettings()), type };
    const { results, text } = await runExport([tab.id], settings, output);
    const [result] = results;
    if (!result.ok) throw new Error(result.error);

    if (output === 'clipboard') {
      await copyInTab(tab.id, text);
      await toast(tab.id, t('toastCopied', label, fmt(text.length)));
    } else {
      await toast(tab.id, t('toastSaved', label));
    }
  } catch (e) {
    await toast(tab.id, t('toastFailed', label, e.message), true).catch(() => {});
  }
});

// Popup delegates the work here so it keeps running even if the popup closes.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cmd !== 'export') return;
  (async () => {
    try {
      sendResponse(await runExport(msg.tabIds, msg.settings));
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true;
});

// The service worker has no clipboard, so copy from inside the page.
async function copyInTab(tabId, text) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [text],
    func: async (value) => {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        const area = document.createElement('textarea');
        area.value = value;
        area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      }
    },
  });
  if (!injection?.result) throw new Error(t('errClipboard'));
}

async function toast(tabId, message, isError = false) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [message, isError],
    func: (text, error) => {
      document.getElementById('__dom-docs-exporter-toast')?.remove();
      const host = document.createElement('div');
      host.id = '__dom-docs-exporter-toast';
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        div {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          max-width: 360px; padding: 10px 14px; border-radius: 8px;
          font: 13px/1.4 system-ui, sans-serif; color: #fff;
          background: ${error ? '#b3261e' : '#1f6f43'};
          box-shadow: 0 4px 16px rgb(0 0 0 / 0.25);
          transition: opacity .3s;
        }`;
      const box = document.createElement('div');
      box.setAttribute('role', 'status');
      box.textContent = text;
      root.append(style, box);
      document.documentElement.append(host);
      setTimeout(() => {
        box.style.opacity = '0';
        setTimeout(() => host.remove(), 400);
      }, error ? 4000 : 2200);
    },
  });
}
