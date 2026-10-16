#!/usr/bin/env node
// Web UI + JSON API for browsing and downloading luscious.net albums.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseAlbumId, getAlbum, getAllPictures, searchAlbums, fetchImage,
  isLusciousHost, safeName, fileNameFor, orderedPool, UA,
} from './lib/luscious.js';
import { ZipWriter } from './lib/zip.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// Small cache so the album page and the zip download don't refetch picture lists.
const cache = new Map();
async function albumWithPictures(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const [album, pictures] = await Promise.all([getAlbum(id), getAllPictures(id)]);
  const value = { album, pictures };
  cache.set(id, { at: Date.now(), value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return value;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (url.pathname === '/api/search') {
    const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
    return sendJson(res, 200, await searchAlbums(q.get('q'), page, q.get('sort')));
  }

  if (url.pathname === '/api/album') {
    const id = parseAlbumId(q.get('id') || q.get('url'));
    if (!id) return sendJson(res, 400, { error: 'That does not look like a luscious.net album link.' });
    return sendJson(res, 200, await albumWithPictures(id));
  }

  if (url.pathname === '/img') {
    const target = q.get('u');
    if (!isLusciousHost(target)) return sendJson(res, 400, { error: 'Only luscious.net images can be proxied.' });
    const upstream = await fetch(target, { headers: { 'User-Agent': UA, Referer: 'https://www.luscious.net/' } })
      .catch(() => null);
    if (!upstream?.ok || !upstream.body) {
      res.writeHead(upstream?.status || 502);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    });
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
    return res.end();
  }

  if (url.pathname === '/download') {
    const id = parseAlbumId(q.get('id') || q.get('url'));
    if (!id) return sendJson(res, 400, { error: 'Invalid album.' });
    const { album, pictures } = await albumWithPictures(id);
    const folder = `${safeName(album.title)} (${album.id})`;
    const zipName = `${folder}.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      'Cache-Control': 'no-store',
    });
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const zip = new ZipWriter(res);
    const failed = [];
    console.log(`[download] ${album.title} (${pictures.length} files)`);
    for await (const r of orderedPool(pictures, 4, (p) => fetchImage(p.original, { signal: abort.signal }))) {
      if (abort.signal.aborted) return;
      if (r.ok) await zip.addFile(`${folder}/${fileNameFor(r.item, r.index, pictures.length)}`, r.v.data);
      else failed.push(`${r.index + 1}\t${r.item.original}\t${r.e?.message}`);
    }
    if (failed.length) await zip.addFile(`${folder}/_failed.txt`, Buffer.from(failed.join('\n') + '\n'));
    await zip.finish();
    console.log(`[download] done: ${album.title}${failed.length ? ` (${failed.length} failed)` : ''}`);
    return res.end();
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 502, { error: err.message || 'Something went wrong' });
    else res.destroy(err);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Luscious downloader running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
