import { extractPage } from './extract.js';
import { t } from './i18n.js';
import { resolveDomClean } from './settings.js';

const FOLDER = 'dom-docs-exporter';

export function isScriptable(url = '') {
  if (!/^(https?|file):/i.test(url)) return false;
  return !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
}

/**
 * Extracts every tab, then downloads (single/combined) or returns text for the clipboard.
 * Service worker only (needs chrome.offscreen for downloads).
 */
export async function runExport(tabIds, settings, output = settings.output) {
  const opts = { type: settings.type, docsFormat: settings.docsFormat, domClean: resolveDomClean(settings) };
  const settled = await Promise.allSettled(tabIds.map((id) => extractFromTab(id, opts)));
  const results = settled.map((s, i) => (s.status === 'fulfilled'
    ? { tabId: tabIds[i], ok: true, ...s.value }
    : { tabId: tabIds[i], ok: false, error: friendlyError(s.reason) }));

  const pages = results.filter((r) => r.ok);
  const now = new Date();
  const response = {};

  if (pages.length && output === 'clipboard') {
    response.text = pages.length > 1
      ? combine(pages, now)
      : withHeader(pages[0], settings.includeHeader, now);
  } else if (pages.length > 1 && settings.combine) {
    const filename = `${FOLDER}/${pages.length}-tabs_${settings.type}_${stamp(now)}.${pages[0].ext}`;
    try {
      response.combinedFile = await download(combine(pages, now), pages[0].mime, filename);
    } catch (e) {
      pages.forEach((p) => Object.assign(p, { ok: false, error: friendlyError(e) }));
    }
  } else {
    for (const page of pages) {
      const filename = `${FOLDER}/${fileBase(page)}_${stamp(now)}.${page.ext}`;
      try {
        page.filename = await download(withHeader(page, settings.includeHeader, now), page.mime, filename);
      } catch (e) {
        Object.assign(page, { ok: false, error: friendlyError(e) });
      }
    }
  }

  // Don't ship full page contents back over messaging.
  response.results = results.map(({ content, ...r }) => ({ ...r, chars: content?.length ?? 0 }));
  return response;
}

async function extractFromTab(tabId, opts) {
  const tab = await chrome.tabs.get(tabId);
  if (!isScriptable(tab.url)) throw new Error(t('errRestricted'));
  if (tab.discarded || tab.status === 'unloaded') await reloadAndWait(tabId);

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPage,
    args: [opts],
  });
  if (!injection?.result) throw new Error(injection?.error?.message || t('errNoData'));
  return injection.result;
}

async function reloadAndWait(tabId, timeoutMs = 20000) {
  let listener;
  let timer;
  const loaded = new Promise((resolve, reject) => {
    listener = (id, info) => {
      if (id === tabId && info.status === 'complete') resolve();
    };
    timer = setTimeout(() => reject(new Error(t('errReloadTimeout'))), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
  try {
    await chrome.tabs.reload(tabId);
    await loaded;
  } finally {
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(listener);
  }
}

// ------------------------------------------------------------ Formatting

function withHeader(page, include, now) {
  if (!include) return page.content;
  const date = human(now);
  switch (page.ext) {
    case 'md':
      return `---\ntitle: ${JSON.stringify(page.title)}\nsource: ${page.url}\nexported: ${date}\n---\n\n${page.content}`;
    case 'html':
      return `<!--\n  Title: ${commentSafe(page.title)}\n  Source: ${commentSafe(page.url)}\n  Exported: ${date}\n-->\n${page.content}`;
    default:
      return `${page.title}\n${page.url}\nExported: ${date}\n\n${page.content}`;
  }
}

function combine(pages, now) {
  switch (pages[0].ext) {
    case 'md':
      return pages
        .map((p) => `# ${p.title}\n\nSource: <${p.url}>\n\n${p.content}`)
        .join('\n\n---\n\n');
    case 'html':
      return `<!-- Exported: ${human(now)} -->\n` + pages
        .map((p) => `<!-- ===== ${commentSafe(p.title)} | ${commentSafe(p.url)} ===== -->\n${p.content}`)
        .join('\n\n');
    default:
      return pages
        .map((p) => `===== ${p.title} =====\n${p.url}\n\n${p.content}`)
        .join('\n\n\n');
  }
}

function commentSafe(text) {
  return text.replace(/--/g, '- -');
}

function fileBase({ url, title }) {
  let host = 'local';
  try {
    host = new URL(url).hostname.replace(/^www\./, '') || 'local';
  } catch { /* keep fallback */ }
  const base = slug(host, 40);
  const name = slug(title, 60);
  return name === base ? base : `${base}_${name}`; // untitled pages fall back to the hostname

}

function slug(text, max) {
  return text
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}.]+/gu, '-')
    .replace(/^[-.]+/, '')
    .slice(0, max)
    .replace(/[-.]+$/, '') || 'page';
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d) => `${ymd(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
const human = (d) => `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/file:\/\//i.test(msg)) return t('errFileUrl');
  if (/Cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(msg)) return t('errRestricted');
  if (/error page/i.test(msg)) return t('errErrorPage');
  if (/No tab with id/i.test(msg)) return t('errTabClosed');
  return msg;
}

// -------------------------------------------------------------- Download

// The service worker can't create blob URLs and data: URLs cap out around 2 MB,
// so an offscreen document turns the content into a blob URL for chrome.downloads.
// Resolves to the name Chrome actually used (e.g. "… (1).md" after uniquifying).
async function download(content, mime, filename) {
  await ensureOffscreen();
  const { url, error } = await chrome.runtime.sendMessage({
    target: 'offscreen', cmd: 'blob-url', content, mime,
  });
  if (!url) throw new Error(error || t('errDownloadPrep'));
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  const finalPath = await resolvedPath(id);
  return finalPath ? `${FOLDER}/${finalPath.split(/[\\/]/).pop()}` : filename;
}

// Chrome determines the final path shortly after the download starts.
async function resolvedPath(id, timeoutMs = 3000) {
  let listener;
  let timer;
  const changed = new Promise((resolve) => {
    listener = (delta) => {
      if (delta.id === id && delta.filename?.current) resolve(delta.filename.current);
    };
    timer = setTimeout(() => resolve(''), timeoutMs);
    chrome.downloads.onChanged.addListener(listener);
  });
  try {
    const [item] = await chrome.downloads.search({ id });
    return item?.filename || await changed;
  } finally {
    clearTimeout(timer);
    chrome.downloads.onChanged.removeListener(listener);
  }
}

// In-flight check-and-create, shared so concurrent exports (popup + context menu)
// all wait until the document has loaded instead of messaging it too early.
let offscreenReady = null;

async function ensureOffscreen() {
  offscreenReady ??= (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create blob URLs so exported pages can be downloaded as files.',
    });
  })();
  try {
    await offscreenReady;
  } finally {
    offscreenReady = null;
  }
}
