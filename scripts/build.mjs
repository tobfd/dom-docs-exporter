// Packs extension/ into dist/dom-docs-exporter-v<version>.zip (Chrome Web Store / release upload).
// Minimal ZIP writer (deflate) so no dependencies are needed.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../extension/', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const files = walk(ROOT).sort();
const local = [];
const central = [];
let offset = 0;

for (const file of files) {
  const name = Buffer.from(relative(ROOT, file).replaceAll('\\', '/'));
  const data = readFileSync(file);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header
  header.writeUInt16LE(20, 4);         // version needed
  header.writeUInt16LE(0x0800, 6);     // UTF-8 names
  header.writeUInt16LE(8, 8);          // deflate
  header.writeUInt16LE(DOS_DATE, 12);  // fixed timestamp -> reproducible builds
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  local.push(header, name, packed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); // central directory header
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);

  offset += header.length + name.length + packed.length;
}

const centralSize = central.reduce((sum, b) => sum + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(DIST, { recursive: true });
const out = join(DIST, `dom-docs-exporter-v${version}.zip`);
writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`${relative(process.cwd(), out)} (${files.length} files)`);

function walk(dir) {
  // Skip hidden files (.DS_Store, editor backups, …) so they never end up in the package.
  return readdirSync(dir).filter((name) => !name.startsWith('.')).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
