export const DOM_PRESETS = {
  // Smallest output for pasting into an LLM.
  llm: {
    linkMeta: true,
    comments: true,
    styleAttrs: true,
    dataAttrs: true,
    base64: true,
    whitespace: true,
  },
  // Keep what helps when writing selectors for extensions/scrapers.
  selectors: {
    linkMeta: true,
    comments: true,
    styleAttrs: true,
    dataAttrs: false,
    base64: true,
    whitespace: false,
  },
};

export const DEFAULTS = {
  type: 'docs',          // 'docs' | 'dom'
  output: 'download',    // 'download' | 'clipboard'
  combine: false,        // multiple tabs -> one file
  docsFormat: 'md',      // 'md' | 'txt'
  includeHeader: true,   // title / source URL / date at the top
  domPreset: 'llm',      // 'llm' | 'selectors' | 'custom'
  domClean: {            // used when domPreset === 'custom'
    linkMeta: true,
    comments: true,
    styleAttrs: true,
    dataAttrs: false,
    base64: true,
    whitespace: true,
  },
};

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULTS,
    ...settings,
    domClean: { ...DEFAULTS.domClean, ...settings.domClean },
  };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export function resolveDomClean(settings) {
  return DOM_PRESETS[settings.domPreset] ?? settings.domClean;
}
