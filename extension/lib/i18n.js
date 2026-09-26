// Thin wrapper around chrome.i18n (works in the service worker and extension pages).

export function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions.map(String)) || key;
}

export function fmt(number) {
  return number.toLocaleString(chrome.i18n.getUILanguage());
}

/** Fills [data-i18n] (text), [data-i18n-title] and [data-i18n-aria] from messages.json. */
export function localizePage(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}
