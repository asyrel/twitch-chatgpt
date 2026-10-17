import * as L from './api.js';
import { openReader, closeReader, readerOpen, readerPrefs, saveReaderPrefs, MODES } from './reader.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const loading = () => (app.innerHTML = '<div class="center"><div class="spinner"></div></div>');
const showError = (e) => (app.innerHTML = `<div class="err">${esc(e.message || e)}</div>`);

// ---------- preferences & content filters ----------
const HIDE_RULES = {
  gay: { label: 'Gay (male / male)', re: /\b(gay|yaoi|bara|males only|male on male)\b/i },
  futa: { label: 'Futa', re: /futa|futanari|dickgirl/i },
  furry: { label: 'Furry', re: /furr(y|ies)|anthro|yiff/i },
};
const prefs = () => ({ show: { gay: false, futa: false, furry: false }, hideTags: [], mangaMode: 'rtl', ...store.get('ldl_prefs', {}) });
const setPrefs = (p) => store.set('ldl_prefs', p);

// Returns why an album is hidden ('Gay', 'tag: x', ...) or null if it should be shown.
function hiddenReason(album, p = prefs()) {
  const labels = [...album.audiences, ...album.genres, ...album.tags];
  for (const [key, rule] of Object.entries(HIDE_RULES)) {
    if (!p.show[key] && labels.some((l) => rule.re.test(l))) return rule.label;
  }
  const extra = p.hideTags.map((t) => t.toLowerCase());
  const hit = extra.length && labels.find((l) => extra.includes(l.toLowerCase()));
  return hit ? `tag: ${hit}` : null;
}

// Images load directly; if the site refuses, retry through native HTTP.
const imgTag = (url) => url ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(url)}" data-src="${esc(url)}" alt="">` : '<img alt="">';
document.addEventListener('error', async (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.src || img.dataset.retried) return;
  img.dataset.retried = '1';
  try { img.src = await L.imageDataUrl(img.dataset.src); } catch {}
}, true);

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
  real: { title: 'Real', placeholder: 'Search real or paste link…' },
  manga: { title: 'Manga', placeholder: 'Search manga or paste link…' },
};
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#q').value.trim();
  $('#q').blur();
  if (L.looksLikeAlbum(v)) location.hash = '#/album/' + encodeURIComponent(v);
  else location.hash = `#/${SECTIONS[section] ? section : 'hentai'}/${encodeURIComponent(v)}/${$('#sort').value || ''}`;
});
$('#sort').addEventListener('change', () => $('#search').requestSubmit());

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
  $('#q').value = q; $('#sort').value = sort;
  renderList({
    section: sec,
    title: q ? `${SECTIONS[sec].title}: “${esc(q)}”` : `Trending ${SECTIONS[sec].title.toLowerCase()}`,
    fetch: (page) => L.listAlbums({ section: sec, q, sort, page }),
    header: () => (sec === 'manga' && !q ? continueRow() : ''),
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

// ---------- favorites ----------
function renderFavorites() {
  const me = store.get('ldl_user', null);
  if (!me) return renderProfileForm();
  const chips = { all: 'All', hentai: 'Hentai', real: 'Real', manga: 'Manga' };
  const state = {
    title: `♥ ${esc(me.name)}'s favorites`,
    empty: 'No favorites here.',
    fetch: (page) => L.favoriteAlbums(me.id, page),
    chip: 'all',
    chipFilter: (a, chip) => chip === 'all' ? true
      : chip === 'manga' ? a.isManga
      : !a.isManga && L.contentKind(a) === chip,
    header: () => `<div class="chips">${Object.entries(chips).map(([k, v]) => `<button data-chip="${k}" class="${listState.chip === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="row"><button id="dlAll">⬇ Download all favorites</button><button id="changeUser">Change account</button></div>`,
    onRender() {
      app.querySelectorAll('[data-chip]').forEach((b) => (b.onclick = () => { listState.chip = b.dataset.chip; draw(); }));
      $('#changeUser').onclick = () => { store.set('ldl_user', null); renderProfileForm(); };
      $('#dlAll').onclick = downloadAllFavorites;
    },
  };
  renderList(state);
}
function renderProfileForm(error) {
  app.innerHTML = `<div class="box">
    <h2>Your favorites</h2>
    <form id="pf">
      <label>Your luscious.net profile link or user ID</label>
      <input name="u" placeholder="https://www.luscious.net/users/123456/" required autocomplete="off">
      <button class="primary" type="submit">Show my favorites</button>
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
      <div class="album-head">
        ${imgTag(album.cover)}
        <div style="min-width:0">
          <h1>${esc(album.title)}</h1>
          <div class="muted small">${album.isManga ? 'Manga · ' : ''}${album.content ? esc(album.content) + ' · ' : ''}${pictures.length} ${album.isManga ? 'pages' : 'files'}${album.author ? ' · ' + esc(album.author) : ''}${album.language ? ' · ' + esc(album.language) : ''}</div>
          ${reason ? `<div class="muted small">⚠ Normally hidden (${esc(reason)})</div>` : ''}
          <div class="row">
            <button class="primary" id="read">${readLabel}</button>
            <button id="dl">⬇ Save</button>
          </div>
          ${prog && prog.page > 0 ? '<button id="restart" class="linkish">Start from page 1</button>' : ''}
        </div>
      </div>
      <div class="row">${tags.map((t) => `<a class="tag" href="#/${album.isManga ? 'manga' : L.contentKind(album) === 'real' ? 'real' : 'hentai'}/${encodeURIComponent(t)}/">${esc(t)}</a>`).join('')}</div>
      <div class="grid thumbs">${pictures.map((p, i) => `<div class="thumb" data-i="${i}">${imgTag(p.thumb)}<span>${i + 1}</span></div>`).join('')}</div>`;
    $('#read').onclick = () => startReading(album, pictures, prog?.page || 0);
    $('#restart')?.addEventListener('click', () => startReading(album, pictures, 0));
    $('#dl').onclick = (e) => { enqueue(album); e.target.textContent = 'Queued'; e.target.disabled = true; };
    app.querySelectorAll('.thumb').forEach((t) => (t.onclick = () => startReading(album, pictures, +t.dataset.i)));
  } catch (e) { showError(e); }
}

async function startReading(album, pictures, start) {
  const saved = dlHistory().find((h) => h.id === album.id && h.status === 'done');
  const local = saved ? await L.localUrls(saved, pictures) : null;
  const pages = pictures.map((p, i) => (local ? { src: local[i], fallback: p.original } : { src: p.original }));
  const p = prefs();
  const prog = progressOf(album.id);
  const mode = prog?.mode || (album.isManga ? p.mangaMode : 'ltr');
  openReader({
    title: album.title, pages, start, mode,
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
function enqueue(album) {
  if (active?.album.id === album.id || queue.some((a) => a.id === album.id)) return;
  queue.push(album);
  runQueue();
  if (location.hash === '#/downloads') renderDownloads();
}
async function runQueue() {
  if (active || !queue.length) return;
  const album = queue.shift();
  active = { album, ctrl: new AbortController(), done: 0, total: 0, failed: 0 };
  showBar();
  let entry;
  try {
    $('#dltext').textContent = `Listing “${album.title}”…`;
    const pictures = albumCache.get(album.id)?.pictures || await L.getAllPictures(album.id);
    active.total = pictures.length;
    const r = await L.saveAlbum(album, pictures, {
      signal: active.ctrl.signal,
      onProgress: (p) => { Object.assign(active, p); showBar(); },
    });
    entry = { id: album.id, title: album.title, folder: r.folder, directory: r.directory, path: r.path, count: pictures.length - r.failed, failed: r.failed, status: r.cancelled ? 'cancelled' : r.failed ? 'partial' : 'done' };
  } catch (e) {
    entry = { id: album.id, title: album.title, status: 'error', error: e.message };
  }
  store.set('ldl_history', [{ ...entry, at: Date.now() }, ...dlHistory().filter((h) => h.id !== album.id)].slice(0, 300));
  active = null;
  if (!queue.length) $('#dlbar').hidden = true;
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
$('#dlcancel').onclick = () => { queue.length = 0; active?.ctrl.abort(); };

function renderDownloads() {
  const h = dlHistory();
  const label = { done: '✓ Saved', partial: '⚠ Some failed', cancelled: 'Cancelled', error: '✕ Failed' };
  app.innerHTML = `<h2>Downloads</h2>
    ${active ? `<p>Downloading <b>${esc(active.album.title)}</b>…</p>` : ''}
    ${queue.length ? `<p class="muted">${queue.length} album(s) waiting</p>` : ''}
    <p class="muted small">Saved in your phone's <b>Pictures/Luscious</b> folder, so they show up in your gallery. Saved manga open offline in the reader. Tap Save again on an album to fill in any missing pictures.</p>
    <div class="list">${h.map((x) => `<div class="item"><a href="#/album/${x.id}">${esc(x.title)}</a>
      <span class="muted nowrap" title="${esc(x.error || x.folder || '')}">${label[x.status] || ''}${x.status === 'done' ? ` (${x.count})` : x.failed ? ` (${x.failed})` : ''}</span></div>`).join('') || '<p class="muted">Nothing downloaded yet.</p>'}</div>
    ${h.length ? '<div class="center"><button id="clearH">Clear list</button></div>' : ''}`;
  $('#clearH')?.addEventListener('click', () => { store.set('ldl_history', []); renderDownloads(); });
}

// ---------- settings ----------
function renderSettings() {
  const p = prefs();
  const rp = readerPrefs();
  const me = store.get('ldl_user', null);
  app.innerHTML = `<h2>Settings</h2>
    <div class="box">
      <h3>Show these (hidden by default)</h3>
      ${Object.entries(HIDE_RULES).map(([k, r]) => `<label class="switch"><input type="checkbox" data-show="${k}" ${p.show[k] ? 'checked' : ''}><span>${r.label}</span></label>`).join('')}
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
    </div>
    <div class="box">
      <h3>Account</h3>
      <p class="muted small">${me ? `Favorites from <b>${esc(me.name)}</b> (user ${esc(me.id)})` : 'No profile set.'}</p>
      <a class="btn" href="#/favorites">${me ? 'Open favorites' : 'Set profile'}</a>
      <button id="clearProgress">Clear reading history</button>
    </div>`;
  $('#fit').value = rp.fit; $('#bg').value = rp.bg;
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
  $('#clearProgress').onclick = (e) => { store.set('ldl_progress', {}); e.target.textContent = 'Cleared'; };
}

// ---------- router ----------
function route() {
  if (readerOpen()) closeReader();
  const [, kind = '', a = '', b = ''] = location.hash.split('/');
  if (SECTIONS[kind]) section = kind;
  const tab = SECTIONS[kind] ? kind : ['favorites', 'downloads', 'settings'].includes(kind) ? kind : kind === 'album' || kind === 'read' ? null : 'hentai';
  if (tab) document.querySelectorAll('nav a').forEach((n) => n.classList.toggle('on', n.dataset.tab === tab));
  window.scrollTo(0, 0);
  if (!SECTIONS[kind]) $('#q').value = '';
  $('#q').placeholder = SECTIONS[section]?.placeholder || '';
  if (kind === 'album') return renderAlbum(decodeURIComponent(a));
  if (kind === 'read') return renderRead(a, +b || 0);
  if (kind === 'favorites') return renderFavorites();
  if (kind === 'downloads') return renderDownloads();
  if (kind === 'settings') return renderSettings();
  renderSection(SECTIONS[kind] ? kind : 'hentai', decodeURIComponent(a), b);
}
window.addEventListener('hashchange', route);
L.getCategories().catch(() => {});
route();
