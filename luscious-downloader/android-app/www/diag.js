// Connection check: tests every site and feature and shows what works, with a copyable report.
import * as L from './api.js';
import * as N from './native.js';
import * as B from './boorus.js';
import { $, app, esc, toast } from './util.js';

const timed = async (fn) => {
  const t = performance.now();
  try { return { ok: true, value: await fn(), ms: Math.round(performance.now() - t) }; } catch (e) {
    return { ok: false, error: e, ms: Math.round(performance.now() - t) };
  }
};
// Tries to show an image; resolves true/false within 15s.
const imageLoads = (url) => new Promise((res) => {
  if (!url) return res(false);
  const im = new Image();
  const t = setTimeout(() => res(false), 15000);
  im.referrerPolicy = 'no-referrer';
  im.onload = () => { clearTimeout(t); res(true); };
  im.onerror = () => { clearTimeout(t); res(false); };
  im.src = url;
});
const errText = (e) => [e?.message || String(e), ...(e?.details || [])].join(' | ');

export async function renderCheck(ctx) {
  const rows = [];
  const draw = (running) => {
    app.innerHTML = `<div class="page-head"><a class="back" href="#/settings">‹</a><h2>Connection check</h2></div>
      <div class="box checks">${rows.map((r) => `<div class="check ${r.state}">
        <span class="ci">${r.state === 'ok' ? '✅' : r.state === 'warn' ? '⚠️' : r.state === 'fail' ? '❌' : '⏳'}</span>
        <div><b>${esc(r.name)}</b><div class="small muted">${esc(r.detail || '')}</div></div></div>`).join('')}
      </div>
      ${running ? '<p class="muted small center">Checking…</p>' : `
        <div class="row"><button class="primary" id="copyReport">Copy report</button><button id="again">Check again</button></div>
        <button id="redetect" class="linkish">Forget detected luscious settings and check again</button>
        <p class="muted small">Copy the report and paste it to whoever is helping you fix the app.</p>`}`;
    $('#copyReport')?.addEventListener('click', () => {
      const text = `Miwaku connection check (${new Date().toISOString()})\n` + rows.map((r) => `${r.state.toUpperCase()} ${r.name}: ${r.detail}`).join('\n');
      navigator.clipboard?.writeText(text).then(() => toast('Report copied'), () => toast('Couldn’t copy'));
    });
    $('#again')?.addEventListener('click', () => renderCheck(ctx));
    $('#redetect')?.addEventListener('click', () => { L.resetDetected(); renderCheck(ctx); });
  };
  const add = (name) => { const r = { name, state: 'run', detail: '' }; rows.push(r); draw(true); return r; };
  const set = (r, state, detail) => { r.state = state; r.detail = detail; draw(true); };

  // --- device ---
  const dev = add('App & phone');
  set(dev, N.hasNative ? 'ok' : 'warn', `${N.hasNative ? 'Android app' : 'Browser (limited)'} · ${navigator.userAgent.match(/Android [\d.]+|Chrome\/[\d.]+/g)?.join(' · ') || navigator.userAgent.slice(0, 60)}`);

  // --- luscious ---
  const lus = add('luscious.net – albums');
  const albums = await timed(() => L.listAlbums({ section: 'hentai', page: 1 }));
  if (albums.ok) set(lus, albums.value.items.length ? 'ok' : 'warn', `${albums.value.items.length} albums in ${albums.ms} ms via ${L.apiInUse() || '?'}`);
  else set(lus, 'fail', `${errText(albums.error)}${albums.error?.challenge ? ' – try “Verify on luscious.net”' : ''}`);

  const cats = add('luscious.net – categories (hentai / real filter)');
  const c = await timed(() => L.getCategories());
  set(cats, c.ok && c.value.content.length ? 'ok' : 'warn', c.ok ? `content types: ${c.value.content.map((x) => x.title).join(', ') || 'none'}` : errText(c.error));

  const pics = add('luscious.net – album pages');
  if (albums.ok && albums.value.items[0]) {
    const a = albums.value.items[0];
    const p = await timed(() => L.firstPictures(a.id));
    if (!p.ok) set(pics, 'fail', errText(p.error));
    else {
      const pic = p.value[0];
      const [orig, large, thumb] = await Promise.all([imageLoads(pic?.original), imageLoads(pic?.large), imageLoads(pic?.thumb)]);
      set(pics, thumb && (orig || large) ? 'ok' : thumb ? 'warn' : 'fail',
        `${p.value.length} pages · full-size ${orig ? 'loads' : 'blocked'} · large ${large ? 'loads' : 'blocked'} · thumbnail ${thumb ? 'loads' : 'blocked'}`);
    }
  } else set(pics, 'fail', 'skipped (albums didn’t load)');

  const sorts = add('luscious.net – sort options');
  const so = await timed(() => L.getSortOptions());
  set(sorts, so.ok ? 'ok' : 'warn', so.ok ? so.value.join(', ') : errText(so.error));

  const ps = add('luscious.net – single-picture search (Refs)');
  await timed(() => L.searchPictures('stockings', 1));
  const mode = L.pictureSearchMode();
  set(ps, mode === 'none' ? 'warn' : 'ok', mode === 'none' ? 'not supported – Refs uses album search instead' : `works (${mode})`);

  const login = add('luscious.net – sign-in');
  const names = N.hasNative ? await N.cookieNames().catch(() => []) : [];
  const signed = names.some((n) => /^(sessionid|session|auth|token|jwt)/i.test(n));
  set(login, signed ? 'ok' : 'warn', signed ? 'signed in' : 'not signed in (only needed for favorites/private albums)');

  // --- art sites ---
  for (const site of Object.keys(B.SITES)) {
    const r = add(`${B.SITES[site].name}`);
    if (!B.booruPrefs().enabled[site]) { set(r, 'warn', 'turned off in Settings'); continue; }
    const s = await timed(() => B.searchSite(site, '', 1, 'new', 20));
    if (!s.ok) { set(r, 'fail', errText(s.error)); continue; }
    const first = s.value[0];
    const shows = first ? await imageLoads(first.thumb || first.sample) : false;
    set(r, s.value.length && shows ? 'ok' : s.value.length ? 'warn' : 'warn',
      `${s.value.length} NSFW images in ${s.ms} ms${first ? ` · images ${shows ? 'load' : 'blocked'}` : ''}`);
  }

  // --- storage ---
  const st = add('Download location');
  if (!N.hasNative) set(st, 'warn', 'only in the Android app');
  else {
    const target = await ctx.getTarget();
    const vols = await N.getVolumes().catch(() => []);
    const v = target?.type === 'app' ? vols.find((x) => x.index === target.index) : null;
    set(st, target ? 'ok' : 'fail', target ? `${target.label}${v?.free != null ? ` · ${(v.free / 1e9).toFixed(1)} GB free` : ''}` : 'not set – choose one in Settings');
  }
  draw(false);
}
