import * as L from './api.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const loading = () => (app.innerHTML = '<div class="center"><div class="spinner"></div></div>');
const showError = (e) => (app.innerHTML = `<div class="err">${esc(e.message || e)}</div>`);

// Images load directly; if the site refuses, retry through native HTTP.
const imgTag = (url, cls = '') => url ? `<img class="${cls}" loading="lazy" referrerpolicy="no-referrer" src="${esc(url)}" data-src="${esc(url)}" alt="">` : '<img alt="">';
document.addEventListener('error', async (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.src || img.dataset.retried) return;
  img.dataset.retried = '1';
  try { img.src = await L.imageDataUrl(img.dataset.src); } catch {}
}, true);

// ---------- search ----------
$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#q').value.trim();
  $('#q').blur();
  if (L.looksLikeAlbum(v)) location.hash = '#/album/' + encodeURIComponent(v);
  else location.hash = '#/search/' + encodeURIComponent(v) + '/' + ($('#sort').value || '');
});
$('#sort').addEventListener('change', () => $('#search').requestSubmit());

let listState = null;
async function renderList(state) {
  listState = { page: 1, items: [], hasNext: false, ...state };
  loading();
  try { await loadPage(); } catch (e) { showError(e); }
}
async function loadPage() {
  const s = listState;
  const res = s.userId ? await L.favoriteAlbums(s.userId, s.page) : await L.searchAlbums(s.q, s.page, s.sort);
  if (s !== listState) return;
  s.items.push(...res.items);
  s.hasNext = !!res.info?.has_next_page;
  const total = res.info?.total_items != null ? ` <span class="muted">(${res.info.total_items})</span>` : '';
  app.innerHTML = (s.header || '') + `<h2>${s.title}${total}</h2>` +
    (s.items.length ? `<div class="grid">${s.items.map(card).join('')}</div>` : `<p class="muted">${s.empty || 'No albums found.'}</p>`) +
    (s.hasNext ? '<div class="center"><button id="more">Load more</button></div>' : '');
  s.onRender?.();
  $('#more')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Loading…';
    s.page++;
    try { await loadPage(); } catch (err) { e.target.textContent = err.message; }
  });
}
function card(a) {
  return `<a class="card" href="#/album/${a.id}" style="color:inherit;text-decoration:none">
    ${imgTag(a.cover)}
    <div class="t">${esc(a.title)}</div>
    <div class="n">${a.pictures} pics${a.animated ? ` · ${a.animated} gif` : ''}</div>
  </a>`;
}

// ---------- favorites ----------
function renderFavorites() {
  const me = store.get('ldl_user', null);
  if (!me) return renderProfileForm();
  renderList({
    userId: me.id,
    title: `♥ ${esc(me.name)}'s favorites`,
    empty: 'No favorites yet.',
    header: `<div class="row" style="margin-top:0"><button id="dlAll">⬇ Download all favorites</button><button id="changeUser">Change account</button></div>`,
    onRender() {
      $('#changeUser').onclick = () => { store.set('ldl_user', null); renderProfileForm(); };
      $('#dlAll').onclick = downloadAllFavorites;
    },
  });
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
    <p class="muted" style="font-size:13px">No password needed. On luscious.net, open your profile and copy the link (it has a number in it, like <b>/users/123456/</b>).</p>
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
      all.push(...r.items);
      if (!r.info?.has_next_page || !r.items.length) break;
    }
    all.forEach(enqueue);
    e.target.textContent = `Queued ${all.length} albums`;
  } catch (err) { e.target.textContent = err.message; e.target.disabled = false; }
}

// ---------- album ----------
let current = null;
async function renderAlbum(ref) {
  const id = L.parseAlbumId(ref);
  if (!id) return showError("That doesn't look like a luscious.net album link.");
  loading();
  try {
    const [album, pictures] = await Promise.all([L.getAlbum(id), L.getAllPictures(id)]);
    current = { album, pictures };
    const tags = [...album.genres, ...album.tags].slice(0, 24);
    app.innerHTML = `
      <div class="album-head">
        ${imgTag(album.cover)}
        <div style="min-width:0">
          <h1>${esc(album.title)}</h1>
          <div class="muted" style="font-size:13px">${pictures.length} files${album.author ? ' · ' + esc(album.author) : ''}${album.language ? ' · ' + esc(album.language) : ''}</div>
          <div class="row"><button class="primary" id="dl">⬇ Save to phone</button></div>
        </div>
      </div>
      <div class="row">${tags.map((t) => `<a class="tag" href="#/search/${encodeURIComponent(t)}/" style="text-decoration:none">${esc(t)}</a>`).join('')}</div>
      <div class="grid">${pictures.map((p, i) => `<div class="thumb" data-i="${i}">${imgTag(p.thumb)}<span>${i + 1}</span></div>`).join('')}</div>`;
    $('#dl').onclick = (e) => { enqueue(album); e.target.textContent = 'Added to downloads'; e.target.disabled = true; };
    app.querySelectorAll('.thumb').forEach((t) => (t.onclick = () => openViewer(+t.dataset.i)));
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
    const pictures = current?.album.id === album.id ? current.pictures : await L.getAllPictures(album.id);
    active.total = pictures.length;
    const r = await L.saveAlbum(album, pictures, {
      signal: active.ctrl.signal,
      onProgress: (p) => { Object.assign(active, p); showBar(); },
    });
    entry = { id: album.id, title: album.title, folder: r.folder, count: pictures.length - r.failed, failed: r.failed, status: r.cancelled ? 'cancelled' : r.failed ? 'partial' : 'done' };
  } catch (e) {
    entry = { id: album.id, title: album.title, status: 'error', error: e.message };
  }
  store.set('ldl_history', [{ ...entry, at: Date.now() }, ...dlHistory().filter((h) => h.id !== album.id)].slice(0, 200));
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
    <p class="muted" style="font-size:13px">Albums are saved in your phone's <b>Pictures/Luscious</b> folder, so they show up in your gallery app. Tap Save again on an album to fill in any missing pictures.</p>
    <div class="list">${h.map((x) => `<div class="item"><a href="#/album/${x.id}" style="color:inherit">${esc(x.title)}</a>
      <span class="muted" style="white-space:nowrap" title="${esc(x.error || x.folder || '')}">${label[x.status] || ''}${x.status === 'done' ? ` (${x.count})` : x.failed ? ` (${x.failed})` : ''}</span></div>`).join('') || '<p class="muted">Nothing downloaded yet.</p>'}</div>
    ${h.length ? '<div class="center"><button id="clearH">Clear list</button></div>' : ''}`;
  $('#clearH')?.addEventListener('click', () => { store.set('ldl_history', []); renderDownloads(); });
}

// ---------- viewer ----------
let vi = 0;
function openViewer(i) { vi = i; $('#viewer').classList.add('open'); showPic(); window.history.pushState({ viewer: 1 }, ''); }
function closeViewer() { $('#viewer').classList.remove('open'); $('#vmedia').innerHTML = ''; }
function step(d) { const n = current.pictures.length; vi = (vi + d + n) % n; showPic(); }
function showPic() {
  const p = current.pictures[vi];
  $('#vmedia').innerHTML = /\.(mp4|webm)(\?|$)/i.test(p.original)
    ? `<video src="${esc(p.original)}" controls autoplay loop playsinline></video>` : imgTag(p.original);
  $('#vcount').textContent = `${vi + 1} / ${current.pictures.length}`;
  const nxt = current.pictures[(vi + 1) % current.pictures.length];
  if (nxt) { const im = new Image(); im.referrerPolicy = 'no-referrer'; im.src = nxt.original; }
}
$('#vclose').onclick = () => window.history.back();
document.querySelectorAll('#viewer .nav').forEach((b) => (b.onclick = () => step(+b.dataset.step)));
let tx = null;
$('#viewer').addEventListener('touchstart', (e) => (tx = e.touches[0].clientX), { passive: true });
$('#viewer').addEventListener('touchend', (e) => {
  if (tx == null) return;
  const dx = e.changedTouches[0].clientX - tx; tx = null;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
});
// Android back button closes the viewer first.
window.addEventListener('popstate', () => { if ($('#viewer').classList.contains('open')) closeViewer(); });

// ---------- router ----------
function route() {
  if ($('#viewer').classList.contains('open')) closeViewer();
  const [, kind = '', a = '', b = ''] = location.hash.split('/');
  const tab = kind === 'favorites' ? 'favorites' : kind === 'downloads' ? 'downloads' : 'home';
  document.querySelectorAll('nav a').forEach((n) => n.classList.toggle('on', n.dataset.tab === tab));
  window.scrollTo(0, 0);
  if (kind !== 'search' && kind !== '') $('#q').value = '';
  if (kind === 'album') return renderAlbum(decodeURIComponent(a));
  if (kind === 'favorites') return renderFavorites();
  if (kind === 'downloads') return renderDownloads();
  const q = decodeURIComponent(a);
  $('#q').value = q; $('#sort').value = b;
  renderList({ q, sort: b, title: q ? `Results for “${esc(q)}”` : 'Trending albums' });
}
window.addEventListener('hashchange', route);
route();
