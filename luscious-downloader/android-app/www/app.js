import * as L from './api.js';
import * as N from './native.js';
import { openReader, closeReader, readerOpen, readerPrefs, saveReaderPrefs, MODES } from './reader.js';
import { $, app, esc, store, loading, imgTag, fmtBytes } from './util.js';
import { renderBoards, renderBoard, addToBoard } from './boards.js';
import { renderPractice } from './gesture.js';
import { renderArtists, renderArtist, artistHref, checkNew } from './artists.js';
import { renderRefs, renderRefResults } from './refs.js';
import { renderArt } from './art.js';
import * as B from './boorus.js';
import { renderFeed, renderTaste } from './feed.js';
import { loadBoards, LIKED_BOARD } from './boards.js';
import { renderSimilar, showSimilar } from './similar.js';
import { renderCheck } from './diag.js';

function showError(e) {
  const details = e?.details?.length ? `<details><summary>Details</summary><pre class="log">${esc(e.details.join('\n'))}</pre></details>` : '';
  const verify = e?.blocked && N.hasNative
    ? `<p class="small">This usually means luscious.net is showing a bot check. Open it once in the app, wait until the site loads (tick the box if asked), then tap <b>Done</b>.</p>
       <button class="primary" id="verifyBtn">Verify on luscious.net</button> `
    : '';
  app.innerHTML = `<div class="err">${esc(e?.message || e)}</div>
    <div class="row">${verify}<button id="retryBtn">Retry</button></div>${details}`;
  $('#retryBtn').onclick = () => route();
  $('#verifyBtn')?.addEventListener('click', async () => {
    try { await N.openVerify('https://www.luscious.net/'); } catch {}
    route();
  });
}

// ---------- preferences & content filters ----------
const HIDE_RULES = {
  gay: { label: 'Gay (male / male)', re: /\b(gay|yaoi|bara|males only|male on male)\b/i },
  futa: { label: 'Futa', re: /futa|futanari|dickgirl/i },
  furry: { label: 'Furry', re: /furr(y|ies)|anthro|yiff/i },
};
const prefs = () => ({ show: { gay: false, futa: false, furry: false }, hideTags: [], mangaMode: 'rtl', compression: 'lossless', ...store.get('ldl_prefs', {}) });
const setPrefs = (p) => store.set('ldl_prefs', p);

// Always blocked, on every site, and not adjustable: anything involving minors.
export const BLOCKED = /\b(loli|lolicon|shota|shotacon|toddlercon|toddler|child|children|kid|kids|underage|minor|young_girl|young_boy|little_girl|little_boy|young|preteen|teen|teenage|aged_down|baby|infant|elementary|middle_school|cub)\b/i;

// Returns why an album is hidden ('Gay', 'tag: x', ...) or null if it should be shown.
function hiddenReason(album, p = prefs()) {
  const labels = [...(album.audiences || []), ...(album.genres || []), ...(album.tags || [])];
  if (labels.some((l) => BLOCKED.test(String(l).replace(/[\s-]+/g, '_')))) return 'Blocked content';
  // Only drawn / animated / artwork: real-life photo albums are never shown.
  if (album.content && L.contentKind(album) === 'real') return 'Real photos';
  if (labels.some((l) => /^(photo_\(medium\)|real_life|photo|cosplay_photo|real people)$/i.test(String(l).replace(/\s+/g, '_')))) return 'Real photos';
  for (const [key, rule] of Object.entries(HIDE_RULES)) {
    if (!p.show[key] && labels.some((l) => rule.re.test(l))) return rule.label;
  }
  const extra = p.hideTags.map((t) => t.toLowerCase());
  const hit = extra.length && labels.find((l) => extra.includes(l.toLowerCase()));
  return hit ? `tag: ${hit}` : null;
}

// Images load directly; if the site refuses, retry through native HTTP.
document.addEventListener('error', async (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.src || img.dataset.retried) return;
  img.dataset.retried = '1';
  try { img.src = await L.imageDataUrl(img.dataset.src); } catch {}
}, true);

// ---------- download location ----------
// { type: 'app', index, label } (private app folder on phone/SD) or { type: 'tree', uri, label } (folder the user picked)
async function getTarget() {
  const t = store.get('ldl_storage', null);
  if (t) return t;
  if (!N.hasNative) return null;
  const vols = await N.getVolumes().catch(() => []);
  const v = vols.find((x) => x.removable) || vols[0];
  if (!v) return null;
  const target = { type: 'app', index: v.index, label: `${v.label} (app folder)` };
  store.set('ldl_storage', target);
  return target;
}

// ---------- reading progress ----------
const progressAll = () => store.get('ldl_progress', {});
const progressOf = (id) => progressAll()[id] || null;
function saveProgress(album, page, total, extra = {}) {
  const all = progressAll();
  all[album.id] = { ...(all[album.id] || {}), id: album.id, title: album.title, cover: album.cover, page, total, at: Date.now(), isManga: !!album.isManga, ...extra };
  const ids = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const id of ids.slice(300)) delete all[id];
  store.set('ldl_progress', all);
}

// ---------- search bar ----------
let section = 'hentai';
const SECTIONS = {
  hentai: { title: 'Hentai', placeholder: 'Search hentai or paste link…' },
  art: { title: 'Art', placeholder: 'Search art tags, e.g. thighhighs smile…' },
  manga: { title: 'Manga', placeholder: 'Search manga or paste link…' },
};
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#q').value.trim();
  $('#q').blur();
  if (L.looksLikeAlbum(v)) location.hash = '#/album/' + encodeURIComponent(v);
  else if (section === 'art') location.hash = `#/art/${encodeURIComponent(v)}`;
  else location.hash = `#/${SECTIONS[section] ? section : 'hentai'}/${encodeURIComponent(v)}/${v ? '' : store.get('ldl_sort', '')}`;
});

// ---------- sorting ----------
let sortValues = ['date_trending', 'date_newest', 'rating_all_time', 'search_score'];
L.getSortOptions().then((v) => {
  sortValues = v;
  if (listState?.section && !listState.loading && !document.querySelector('.reader')) draw();
});
// Two rows of buttons: what to sort by, then (if it applies) the time range.
function sortBar(sec, q, current) {
  const opts = sortValues.map(L.describeSort).filter((o) => o.value !== 'search_score' || q);
  const cur = L.describeSort(current || (q ? 'search_score' : 'date_trending'));
  const kinds = [];
  for (const o of opts) if (!kinds.some((k) => k.kind === o.kind)) kinds.push(o);
  const periods = opts.filter((o) => o.kind === cur.kind && o.period);
  const href = (v) => `#/${sec}/${encodeURIComponent(q)}/${v}`;
  const pickFor = (kind) => {
    const ps = opts.filter((o) => o.kind === kind);
    const lastPeriod = cur.period || store.get('ldl_period', 'all_time');
    return (ps.find((o) => o.period === lastPeriod) || ps.find((o) => o.period === 'all_time') || ps[0]).value;
  };
  return `<div class="sortbar">
    <div class="chips">${kinds.map((k) => `<a class="chip ${k.kind === cur.kind ? 'on' : ''}" data-sort="${pickFor(k.kind)}" href="${href(pickFor(k.kind))}">${esc(k.kindLabel)}</a>`).join('')}</div>
    ${periods.length > 1 ? `<div class="chips small-chips">${periods.map((o) => `<a class="chip ${o.value === cur.value ? 'on' : ''}" data-sort="${o.value}" data-period="${o.period}" href="${href(o.value)}">${esc(o.periodLabel)}</a>`).join('')}</div>` : ''}
  </div>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('.sortbar a[data-sort]');
  if (!a) return;
  store.set('ldl_sort', a.dataset.sort);
  const d = L.describeSort(a.dataset.sort);
  if (d.period) store.set('ldl_period', d.period);
});

// ---------- album lists ----------
let listState = null;
async function renderList(state) {
  listState = { page: 0, items: [], hidden: 0, hasNext: true, ...state };
  loading();
  try { await loadMore(); } catch (e) { showError(e); }
}
// Keeps fetching pages until there's a screenful of albums left after filtering.
async function loadMore() {
  const s = listState;
  s.loading = true;
  try { await loadMoreInner(s); } finally { s.loading = false; }
}
async function loadMoreInner(s) {
  let added = 0, fetched = 0;
  while (s.hasNext && added < 12 && fetched < 5) {
    s.page++; fetched++;
    const res = await s.fetch(s.page);
    if (s !== listState) return;
    s.total = res.info?.total_items;
    s.hasNext = !!res.info?.has_next_page && res.items.length > 0;
    for (const a of res.items) {
      if (s.items.some((x) => x.id === a.id)) continue;
      if (s.section && L.contentKind(a) && L.contentKind(a) !== s.section && s.section !== 'manga') continue;
      if (hiddenReason(a)) { s.hidden++; continue; }
      s.items.push(a); added++;
    }
  }
  draw();
}
function draw() {
  const s = listState;
  const total = s.total != null ? ` <span class="muted">(${s.total})</span>` : '';
  const filtered = s.chipFilter ? s.items.filter((a) => s.chipFilter(a, s.chip)) : s.items;
  app.innerHTML = (s.header?.() || '') + `<h2>${s.title}${total}</h2>` +
    (filtered.length ? `<div class="grid">${filtered.map(card).join('')}</div>` : `<p class="muted">${s.empty || 'No albums found.'}</p>`) +
    (s.hidden ? `<p class="muted small">${s.hidden} hidden by your filters · <a href="#/settings">change</a></p>` : '') +
    (s.hasNext ? '<div class="center"><button id="more">Load more</button></div>' : '');
  s.onRender?.();
  $('#more')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Loading…';
    try { await loadMore(); } catch (err) { e.target.textContent = err.message; e.target.disabled = false; }
  });
}
function card(a) {
  const prog = progressOf(a.id);
  const bar = prog && prog.total ? `<div class="pbar"><div style="width:${Math.round(((prog.page + 1) / prog.total) * 100)}%"></div></div>` : '';
  return `<a class="card" href="#/album/${a.id}">
    <div class="cover">${imgTag(a.cover)}${a.isManga ? '<span class="badge">Manga</span>' : ''}${bar}</div>
    <div class="t">${esc(a.title)}</div>
    <div class="n">${a.pictures} ${a.isManga ? 'pages' : 'pics'}${a.animated ? ` · ${a.animated} gif` : ''}</div>
  </a>`;
}

function renderSection(sec, q, sort) {
  section = sec;
  $('#q').placeholder = SECTIONS[sec].placeholder;
  $('#q').value = q;
  if (!sort && !q) sort = store.get('ldl_sort', '') || '';
  renderList({
    section: sec,
    title: q ? `${SECTIONS[sec].title}: “${esc(q)}”` : SECTIONS[sec].title,
    fetch: (page) => L.listAlbums({ section: sec, q, sort, page }),
    header: () => (sec === 'manga' && !q ? continueRow() : '') + sortBar(sec, q, sort),
  });
}
function continueRow() {
  const items = Object.values(progressAll()).filter((p) => p.isManga).sort((a, b) => b.at - a.at).slice(0, 12);
  if (!items.length) return '';
  return `<h2>Continue reading</h2><div class="hrow">${items.map((p) => `
    <a class="card mini" href="#/read/${p.id}/${p.page}">
      <div class="cover">${imgTag(p.cover)}<div class="pbar"><div style="width:${Math.round(((p.page + 1) / (p.total || 1)) * 100)}%"></div></div></div>
      <div class="t">${esc(p.title)}</div><div class="n">p. ${p.page + 1}/${p.total}</div>
    </a>`).join('')}</div>`;
}

// ---------- luscious.net login ----------
// A normal sign-in form. The password goes only to luscious.net and is never stored; the app keeps the login cookie.
const loginState = () => store.get('ldl_login', null);
const hasSessionCookie = async () => !N.hasNative || (await N.cookieNames()).some((n) => /^(sessionid|session|auth|token|jwt)/i.test(n));

function renderLogin(next = '#/favorites', error, details) {
  app.innerHTML = `<div class="box login">
    <h2>Sign in to luscious.net</h2>
    <form id="loginForm" autocomplete="on">
      <label>Username or email</label>
      <input name="login" autocomplete="username" autocapitalize="none" spellcheck="false" required>
      <label style="margin-top:10px">Password</label>
      <div class="pw"><input name="password" type="password" autocomplete="current-password" required><button type="button" id="showPw" aria-label="Show password">👁</button></div>
      <button class="primary" type="submit">Sign in</button>
    </form>
    ${error ? `<div class="err" style="margin-top:12px">${esc(error)}</div>` : ''}
    ${details?.length ? `<details><summary>Details</summary><pre class="log">${esc(details.join('\n'))}</pre></details>` : ''}
    <p class="muted small">Your password is sent only to luscious.net and is never saved on your phone.</p>
    <p class="small"><a href="#/favorites" id="noLogin">Skip – just use my profile link</a></p>
  </div>`;
  $('#showPw').onclick = () => { const i = $('#loginForm [name=password]'); i.type = i.type === 'password' ? 'text' : 'password'; };
  $('#noLogin').onclick = () => store.set('ldl_skip_login', true);
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const { user } = await L.signIn(String(f.get('login')).trim(), String(f.get('password')), hasSessionCookie);
      store.set('ldl_login', { signedIn: true, at: Date.now(), name: user?.name || String(f.get('login')).trim() });
      if (user) store.set('ldl_user', { id: user.id, name: user.name });
      location.hash = next;
      if (location.hash === next) route();
    } catch (err) {
      // Rare: luscious.net insists on a bot check first.
      if (err.challenge && N.hasNative) {
        await N.openVerify('https://www.luscious.net/').catch(() => {});
        return renderLogin(next, 'Check complete – please tap Sign in again.');
      }
      renderLogin(next, err.message, err.details);
    }
  });
}
async function signOut() {
  await N.clearCookies().catch(() => {});
  store.set('ldl_login', null);
  store.set('ldl_user', null);
}

// ---------- favorites ----------
function renderFavorites() {
  const me = store.get('ldl_user', null);
  if (!me && !loginState()?.signedIn && !store.get('ldl_skip_login', false) && N.hasNative) return renderLogin('#/favorites');
  if (!me) return renderProfileForm();
  const chips = { all: 'All', hentai: 'Hentai', manga: 'Manga' };
  const state = {
    title: `♥ ${esc(me.name)}'s favorites`,
    empty: 'No favorites here.',
    fetch: (page) => L.favoriteAlbums(me.id, page),
    chip: 'all',
    chipFilter: (a, chip) => chip === 'all' ? true
      : chip === 'manga' ? a.isManga
      : !a.isManga && L.contentKind(a) === chip,
    header: () => `${libraryNav('favorites')}<div class="chips">${Object.entries(chips).map(([k, v]) => `<button data-chip="${k}" class="${listState.chip === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="row"><button id="dlAll">⬇ Download all favorites</button><button id="changeUser">${loginState()?.signedIn ? 'Account' : 'Change account'}</button></div>`,
    onRender() {
      app.querySelectorAll('[data-chip]').forEach((b) => (b.onclick = () => { listState.chip = b.dataset.chip; draw(); }));
      $('#changeUser').onclick = () => (loginState()?.signedIn ? (location.hash = '#/settings') : (store.set('ldl_user', null), renderProfileForm()));
      $('#dlAll').onclick = downloadAllFavorites;
    },
  };
  renderList(state);
}
function renderProfileForm(error) {
  const login = loginState();
  app.innerHTML = `<div class="box">
    <h2>Your favorites</h2>
    ${login?.signedIn
      ? `<p class="small">✓ Signed in to luscious.net. The app couldn't work out your account automatically, so paste your profile link below once.</p>`
      : `<a class="btn primary" href="#/login" style="width:100%">Sign in with your luscious account</a>
         <p class="muted small" style="text-align:center;margin:12px 0">or, without signing in</p>`}
    <form id="pf">
      <label>Your luscious.net profile link or user ID</label>
      <input name="u" placeholder="https://www.luscious.net/users/123456/" required autocomplete="off">
      <button type="submit">Show my favorites</button>
    </form>
    ${error ? `<div class="err" style="margin-top:12px">${esc(error)}</div>` : ''}
    <p class="muted small">No password needed. On luscious.net, open your profile and copy the link (it has a number in it, like <b>/users/123456/</b>).</p>
  </div>`;
  $('#pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = L.parseUserId(new FormData(e.target).get('u'));
    if (!id) return renderProfileForm("That doesn't look like a profile link. It should contain /users/ and a number.");
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const p = await L.getProfile(id);
      store.set('ldl_user', { id: p.id, name: p.name });
      renderFavorites();
    } catch (err) { renderProfileForm(err.message); }
  });
}
async function downloadAllFavorites(e) {
  const me = store.get('ldl_user', null);
  e.target.disabled = true; e.target.textContent = 'Finding favorites…';
  try {
    const all = [];
    for (let page = 1; page < 200; page++) {
      const r = await L.favoriteAlbums(me.id, page);
      all.push(...r.items.filter((a) => !hiddenReason(a)));
      if (!r.info?.has_next_page || !r.items.length) break;
    }
    all.forEach(enqueue);
    e.target.textContent = `Queued ${all.length} albums`;
  } catch (err) { e.target.textContent = err.message; e.target.disabled = false; }
}

// ---------- album / manga page ----------
let current = null;
const albumCache = new Map();
async function loadAlbum(id) {
  if (albumCache.has(id)) return albumCache.get(id);
  const [album, pictures] = await Promise.all([L.getAlbum(id), L.getAllPictures(id)]);
  const v = { album, pictures };
  albumCache.set(id, v);
  if (albumCache.size > 20) albumCache.delete(albumCache.keys().next().value);
  return v;
}
async function renderAlbum(ref) {
  const id = L.parseAlbumId(ref);
  if (!id) return showError("That doesn't look like a luscious.net album link.");
  loading();
  try {
    current = await loadAlbum(id);
    const { album, pictures } = current;
    const prog = progressOf(album.id);
    const reason = hiddenReason(album);
    const tags = [...album.audiences, ...album.genres, ...album.tags].slice(0, 30);
    const readLabel = prog && prog.page > 0 ? `📖 Continue p. ${prog.page + 1}` : album.isManga ? '📖 Read' : '▶ View';
    app.innerHTML = `
      <div class="page-head"><button class="back" id="backBtn" aria-label="Back">‹</button><span class="muted small">${album.isManga ? 'Manga' : 'Album'}</span></div>
      <div class="album-head">
        ${imgTag(album.cover)}
        <div style="min-width:0">
          <h1>${esc(album.title)}</h1>
          <div class="muted small">${album.isManga ? 'Manga · ' : ''}${album.content ? esc(album.content) + ' · ' : ''}${pictures.length} ${album.isManga ? 'pages' : 'files'}${album.language ? ' · ' + esc(album.language) : ''}</div>
          ${album.author ? `<div class="small">by ${album.authorId ? `<a class="artist-link" href="${artistHref('user', album.authorId, album.author)}">${esc(album.author)}</a>` : esc(album.author)}</div>` : ''}
          ${album.artists.length ? `<div class="small">artist: ${album.artists.map((x) => `<a class="artist-link" href="${artistHref('tag', x, x)}">${esc(x)}</a>`).join(', ')}</div>` : ''}
          ${reason ? `<div class="muted small">⚠ Normally hidden (${esc(reason)})</div>` : ''}
          <div class="row">
            <button class="primary" id="read">${readLabel}</button>
            <button id="dl">⬇ Save</button>
          </div>
          ${prog && prog.page > 0 ? '<button id="restart" class="linkish">Start from page 1</button>' : ''}
          ${savedEntry(album.id) ? `<div class="muted small">✓ Saved to ${esc(savedEntry(album.id).target.label)} · <button id="delSaved" class="linkish">Delete from phone</button></div>` : ''}
        </div>
      </div>
      <div class="row">${tags.map((t) => `<a class="tag" href="#/${album.isManga ? 'manga' : 'hentai'}/${encodeURIComponent(t)}/">${esc(t)}</a>`).join('')}</div>
      <div class="grid thumbs">${pictures.map((p, i) => `<div class="thumb" data-i="${i}">${imgTag(p.thumb)}<span>${i + 1}</span></div>`).join('')}</div>`;
    $('#backBtn').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/browse'));
    $('#read').onclick = () => startReading(album, pictures, prog?.page || 0);
    $('#restart')?.addEventListener('click', () => startReading(album, pictures, 0));
    $('#dl').onclick = (e) => { enqueue(album); e.target.textContent = 'Queued'; e.target.disabled = true; };
    $('#delSaved')?.addEventListener('click', async () => { if (confirm('Delete the saved copy of this album from your phone?')) { await deleteSaved(album.id); renderAlbum(album.id); } });
    app.querySelectorAll('.thumb').forEach((t) => (t.onclick = () => startReading(album, pictures, +t.dataset.i)));
  } catch (e) { showError(e); }
}

async function startReading(album, pictures, start) {
  const saved = savedEntry(album.id);
  const local = saved ? await L.localUrls(saved.target, saved.folder, pictures) : null;
  const pages = pictures.map((p, i) => (local?.[i]
    ? { src: local[i], fallback: p.original, fallback2: p.large }
    : { src: p.original, fallback: p.large }));
  const p = prefs();
  const prog = progressOf(album.id);
  const mode = prog?.mode || (album.isManga ? p.mangaMode : 'ltr');
  openReader({
    title: album.title, pages, start, mode,
    onAddToBoard: (i) => addToBoard(album, pictures[i], i, ctx),
    onSimilar: (i) => showSimilar({ key: pictures[i].id, thumb: pictures[i].thumb, tags: [...album.tags, ...album.genres], artists: album.artists }),
    onPage: (i) => saveProgress(album, i, pictures.length),
    onMode: (m) => saveProgress(album, progressOf(album.id)?.page || 0, pictures.length, { mode: m }),
    onClose: () => { if (location.hash.startsWith('#/album/')) renderAlbum(album.id); },
  });
}
async function renderRead(id, page) {
  loading();
  try {
    const { album, pictures } = await loadAlbum(id);
    current = { album, pictures };
    history.replaceState(null, '', `#/album/${id}`);
    await renderAlbum(id);
    startReading(album, pictures, page);
  } catch (e) { showError(e); }
}

// ---------- downloads ----------
const queue = [];
let active = null;
const dlHistory = () => store.get('ldl_history', []);
const savedEntry = (id) => dlHistory().find((h) => h.id === id && h.target && (h.status === 'done' || h.status === 'partial')) || null;
async function deleteSaved(id) {
  const e = savedEntry(id);
  if (!e) return;
  try { await N.deleteAlbum(e.target, e.folder); } catch {}
  store.set('ldl_history', dlHistory().filter((h) => h.id !== id));
}
function enqueue(album) {
  if (active?.album.id === album.id || queue.some((a) => a.id === album.id)) return;
  queue.push(album);
  runQueue();
  if (location.hash === '#/downloads') renderDownloads();
}
async function runQueue() {
  if (active || !queue.length) return;
  const album = queue.shift();
  active = { album, done: 0, total: 0, failed: 0 };
  N.setBackgroundMode(true);
  showBar();
  let entry;
  try {
    $('#dltext').textContent = `Listing “${album.title}”…`;
    const target = await getTarget();
    const pictures = albumCache.get(album.id)?.pictures || await L.getAllPictures(album.id);
    active.total = pictures.length;
    const r = await L.saveAlbum(album, pictures, target, {
      jobId: `${album.id}-${Date.now()}`,
      compression: prefs().compression,
      onProgress: (p) => { Object.assign(active, { done: p.done, failed: p.failed, total: p.total }); showBar(); },
    });
    const prev = dlHistory().find((h) => h.id === album.id);
    entry = {
      id: album.id, title: album.title, target, folder: r.folder, count: pictures.length - r.failed, failed: r.failed,
      status: r.cancelled ? 'cancelled' : r.failed ? 'partial' : 'done',
      originalBytes: (prev?.originalBytes || 0) + r.originalBytes, savedBytes: (prev?.savedBytes || 0) + r.savedBytes,
    };
  } catch (e) {
    entry = { id: album.id, title: album.title, status: 'error', error: e.message };
  }
  store.set('ldl_history', [{ ...entry, at: Date.now() }, ...dlHistory().filter((h) => h.id !== album.id)].slice(0, 300));
  active = null;
  if (!queue.length) { $('#dlbar').hidden = true; N.setBackgroundMode(false); }
  if (location.hash === '#/downloads') renderDownloads();
  runQueue();
}
function showBar() {
  if (!active) return;
  $('#dlbar').hidden = false;
  const more = queue.length ? ` · ${queue.length} more queued` : '';
  if (active.total) $('#dltext').textContent = `${active.done}/${active.total} · ${active.album.title}${more}`;
  $('#dlfill').style.width = active.total ? `${(active.done / active.total) * 100}%` : '0';
}
$('#dlcancel').onclick = () => { queue.length = 0; N.cancelDownloads(); };

const sizeNote = (x) => x.savedBytes && x.originalBytes > x.savedBytes ? `<br><span class="small">${fmtBytes(x.originalBytes)} → ${fmtBytes(x.savedBytes)}</span>` : x.savedBytes ? `<br><span class="small">${fmtBytes(x.savedBytes)}</span>` : '';
async function renderDownloads() {
  const h = dlHistory();
  const target = await getTarget();
  const label = { done: '✓ Saved', partial: '⚠ Some failed', cancelled: 'Cancelled', error: '✕ Failed' };
  const totO = h.reduce((n, x) => n + (x.originalBytes || 0), 0), totS = h.reduce((n, x) => n + (x.savedBytes || 0), 0);
  app.innerHTML = `${libraryNav('downloads')}<h2>Downloads</h2>
    ${totO > totS && totS ? `<p class="small">Compression saved <b>${fmtBytes(totO - totS)}</b> (${fmtBytes(totO)} → ${fmtBytes(totS)})</p>` : ''}
    ${active ? `<p>Downloading <b>${esc(active.album.title)}</b>…</p>` : ''}
    ${queue.length ? `<p class="muted">${queue.length} album(s) waiting</p>` : ''}
    <p class="muted small">Saving to <b>${esc(target?.label || 'not set')}</b> · <a href="#/settings">change</a><br>Downloads are hidden from your Gallery. Saved albums open offline in the reader. Tap Save again on an album to fill in any missing pictures.</p>
    <div class="list">${h.map((x) => `<div class="item"><a href="#/album/${x.id}">${esc(x.title)}</a>
      <span class="muted nowrap" title="${esc(x.error || x.folder || '')}">${label[x.status] || ''}${x.status === 'done' ? ` (${x.count})` : x.failed ? ` (${x.failed})` : ''}${x.target ? ` <button class="linkish" data-del="${x.id}">delete</button>` : ''}${sizeNote(x)}</span></div>`).join('') || '<p class="muted">Nothing downloaded yet.</p>'}</div>
    ${h.length ? '<div class="center"><button id="clearH">Clear list</button></div>' : ''}`;
  $('#clearH')?.addEventListener('click', () => { if (confirm('Clear the list? (Saved files stay on your phone.)')) { store.set('ldl_history', []); renderDownloads(); } });
  app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this album from your phone?')) return;
    b.disabled = true; await deleteSaved(b.dataset.del); renderDownloads();
  }));
}

// ---------- settings ----------
async function renderSettings() {
  const p = prefs();
  const rp = readerPrefs();
  const me = store.get('ldl_user', null);
  const target = await getTarget();
  const vols = await N.getVolumes().catch(() => []);
  app.innerHTML = `<h2>Settings</h2>
    <a class="btn primary checkbtn" href="#/check">🩺 Connection check</a>
    <div class="box">
      <h3>Save downloads to</h3>
      ${N.hasNative ? `
      ${vols.map((v) => `<label class="switch"><input type="radio" name="loc" value="app:${v.index}" ${target?.type === 'app' && target.index === v.index ? 'checked' : ''}>
        <span>${esc(v.label)} – app folder<br><span class="muted small">${fmtBytes(v.free)} free</span></span></label>`).join('')}
      <label class="switch"><input type="radio" name="loc" value="tree" ${target?.type === 'tree' ? 'checked' : ''}>
        <span>${target?.type === 'tree' ? esc(target.label) : 'A folder I choose…'}</span></label>
      <button id="pickFolder">Choose folder (phone or SD card)…</button>
      <p class="muted small">Downloads never appear in your Gallery.<br>
      <b>App folder:</b> no setup needed, but Android deletes it if you uninstall the app (updating is fine).<br>
      <b>Folder you choose:</b> kept even if you uninstall. Tip: on your SD card, create a folder like “Luscious” and pick it.</p>` : '<p class="muted small">Only available in the Android app.</p>'}
      <label style="margin-top:12px">Compress images while downloading</label>
      <select id="compression">${Object.entries(L.COMPRESSION).map(([k, v]) => `<option value="${k}" ${p.compression === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <p class="muted small"><b>Lossless</b> keeps every pixel and the full size: PNG pages are re-packed as lossless WebP (often 25–50% smaller); JPEGs are kept exactly as they are. The other options save more space by re-encoding. Pages are never cropped, and GIFs and videos are never changed.</p>
    </div>
    <div class="box">
      <h3>Art sites</h3>
      ${Object.entries(B.SITES).map(([k, v]) => `<label class="switch"><input type="checkbox" data-site="${k}" ${B.booruPrefs().enabled[k] ? 'checked' : ''}><span>${v.name}</span></label>`).join('')}
      <label style="margin-top:8px">Content</label>
      <select id="bRatings"><option value="nsfw">NSFW (explicit + questionable)</option><option value="explicit">Explicit only</option></select>
      <details><summary>Accounts (optional, for better results)</summary>
        <p class="muted small">Danbooru: without an API key, searches are limited to 2 tags. Gelbooru may require a key. Find them in your account settings on each site.</p>
        <label>Danbooru username</label><input id="dbU" autocomplete="off" autocapitalize="none">
        <label>Danbooru API key</label><input id="dbK" autocomplete="off" autocapitalize="none">
        <label>Gelbooru user ID</label><input id="gbU" autocomplete="off" inputmode="numeric">
        <label>Gelbooru API key</label><input id="gbK" autocomplete="off" autocapitalize="none">
      </details>
    </div>
    <div class="box">
      <h3>Show these (hidden by default)</h3>
      ${Object.entries(HIDE_RULES).map(([k, r]) => `<label class="switch"><input type="checkbox" data-show="${k}" ${p.show[k] ? 'checked' : ''}><span>${r.label}</span></label>`).join('')}
      <p class="muted small">Real-life photos are never shown, and anything involving minors is always blocked on every site.</p>
      <label style="margin-top:12px">Also hide albums with these tags (comma separated)</label>
      <input id="hideTags" value="${esc(p.hideTags.join(', '))}" placeholder="e.g. guro, scat">
    </div>
    <div class="box">
      <h3>Reader</h3>
      <label>Manga reading direction</label>
      <select id="mangaMode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${p.mangaMode === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label>Page fit</label>
      <select id="fit"><option value="screen">Fit screen</option><option value="width">Fit width</option></select>
      <label>Background</label>
      <select id="bg"><option value="black">Black</option><option value="gray">Gray</option><option value="white">White</option></select>
      <label>Pages to load ahead</label>
      <select id="preload">${[2, 4, 6, 10].map((n) => `<option ${rp.preload === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="switch"><input type="checkbox" id="invert" ${rp.invertTaps ? 'checked' : ''}><span>Invert tap zones</span></label>
      <label class="switch"><input type="checkbox" id="awake" ${rp.keepAwake ? 'checked' : ''}><span>Keep screen on while reading</span></label>
      <label class="switch"><input type="checkbox" id="pnum" ${rp.showPageNum ? 'checked' : ''}><span>Show page number</span></label>
      <label class="switch"><input type="checkbox" id="volkeys" ${rp.volumeKeys ? 'checked' : ''}><span>Volume keys turn pages</span></label>
      <label class="switch"><input type="checkbox" id="fullscr" ${rp.fullscreen ? 'checked' : ''}><span>Hide status bar while reading</span></label>
    </div>
    <div class="box">
      <h3>luscious.net account</h3>
      <p class="small">${loginState()?.signedIn ? `✓ Signed in${me ? ` as <b>${esc(me.name)}</b>` : ''}` : 'Not signed in'}</p>
      ${loginState()?.signedIn
        ? '<button id="signOutBtn">Sign out</button>'
        : '<a class="btn primary" href="#/login">Sign in</a><p class="muted small">Your password only goes to luscious.net and is never saved.</p>'}
      <p class="muted small" style="margin-top:10px">${me ? `Favorites shown from <b>${esc(me.name)}</b> (user ${esc(me.id)})` : 'No favorites profile set.'}</p>
      <a class="btn" href="#/favorites">${me ? 'Open favorites' : 'Set up favorites'}</a>
      <button id="clearProgress">Clear reading history</button>
    </div>`;
  $('#fit').value = rp.fit; $('#bg').value = rp.bg;
  {
    const bp = B.booruPrefs();
    $('#bRatings').value = bp.ratings;
    $('#dbU').value = bp.danbooruUser; $('#dbK').value = bp.danbooruKey; $('#gbU').value = bp.gelbooruUser; $('#gbK').value = bp.gelbooruKey;
    const bset = (f) => { const x = B.booruPrefs(); f(x); B.saveBooruPrefs(x); };
    app.querySelectorAll('[data-site]').forEach((c) => (c.onchange = () => bset((x) => { x.enabled[c.dataset.site] = c.checked; })));
    $('#bRatings').onchange = (e) => bset((x) => { x.ratings = e.target.value; });
    for (const [id, key] of [['dbU', 'danbooruUser'], ['dbK', 'danbooruKey'], ['gbU', 'gelbooruUser'], ['gbK', 'gelbooruKey']]) $('#' + id).onchange = (e) => bset((x) => { x[key] = e.target.value.trim(); });
  }
  app.querySelectorAll('[data-show]').forEach((c) => (c.onchange = () => { const x = prefs(); x.show[c.dataset.show] = c.checked; setPrefs(x); }));
  $('#hideTags').onchange = (e) => { const x = prefs(); x.hideTags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); setPrefs(x); };
  $('#mangaMode').onchange = (e) => { const x = prefs(); x.mangaMode = e.target.value; setPrefs(x); };
  const rset = (k, v) => { const x = readerPrefs(); x[k] = v; saveReaderPrefs(x); };
  $('#fit').onchange = (e) => rset('fit', e.target.value);
  $('#bg').onchange = (e) => rset('bg', e.target.value);
  $('#preload').onchange = (e) => rset('preload', +e.target.value);
  $('#invert').onchange = (e) => rset('invertTaps', e.target.checked);
  $('#awake').onchange = (e) => rset('keepAwake', e.target.checked);
  $('#pnum').onchange = (e) => rset('showPageNum', e.target.checked);
  $('#compression').onchange = (e) => { const x = prefs(); x.compression = e.target.value; setPrefs(x); };
  $('#volkeys').onchange = (e) => rset('volumeKeys', e.target.checked);
  $('#fullscr').onchange = (e) => rset('fullscreen', e.target.checked);
  const pick = async () => {
    try {
      const r = await N.pickFolder();
      if (r?.uri) store.set('ldl_storage', { type: 'tree', uri: r.uri, label: r.name || 'Chosen folder' });
    } catch {}
    renderSettings();
  };
  $('#pickFolder')?.addEventListener('click', pick);
  app.querySelectorAll('input[name=loc]').forEach((r) => (r.onchange = () => {
    if (r.value === 'tree') {
      const prev = store.get('ldl_storage_tree', null);
      return prev ? (store.set('ldl_storage', prev), renderSettings()) : pick();
    }
    const v = vols.find((x) => `app:${x.index}` === r.value);
    store.set('ldl_storage', { type: 'app', index: v.index, label: `${v.label} (app folder)` });
  }));
  if (target?.type === 'tree') store.set('ldl_storage_tree', target);
  $('#signOutBtn')?.addEventListener('click', async () => {
    if (!confirm('Sign out of luscious.net in this app?')) return;
    await signOut();
    renderSettings();
  });
  $('#clearProgress').onclick = (e) => { store.set('ldl_progress', {}); e.target.textContent = 'Cleared'; };
}

// ---------- library (boards, artists, favorites, downloads) ----------
let newArtists = 0;
function libraryNav(active) {
  const tabs = { refs: '🔎 Refs', boards: '🎨 Boards', artists: `👤 Artists${newArtists ? ` <span class="newbadge">${newArtists}</span>` : ''}`, favorites: '♥ Favorites', downloads: '⬇ Saved' };
  return `<div class="chips libnav">${Object.entries(tabs).map(([k, v]) => `<a class="chip ${k === active ? 'on' : ''}" href="#/${k}">${v}</a>`).join('')}</div>`;
}
const refreshNewBadge = () => checkNew().then((n) => {
  newArtists = n;
  $('#tabbar a[data-tab=library]').classList.toggle('dot', n > 0);
}).catch(() => {});

// Shared helpers handed to the boards / practice / artists screens.
const ctx = {
  getTarget, hiddenReason, card, showError, libraryNav,
  compression: () => prefs().compression,
  openReader: (o) => openReader(o),
};

// ---------- router ----------
function route() {
  if (readerOpen()) closeReader();
  listState = null; // any list still loading must not draw over the new screen
  const [, kind = '', a = '', b = ''] = location.hash.split('/');
  if (SECTIONS[kind]) section = kind;
  const LIB = ['library', 'favorites', 'downloads', 'boards', 'board', 'practice', 'artists', 'artist', 'login', 'refs'];
  const isFeed = kind === '' || kind === 'feed' || kind === 'taste';
  const tab = isFeed ? 'feed' : LIB.includes(kind) || kind === 'board-liked' ? 'library' : kind === 'settings' ? 'settings' : 'browse';
  document.querySelectorAll('#tabbar a').forEach((n) => n.classList.toggle('on', n.dataset.tab === tab));
  if (SECTIONS[kind]) document.querySelectorAll('#sections a').forEach((n) => n.classList.toggle('on', n.dataset.tab === kind));
  // The search bar only shows while browsing; the feed uses the whole screen.
  document.body.classList.toggle('browsing', !!SECTIONS[kind] || kind === 'browse');
  document.body.classList.toggle('feedmode', kind === '' || kind === 'feed');
  if (kind === '' || kind === 'feed') return renderFeed(ctx);
  if (kind === 'taste') return renderTaste(ctx);
  if (kind === 'similar') return renderSimilar(ctx);
  if (kind === 'check') return renderCheck(ctx);
  if (kind === 'browse') { location.replace(`#/${store.get('ldl_last_section', 'hentai')}`); return; }
  if (SECTIONS[kind]) store.set('ldl_last_section', kind);
  if (kind === 'board-liked') {
    const liked = loadBoards().boards.find((x) => x.name === LIKED_BOARD);
    return liked ? renderBoard(liked.id, ctx) : renderBoards(ctx);
  }
  window.scrollTo(0, 0);
  if (!SECTIONS[kind] || kind === 'art') $('#q').value = '';
  $('#q').placeholder = SECTIONS[section]?.placeholder || '';
  if (kind === 'art') {
    const c = location.hash.split('/')[4];
    $('#q').value = decodeURIComponent(a);
    return renderArt(decodeURIComponent(a), b, c, ctx);
  }
  if (kind === 'album') return renderAlbum(decodeURIComponent(a));
  if (kind === 'read') return renderRead(a, +b || 0);
  if (kind === 'favorites') return renderFavorites();
  if (kind === 'downloads') return renderDownloads();
  if (kind === 'settings') return renderSettings();
  if (kind === 'login') return renderLogin(a ? decodeURIComponent(a) : '#/favorites');
  if (kind === 'library' || kind === 'refs') {
    const [, , sec, term, label] = location.hash.split('/');
    return term ? renderRefResults(sec, decodeURIComponent(term), decodeURIComponent(label || ''), ctx) : renderRefs(ctx);
  }
  if (kind === 'boards') return renderBoards(ctx);
  if (kind === 'board') return renderBoard(a, ctx);
  if (kind === 'practice') return renderPractice(ctx, a === 'board' && b ? { source: `board:${b}` } : {});
  if (kind === 'artists') { refreshNewBadge(); return renderArtists(ctx); }
  if (kind === 'artist') {
    const [, , type, id, name] = location.hash.split('/');
    return renderArtist(type, decodeURIComponent(id || ''), decodeURIComponent(name || ''), ctx).then(refreshNewBadge);
  }
  renderSection(SECTIONS[kind] ? kind : 'hentai', decodeURIComponent(a), b);
}
window.addEventListener('hashchange', route);
L.getCategories().catch(() => {});
route();
setTimeout(refreshNewBadge, 4000);
