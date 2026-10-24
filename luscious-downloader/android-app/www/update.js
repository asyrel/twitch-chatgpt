// In-app updater: compares this build with the latest GitHub release and installs the new APK.
import * as L from './api.js';
import * as N from './native.js';
import { $, esc, store } from './util.js';

const REPO = 'asyrel/twitch-chatgpt';
const TAG = 'miwaku-latest';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`;

let current = null;
// This app's build number (written by the build server into build.json; 0 in development).
export async function currentBuild() {
  if (current !== null) return current;
  try { current = (await (await fetch('./build.json', { cache: 'no-store' })).json()).build || 0; } catch { current = 0; }
  return current;
}

// Latest published build: { build, notes, apk } (cached for 30 minutes unless forced).
export async function latest(force = false) {
  const c = store.get('ldl_update', null);
  if (!force && c && Date.now() - c.at < 30 * 60 * 1000) return c;
  const r = await L.getJson(RELEASE_API, { Accept: 'application/vnd.github+json' });
  const build = +((r.name || '').match(/build (\d+)/i) || [])[1] || 0;
  const apk = (r.assets || []).find((a) => /\.apk$/i.test(a.name))?.browser_download_url || `https://github.com/${REPO}/releases/download/${TAG}/Miwaku.apk`;
  const notes = String(r.body || '').split('\n').filter((l) => /^\s*- /.test(l)).map((l) => l.replace(/^\s*- /, '')).slice(0, 8);
  const out = { build, notes, apk, at: Date.now() };
  store.set('ldl_update', out);
  return out;
}

export async function available(force = false) {
  const [cur, l] = await Promise.all([currentBuild(), latest(force)]);
  return cur && l.build > cur ? l : null;
}

// Shows a dot on the Settings tab when a new version is out (checked at most every 30 minutes).
export async function checkInBackground() {
  try { document.querySelector('[data-tab=settings]')?.classList.toggle('dot', !!(await available())); } catch {}
}

// The "App updates" box in Settings.
export async function renderUpdateBox(el) {
  const cur = await currentBuild();
  const show = (html) => { el.innerHTML = `<h3>App updates</h3><p class="muted small">This version: build ${cur || 'dev'}</p>${html}`; };
  const check = async (force) => {
    show('<p class="muted small">Checking…</p>');
    let l;
    try { l = await latest(force); } catch (e) {
      show(`<p class="small">Couldn't check for updates (${esc(e.message || e)}).</p><button id="updCheck">Try again</button>`);
      $('#updCheck').onclick = () => check(true);
      return;
    }
    if (!cur || l.build <= cur) {
      show(`<p class="small">✓ You have the latest version${l.build ? ` (build ${l.build})` : ''}.</p><button id="updCheck">Check again</button>`);
      $('#updCheck').onclick = () => check(true);
      document.querySelector('[data-tab=settings]')?.classList.remove('dot');
      return;
    }
    document.querySelector('[data-tab=settings]')?.classList.add('dot');
    show(`<p><b>New version ready: build ${l.build}</b></p>
      ${l.notes.length ? `<ul class="small">${l.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <button class="primary" id="updGo">⬇ Download and install</button>
      <p class="muted small">Your boards, journal and downloads are kept.</p><div id="updMsg" class="small"></div>`);
    $('#updGo').onclick = async (e) => {
      const btn = e.target;
      const msg = $('#updMsg');
      if (!N.hasNative) { location.href = l.apk; return; }
      btn.disabled = true;
      try {
        await N.installUpdate(l.apk, (p) => { btn.textContent = p.total ? `Downloading… ${Math.round((p.done / p.total) * 100)}%` : 'Downloading…'; });
        btn.textContent = 'Opening installer…';
        msg.textContent = 'Tap Update on the screen that opens.';
        setTimeout(() => { btn.disabled = false; btn.textContent = '⬇ Download and install'; }, 4000);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '⬇ Download and install';
        msg.innerHTML = /permission/i.test(err.message || '')
          ? 'Allow <b>Install unknown apps</b> for Miwaku on the screen that opened, then come back and tap the button again.'
          : `Update failed: ${esc(err.message || err)}`;
      }
    };
  };
  await check(false);
}
