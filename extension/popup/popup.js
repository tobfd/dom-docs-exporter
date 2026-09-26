import { getSettings, saveSettings } from '../lib/settings.js';
import { isScriptable } from '../lib/exporter.js';
import { fmt, localizePage, t } from '../lib/i18n.js';

const $ = (selector) => document.querySelector(selector);
const tabTitles = new Map();
let settings;
let exporting = false;

init().catch((e) => addStatus(false, t('statusError'), e.message));

async function init() {
  localizePage();
  settings = await getSettings();

  bindRadios('type');
  bindRadios('output');
  bindRadios('docsFormat');
  bindRadios('combine', (value) => value === 'true');
  bindRadios('domPreset');

  for (const box of document.querySelectorAll('[data-clean]')) {
    box.checked = settings.domClean[box.dataset.clean];
    box.addEventListener('change', () => {
      update({ domClean: { ...settings.domClean, [box.dataset.clean]: box.checked } });
    });
  }

  const header = $('#includeHeader');
  header.checked = settings.includeHeader;
  header.addEventListener('change', () => update({ includeHeader: header.checked }));

  $('#select-all').addEventListener('click', () => selectAll(true));
  $('#select-none').addEventListener('click', () => selectAll(false));
  $('#export').addEventListener('click', doExport);

  await loadTabs();
  refresh();
}

function bindRadios(name, parse = (value) => value) {
  for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
    input.checked = String(settings[name]) === input.value;
    input.addEventListener('change', () => update({ [name]: parse(input.value) }));
  }
}

async function update(patch) {
  settings = { ...settings, ...patch };
  refresh();
  await saveSettings(settings);
}

function refresh() {
  const count = selectedTabIds().length;
  $('#docs-opts').hidden = settings.type !== 'docs';
  $('#dom-opts').hidden = settings.type !== 'dom';
  $('#combine-row').hidden = !(settings.output === 'download' && count > 1);
  $('#custom-clean').hidden = settings.domPreset !== 'custom';
  $('#preset-hint').textContent = t({
    llm: 'presetLlmHint',
    selectors: 'presetSelectorsHint',
    custom: 'presetCustomHint',
  }[settings.domPreset] ?? 'presetCustomHint');

  const button = $('#export');
  if (exporting) return;
  const what = t(settings.type === 'docs' ? 'typeDocs' : 'typeDom');
  const tabs = count === 1 ? t('tabCountOne') : t('tabCountMany', count);
  button.textContent = t(settings.output === 'clipboard' ? 'buttonCopy' : 'buttonExport', what, tabs);
  button.disabled = count === 0;
}

// ------------------------------------------------------------------ Tabs

async function loadTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const list = $('#tab-list');

  for (const tab of tabs) {
    const allowed = isScriptable(tab.url);
    tabTitles.set(tab.id, tab.title || tab.url);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(tab.id);
    box.disabled = !allowed;
    box.checked = allowed && tab.highlighted;
    box.addEventListener('change', refresh);

    const icon = document.createElement('img');
    icon.className = 'favicon';
    icon.alt = '';
    icon.addEventListener('error', () => { icon.style.visibility = 'hidden'; });
    // Chrome's favicon cache: no request to the site itself.
    if (tab.url) icon.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=16`);
    else icon.style.visibility = 'hidden';

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;

    const host = document.createElement('span');
    host.className = 'tab-host';
    host.textContent = !allowed
      ? t('tabNotExportable')
      : hostOf(tab.url) + (tab.discarded ? ` · ${t('tabSleeping')}` : '');

    const text = document.createElement('span');
    text.className = 'tab-text';
    text.append(title, host);

    const label = document.createElement('label');
    label.className = allowed ? 'tab' : 'tab disabled';
    label.title = tab.url || '';
    label.append(box, icon, text);

    const item = document.createElement('li');
    item.append(label);
    list.append(item);
  }

  list.querySelector('input:checked')?.closest('li').scrollIntoView({ block: 'nearest' });
}

function hostOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function selectedTabIds() {
  return [...document.querySelectorAll('#tab-list input:checked')].map((box) => Number(box.value));
}

function selectAll(checked) {
  for (const box of document.querySelectorAll('#tab-list input:not(:disabled)')) box.checked = checked;
  refresh();
}

// ---------------------------------------------------------------- Export

async function doExport() {
  const tabIds = selectedTabIds();
  const button = $('#export');
  const status = $('#status');
  exporting = true;
  button.disabled = true;
  button.textContent = t('buttonExporting');
  status.replaceChildren();

  try {
    const response = await chrome.runtime.sendMessage({ cmd: 'export', tabIds, settings });
    if (response?.error) throw new Error(response.error);

    if (settings.output === 'clipboard' && response.text) {
      await navigator.clipboard.writeText(response.text);
      const chars = response.text.length;
      addStatus(true, t('statusCopied'), t('statusChars', fmt(chars), fmt(Math.ceil(chars / 4))));
    }
    if (response.combinedFile) addStatus(true, t('statusSaved'), response.combinedFile);

    for (const result of response.results) {
      const title = result.title || tabTitles.get(result.tabId) || `Tab ${result.tabId}`;
      if (!result.ok) addStatus(false, title, result.error);
      else if (result.filename) addStatus(true, title, result.filename);
      else if (response.results.length > 1) addStatus(true, title);
    }
  } catch (e) {
    addStatus(false, t('statusError'), e.message);
  } finally {
    exporting = false;
    refresh();
  }
}

function addStatus(ok, text, detail) {
  const item = document.createElement('li');
  item.className = ok ? 'ok' : 'err';
  item.append(text);
  if (detail) {
    const small = document.createElement('div');
    small.className = 'detail';
    small.textContent = detail;
    item.append(small);
  }
  $('#status').append(item);
}
