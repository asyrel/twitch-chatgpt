// Runs the real app (www/) in Chromium with fake luscious.net and art-site servers
// and a stand-in for the Android native layer (HTTP, storage, cookies).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startLuscious } from './mock-luscious.mjs';
import { startBooru } from './mock-booru.mjs';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const PORTS = { app: 4676, luscious: 4675, booru: 4680 };

export async function startAll() {
  const app = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/build.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"build": 20}'); }
    if (p.startsWith('/__file/')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1150"><text y="500">LOCAL</text></svg>'); }
    try {
      const file = p === '/' ? 'index.html' : p;
      const body = await readFile(path.join(WWW, file));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => app.listen(PORTS.app, '127.0.0.1', r));
  const lus = await startLuscious(PORTS.luscious);
  const booru = await startBooru(PORTS.booru);
  const browser = await chromium.launch();
  return {
    browser, booruHits: booru.hits, url: `http://127.0.0.1:${PORTS.app}/`,
    async close() { await browser.close(); app.close(); lus.close(); booru.server.close(); },
  };
}

const BOORU_HOSTS = { 'danbooru.donmai.us': 'danbooru', 'gelbooru.com': 'gelbooru', 'yande.re': 'yandere', 'konachan.com': 'konachan' };

// A phone-sized page with the fake native layer. opts.onboarded=false shows the first-run setup.
export async function newPage(env, { onboarded = true, storage = {} } = {}) {
  const context = await env.browser.newContext({ viewport: { width: 411, height: 891 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Poses' : undefined));
  const jar = {};
  await page.exposeFunction('__nodeHttp', async (url, method, headers, body, blob) => {
    const u = new URL(url);
    let target = url;
    if (/(^|\.)luscious\.net$/.test(u.hostname)) target = `http://127.0.0.1:${PORTS.luscious}${u.pathname}${u.search}`;
    else if (u.hostname === 'api.github.com') target = `http://127.0.0.1:${PORTS.booru}/gh${u.pathname}`;
    else if (u.hostname === 'api.redgifs.com') target = `http://127.0.0.1:${PORTS.booru}${u.pathname}${u.search}`;
    else if (BOORU_HOSTS[u.hostname]) target = `http://127.0.0.1:${PORTS.booru}/api?site=${BOORU_HOSTS[u.hostname]}&${u.search.slice(1)}`;
    const h = { ...headers };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.Cookie = cookie;
    const r = await fetch(target, { method, headers: h, body: method === 'POST' ? body : undefined, redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const data = blob ? Buffer.from(await r.arrayBuffer()).toString('base64') : await r.text();
    return { status: r.status, data, type: r.headers.get('content-type') || '' };
  });
  await page.exposeFunction('__cookieNames', async () => Object.keys(jar));
  await page.exposeFunction('__clearCookies', async () => { for (const k of Object.keys(jar)) delete jar[k]; });
  await page.addInitScript(({ onboarded, storage }) => {
    if (!sessionStorage.getItem('__init')) {
      sessionStorage.setItem('__init', '1');
      localStorage.clear();
      if (onboarded) localStorage.setItem('ldl_onboarded', 'true');
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, JSON.stringify(v));
    }
    const listeners = {};
    const disk = (window.__disk = {});
    window.__calls = [];
    window.__emit = (ev, d) => (listeners[ev] || []).forEach((f) => f(d));
    window.Capacitor = {
      isNativePlatform: () => true,
      convertFileSrc: (u) => u.replace('file://', location.origin + '/__file'),
      Plugins: {
        CapacitorHttp: {
          async request({ url, method = 'GET', data, headers = {}, responseType }) {
            const r = await window.__nodeHttp(url, method, headers, typeof data === 'string' ? data : JSON.stringify(data), responseType === 'blob');
            return { status: r.status, headers: { 'Content-Type': r.type }, data: r.data };
          },
        },
        LdlStorage: {
          addListener: async (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); return { remove() { listeners[ev] = listeners[ev].filter((x) => x !== f); } }; },
          getInsets: async () => ({ top: 24, bottom: 16 }),
          getVolumes: async () => ({ volumes: [{ index: 0, label: 'Phone storage', removable: false, free: 50e9 }, { index: 1, label: 'SD card', removable: true, free: 98e9 }] }),
          pickFolder: async () => ({ uri: 'content://tree/sd', name: 'SD card › Luscious' }),
          setReading: async (o) => { window.__calls.push('setReading:' + o.on); },
          setBackgroundMode: async (o) => { window.__calls.push('bg:' + o.active); },
          cancel: async () => {},
          openVerify: async () => {},
          installUpdate: async (a) => { window.__calls.push(['installUpdate', a]); },
          getCookieNames: async () => ({ names: await window.__cookieNames() }),
          clearCookies: async () => { await window.__clearCookies(); },
          async downloadAlbum({ target, folder, files, jobId }) {
            const key = JSON.stringify(target) + '|' + folder;
            disk[key] = disk[key] || {};
            files.forEach((f, i) => { disk[key][f.name] = `file:///sd/${folder}/${f.name}`; window.__emit('downloadProgress', { jobId, done: i + 1, failed: 0, total: files.length }); });
            return { total: files.length, failed: 0, cancelled: false, originalBytes: 1000 * files.length, savedBytes: 600 * files.length };
          },
          async listAlbum({ target, folder }) { const d = disk[JSON.stringify(target) + '|' + folder]; return { exists: !!d, files: d ? Object.entries(d).map(([name, uri]) => ({ name, uri })) : [] }; },
          async deleteAlbum({ target, folder }) { delete disk[JSON.stringify(target) + '|' + folder]; return { deleted: true }; },
        },
      },
    };
  }, { onboarded, storage });
  return page;
}

export const text = (page, sel) => page.textContent(sel).then((t) => (t || '').replace(/\s+/g, ' ').trim());
