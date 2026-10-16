#!/usr/bin/env node
// Command-line downloader: node cli.js <album url or id> [more...] [--out DIR] [--jobs N]
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import {
  parseAlbumId, getAlbum, getAllPictures, fetchImage, safeName, fileNameFor, orderedPool,
} from './lib/luscious.js';

const args = process.argv.slice(2);
let out = 'downloads';
let jobs = 4;
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' || args[i] === '-o') out = args[++i];
  else if (args[i] === '--jobs' || args[i] === '-j') jobs = Math.max(1, parseInt(args[++i], 10) || 4);
  else if (args[i] === '--help' || args[i] === '-h') usage(0);
  else targets.push(args[i]);
}
if (!targets.length) usage(1);

function usage(code) {
  console.log('Usage: node cli.js <album url or id> [more urls...] [--out DIR] [--jobs N]');
  console.log('Example: node cli.js https://www.luscious.net/albums/some-title_123456/');
  process.exit(code);
}

const exists = (p) => access(p).then(() => true, () => false);

let hadError = false;
for (const t of targets) {
  const id = parseAlbumId(t);
  if (!id) {
    console.error(`Skipping "${t}": not an album link`);
    hadError = true;
    continue;
  }
  try {
    const album = await getAlbum(id);
    console.log(`\n${album.title}  [${album.pictures} pictures]`);
    const pictures = await getAllPictures(id, (n, total) =>
      process.stdout.write(`\r  listing pictures ${n}/${total ?? '?'}`));
    process.stdout.write('\n');
    const dir = path.join(out, `${safeName(album.title)} (${album.id})`);
    await mkdir(dir, { recursive: true });

    const todo = [];
    for (const [i, p] of pictures.entries()) {
      const file = path.join(dir, fileNameFor(p, i, pictures.length));
      if (!(await exists(file))) todo.push({ p, file });
    }
    if (todo.length < pictures.length) console.log(`  ${pictures.length - todo.length} already downloaded, skipping`);

    let done = 0, failed = 0;
    for await (const r of orderedPool(todo, jobs, ({ p }) => fetchImage(p.original))) {
      if (r.ok) await writeFile(r.item.file, r.v.data);
      else { failed++; console.error(`\n  failed: ${r.item.p.original} (${r.e?.message})`); }
      done++;
      process.stdout.write(`\r  downloading ${done}/${todo.length}`);
    }
    process.stdout.write('\n');
    console.log(`  saved to ${dir}${failed ? ` (${failed} failed - run again to retry)` : ''}`);
    if (failed) hadError = true;
  } catch (err) {
    console.error(`  error: ${err.message}`);
    hadError = true;
  }
}
process.exit(hadError ? 1 : 0);
