#!/usr/bin/env node
// Web UI + JSON API for browsing and downloading luscious.net albums.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseAlbumId, getAlbum, getAllPictures, searchAlbums, fetchImage,
  isLusciousHost, safeName, fileNameFor, orderedPool, Session,
} from './lib/luscious.js';
import { login, loginWithCookie, currentUser, favorites, diagnose } from './lib/account.js';
import { ZipWriter } from './lib/zip.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// ---------- app sessions ----------
// Each browser gets a random "ldl_sid" cookie that maps to its luscious.net cookies.
// Only luscious cookies are stored (never passwords), in data/sessions.json.
let sessions = {};
try {
  sessions = JSON.parse(await readFile(SESSIONS_FILE, 'utf8'));
} catch {}
let saveTimer = null;
function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('Could not save sessions:', err.message);
    }
  }, 200);
}

function sidOf(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)ldl_sid=([a-f0-9]{48})/);
  return m ? m[1] : null;
}
function getAccount(req) {
  const sid = sidOf(req);
  const rec = sid && sessions[sid];
  if (!rec) return { session: new Session(), user: null };
  const session = new Session(rec.cookies);
  return { sid, session, user: rec.user };
}
function storeAccount(req, res, session, user) {
  const sid = sidOf(req) && sessions[sidOf(req)] ? sidOf(req) : randomBytes(24).toString('hex');
  sessions[sid] = { cookies: session.cookies, user, at: Date.now() };
  saveSessions();
  res.setHeader('Set-Cookie', `ldl_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
}
// Keep any cookie refreshes luscious.net sends back.
function persistCookies(acct) {
  if (acct.sid && sessions[acct.sid] && JSON.stringify(sessions[acct.sid].cookies) !== JSON.stringify(acct.session.cookies)) {
    sessions[acct.sid].cookies = acct.session.cookies;
    saveSessions();
  }
}

async function readJson(req) {
  if (!/application\/json/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw Object.assign(new Error('Too large'), { status: 413 });
  }
  return JSON.parse(body || '{}');
}

// Small cache so the album page and the zip download don't refetch picture lists.
const cache = new Map();
async function albumWithPictures(id, acct) {
  const key = `${acct.user?.id || ''}:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const [album, pictures] = await Promise.all([getAlbum(id, acct.session), getAllPictures(id, null, acct.session)]);
  const value = { album, pictures };
  cache.set(key, { at: Date.now(), value });
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
  const acct = getAccount(req);
  res.on('finish', () => persistCookies(acct));

  if (url.pathname === '/api/me') return sendJson(res, 200, { user: acct.session.loggedIn ? acct.user : null });

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const { username, password } = await readJson(req);
    if (!username || !password) return sendJson(res, 400, { error: 'Enter your username and password.' });
    try {
      const { session, user } = await login(String(username), String(password));
      storeAccount(req, res, session, user);
      return sendJson(res, 200, { user });
    } catch (err) {
      console.log('[login] failed:', err.message, err.log || '');
      return sendJson(res, 401, { error: err.message, log: err.log });
    }
  }

  if (url.pathname === '/api/login-cookie' && req.method === 'POST') {
    const { cookie } = await readJson(req);
    try {
      const { session, user } = await loginWithCookie(cookie);
      storeAccount(req, res, session, user);
      return sendJson(res, 200, { user });
    } catch (err) {
      return sendJson(res, 401, { error: err.message });
    }
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    if (acct.sid) {
      delete sessions[acct.sid];
      saveSessions();
    }
    res.setHeader('Set-Cookie', 'ldl_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/favorites') {
    if (!acct.session.loggedIn) return sendJson(res, 401, { error: 'Sign in to see your favorites.' });
    let user = acct.user;
    if (!user?.id) {
      user = (await currentUser(acct.session).catch(() => null)) || user;
      if (user?.id && acct.sid) sessions[acct.sid].user = user;
    }
    const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
    try {
      return sendJson(res, 200, await favorites(acct.session, user, page));
    } catch (err) {
      return sendJson(res, 502, { error: err.message, log: err.log });
    }
  }

  if (url.pathname === '/api/diagnose') return sendJson(res, 200, await diagnose(acct.session, acct.user));

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (url.pathname === '/api/search') {
    const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
    return sendJson(res, 200, await searchAlbums(q.get('q'), page, q.get('sort'), acct.session));
  }

  if (url.pathname === '/api/album') {
    const id = parseAlbumId(q.get('id') || q.get('url'));
    if (!id) return sendJson(res, 400, { error: 'That does not look like a luscious.net album link.' });
    return sendJson(res, 200, await albumWithPictures(id, acct));
  }

  if (url.pathname === '/img') {
    const target = q.get('u');
    if (!isLusciousHost(target)) return sendJson(res, 400, { error: 'Only luscious.net images can be proxied.' });
    const upstream = await fetch(target, { headers: acct.session.headers() })
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
    const { album, pictures } = await albumWithPictures(id, acct);
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
    for await (const r of orderedPool(pictures, 4, (p) => fetchImage(p.original, { signal: abort.signal, session: acct.session }))) {
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
    if (!res.headersSent) sendJson(res, err.status || 502, { error: err.message || 'Something went wrong' });
    else res.destroy(err);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Luscious downloader running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
