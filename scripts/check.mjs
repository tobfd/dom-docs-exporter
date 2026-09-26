// Static checks for the extension: manifest, referenced files, locales, JS syntax.
// Usage: node scripts/check.mjs  (exits with code 1 on errors)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../extension/', import.meta.url));
const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);

const files = walk(ROOT);
const rel = (file) => relative(ROOT, file).replaceAll('\\', '/');
const read = (file) => readFileSync(file, 'utf8');
const readJson = (path) => {
  try {
    return JSON.parse(read(join(ROOT, path)));
  } catch (e) {
    fail(`${path}: invalid JSON (${e.message})`);
    return {};
  }
};

// ---------------------------------------------------------------- Manifest
const manifest = readJson('manifest.json');
if (manifest.manifest_version !== 3) fail('manifest.json: manifest_version must be 3');

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (pkg.version !== manifest.version) {
  fail(`version mismatch: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
}

const referenced = [
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
];
// Paths referenced from code (offscreen document, <script>/<link> tags).
for (const file of files.filter((f) => /\.(js|html)$/.test(f))) {
  const src = read(file);
  for (const [, path] of src.matchAll(/url: '([\w/.-]+\.html)'/g)) referenced.push(path);
  for (const [, path] of src.matchAll(/(?:src|href)="([\w/.-]+\.(?:js|css))"/g)) {
    referenced.push(rel(join(file, '..', path)));
  }
}
for (const path of referenced.filter(Boolean)) {
  if (!existsSync(join(ROOT, path))) fail(`missing file referenced by extension: ${path}`);
}

for (const size of Object.keys(manifest.icons ?? {})) {
  const png = readFileSync(join(ROOT, manifest.icons[size]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== Number(size) || height !== Number(size)) {
    fail(`${manifest.icons[size]}: is ${width}x${height}, expected ${size}x${size}`);
  }
}

// ----------------------------------------------------------------- Locales
const defaultLocale = manifest.default_locale;
const localeDirs = readdirSync(join(ROOT, '_locales'));
const locales = Object.fromEntries(localeDirs.map((l) => [l, readJson(`_locales/${l}/messages.json`)]));
if (!locales[defaultLocale]) fail(`default_locale "${defaultLocale}" has no _locales folder`);

const baseKeys = Object.keys(locales[defaultLocale] ?? {});
for (const [locale, messages] of Object.entries(locales)) {
  const keys = Object.keys(messages);
  for (const k of baseKeys.filter((k) => !keys.includes(k))) fail(`_locales/${locale}: missing "${k}"`);
  for (const k of keys.filter((k) => !baseKeys.includes(k))) fail(`_locales/${locale}: extra "${k}"`);
  for (const [k, { message = '', placeholders = {} }] of Object.entries(messages)) {
    const used = [...message.matchAll(/\$(\w+)\$/g)].map((m) => m[1].toLowerCase());
    for (const p of used) if (!placeholders[p]) fail(`_locales/${locale}: "${k}" uses undefined $${p.toUpperCase()}$`);
  }
}

const code = files.filter((f) => /\.(js|html|json)$/.test(f) && !f.includes('_locales')).map(read).join('\n');
const usedKeys = new Set([
  ...[...code.matchAll(/'(\w+)'/g)].map((m) => m[1]),
  ...[...code.matchAll(/data-i18n(?:-\w+)?="(\w+)"/g)].map((m) => m[1]),
  ...[...code.matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]),
]);
for (const k of baseKeys.filter((k) => !usedKeys.has(k))) warnings.push(`locale key "${k}" looks unused`);
for (const m of code.matchAll(/(?:\bt\('|data-i18n(?:-\w+)?=")(\w+)/g)) {
  if (!baseKeys.includes(m[1])) fail(`locale key "${m[1]}" is used but not defined`);
}

// Code and docs stay English; German only lives in _locales/de.
for (const file of files.filter((f) => /\.(js|html|css)$/.test(f))) {
  read(file).split('\n').forEach((line, i) => {
    if (/[äöüÄÖÜß]/.test(line)) fail(`${rel(file)}:${i + 1}: non-English text outside _locales`);
  });
}

// -------------------------------------------------------------- JS syntax
for (const file of files.filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: read(file), stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    fail(`${rel(file)}: syntax error\n${e.stderr}`);
  }
}

// ------------------------------------------------------------------ Report
for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);
console.log(errors.length ? `\n${errors.length} error(s)` : `ok – ${files.length} files checked`);
process.exit(errors.length ? 1 : 0);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
