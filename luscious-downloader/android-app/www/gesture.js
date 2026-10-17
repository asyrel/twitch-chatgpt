// Gesture drawing practice: timed random references from a board, a section, or favorites.
import * as L from './api.js';
import * as N from './native.js';
import { $, app, esc, store, imgTag, shuffle, toast } from './util.js';
import { loadBoards, boardItems, pagesFor, addToBoard } from './boards.js';
import * as B from './boorus.js';
import { postHidden } from './art.js';

const DURATIONS = [30, 45, 60, 120, 300, 600];
const COUNTS = [5, 10, 20, 30, 0]; // 0 = no limit
const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`);

export function renderPractice(ctx, preset = {}) {
  const d = loadBoards();
  const opts = { source: preset.source || 'section:hentai', seconds: 60, count: 10, flip: false, gray: false, grid: false, ...store.get('ldl_practice', {}), ...preset };
  if (preset.source) opts.source = preset.source;
  const sources = [
    ...d.boards.filter((b) => boardItems(b.id, d).length).map((b) => [`board:${b.id}`, `Board: ${b.name} (${boardItems(b.id, d).length})`]),
    ['section:hentai', 'Random pages – Hentai'],
    ['art', 'Random art – art sites (optional tag below)'],
    ['section:manga', 'Random pages – Manga'],
    ...(store.get('ldl_user', null) ? [['favorites', 'Random pages – My favorites']] : []),
  ];
  if (!sources.some(([k]) => k === opts.source)) opts.source = sources[0][0];
  app.innerHTML = `${ctx.libraryNav('boards')}
    <div class="box">
      <h3>✏️ Gesture drawing practice</h3>
      <label>Images from</label>
      <select id="gSource">${sources.map(([k, v]) => `<option value="${k}" ${k === opts.source ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <div id="gTagWrap" ${opts.source === 'art' ? '' : 'hidden'}><label>Tag (optional), e.g. <i>sitting</i>, <i>from_behind</i>, <i>hand_focus</i></label><input id="gTag" value="${esc(opts.tag || '')}" autocapitalize="none" autocomplete="off"></div>
      <label>Time per image</label>
      <div class="chips wrap">${DURATIONS.map((s) => `<button data-sec="${s}" class="${opts.seconds === s ? 'on' : ''}">${fmt(s)}</button>`).join('')}</div>
      <label style="margin-top:10px">Number of images</label>
      <div class="chips wrap">${COUNTS.map((c) => `<button data-cnt="${c}" class="${opts.count === c ? 'on' : ''}">${c || '∞'}</button>`).join('')}</div>
      <label class="switch"><input type="checkbox" id="gFlip" ${opts.flip ? 'checked' : ''}><span>Randomly mirror images</span></label>
      <label class="switch"><input type="checkbox" id="gGray" ${opts.gray ? 'checked' : ''}><span>Grayscale</span></label>
      <label class="switch"><input type="checkbox" id="gGrid" ${opts.grid ? 'checked' : ''}><span>Show 3×3 grid</span></label>
      <button class="primary" id="gStart">Start · ${opts.count ? `${opts.count} × ${fmt(opts.seconds)} = ${fmt(opts.count * opts.seconds)}` : `${fmt(opts.seconds)} each`}</button>
    </div>
    <p class="muted small">Tip: 30s–1m for quick gestures, 2–5m for proportions, 10m for longer studies. Volume keys skip, the screen stays on.</p>`;
  const save = () => store.set('ldl_practice', { seconds: opts.seconds, count: opts.count, flip: opts.flip, gray: opts.gray, grid: opts.grid, tag: opts.tag });
  const rerender = () => { save(); renderPractice(ctx, { ...opts }); };
  app.querySelectorAll('[data-sec]').forEach((b) => (b.onclick = () => { opts.seconds = +b.dataset.sec; rerender(); }));
  app.querySelectorAll('[data-cnt]').forEach((b) => (b.onclick = () => { opts.count = +b.dataset.cnt; rerender(); }));
  $('#gSource').onchange = (e) => { opts.source = e.target.value; $('#gTagWrap').hidden = opts.source !== 'art'; };
  $('#gTag').onchange = (e) => { opts.tag = e.target.value.trim(); };
  $('#gFlip').onchange = (e) => { opts.flip = e.target.checked; save(); };
  $('#gGray').onchange = (e) => { opts.gray = e.target.checked; save(); };
  $('#gGrid').onchange = (e) => { opts.grid = e.target.checked; save(); };
  $('#gStart').onclick = () => { save(); startSession(opts, ctx); };
}

// ---------- image sources ----------
function boardSource(boardId) {
  let queue = [];
  return async () => {
    if (!queue.length) {
      const items = shuffle(boardItems(boardId));
      if (!items.length) return null;
      const pages = await pagesFor(items);
      queue = items.map((it, i) => ({ ...pages[i], title: it.albumTitle, albumId: it.albumId, picture: { id: it.pictureId, original: it.original, large: it.large, thumb: it.thumb }, album: { id: it.albumId, title: it.albumTitle, author: it.author, authorId: it.authorId }, index: it.page }));
    }
    return queue.shift();
  };
}

// Random page from a random album of a list (keeps the user's hidden-content filters).
function listSource(fetchPage, ctx) {
  let maxPage = 20;
  const recent = new Set();
  return async () => {
    for (let tries = 0; tries < 8; tries++) {
      const page = 1 + Math.floor(Math.random() * maxPage);
      const res = await fetchPage(page);
      if (!res.items.length) { maxPage = Math.max(1, page - 1); continue; }
      if (res.info?.total_pages) maxPage = Math.min(maxPage, res.info.total_pages);
      const albums = res.items.filter((a) => !ctx.hiddenReason(a) && !recent.has(a.id));
      if (!albums.length) continue;
      const album = albums[Math.floor(Math.random() * albums.length)];
      const pics = (await L.getAllPictures(album.id)).filter((p) => !/\.(mp4|webm|gif)(\?|$)/i.test(p.original));
      if (!pics.length) continue;
      recent.add(album.id);
      const index = Math.floor(Math.random() * pics.length);
      const p = pics[index];
      return { src: p.original, fallback: p.large, title: album.title, albumId: album.id, picture: p, album, index };
    }
    return null;
  };
}

// Random top-rated art from the image boards, optionally for one tag.
function artSource(tag, ctx) {
  let maxPage = 30;
  let pool = [];
  const seen = new Set();
  return async () => {
    for (let tries = 0; tries < 6 && !pool.length; tries++) {
      const page = 1 + Math.floor(Math.random() * maxPage);
      const r = await B.searchAll(B.enabledSites(), B.booruTag(tag || ''), page, 'top');
      if (!r.items.length) { maxPage = Math.max(1, Math.floor(page / 2)); continue; }
      pool = shuffle(r.items.filter((x) => !postHidden(x, ctx) && !seen.has(x.key)));
    }
    const x = pool.shift();
    if (!x) return null;
    seen.add(x.key);
    const { album, picture } = B.asAlbumPicture(x);
    return { src: x.sample || x.original, fallback: x.original, title: album.title, albumId: null, picture, album, index: 0 };
  };
}

function makeSource(source, ctx, opts = {}) {
  if (source === 'art') return artSource(opts.tag, ctx);
  if (source.startsWith('board:')) return boardSource(source.slice(6));
  if (source === 'favorites') {
    const me = store.get('ldl_user', null);
    return listSource((page) => L.favoriteAlbums(me.id, page), ctx);
  }
  const sec = source.split(':')[1] || 'hentai';
  return listSource((page) => L.listAlbums({ section: sec, sort: 'rating_all_time', page }), ctx);
}

// ---------- session ----------
function startSession(opts, ctx) {
  const next = makeSource(opts.source, ctx, opts);
  const shown = [];
  let cur = null, left = opts.seconds, paused = false, timer = null, upcoming = null, n = 0, ended = false;

  const root = document.createElement('div');
  root.className = `gesture${opts.gray ? ' gray' : ''}${opts.grid ? ' grid' : ''}`;
  root.innerHTML = `
    <div class="g-stage"><div class="g-view"><img class="g-img" alt="" referrerpolicy="no-referrer"><div class="g-grid"></div></div><div class="g-msg"><div class="spinner"></div></div></div>
    <div class="g-bar"><div></div></div>
    <div class="g-top"><span class="g-count"></span><span class="g-time"></span></div>
    <div class="g-controls">
      <button data-g="end">✕</button><button data-g="pause">⏸</button><button data-g="skip">⏭</button><button data-g="board">＋</button>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('reading');
  const img = root.querySelector('.g-img');
  N.setReading(true, { keepAwake: true, volumeKeys: true, fullscreen: true });
  N.onVolumeKey(() => advance());
  history.pushState({ gesture: 1 }, '');
  const onPop = () => finish();
  window.addEventListener('popstate', onPop);

  const fetchNext = () => (upcoming = next().catch(() => null));
  const setTime = () => {
    root.querySelector('.g-time').textContent = fmt(Math.max(0, left));
    root.querySelector('.g-bar div').style.width = `${(left / opts.seconds) * 100}%`;
    root.classList.toggle('ending', left <= 5);
  };
  async function show() {
    if (opts.count && n >= opts.count) return finish();
    root.querySelector('.g-msg').hidden = false;
    img.style.visibility = 'hidden';
    const item = await (upcoming || fetchNext());
    if (ended) return;
    if (!item) { toast("Couldn't find more images"); return finish(); }
    fetchNext(); // preload the next one while drawing
    cur = item;
    n++;
    const urls = [item.src, item.fallback, item.fallback2].filter(Boolean);
    let k = 0;
    img.onerror = () => { if (++k < urls.length) img.src = urls[k]; else advance(); };
    img.onload = () => { root.querySelector('.g-msg').hidden = true; img.style.visibility = 'visible'; };
    img.src = urls[0];
    root.querySelector('.g-view').classList.toggle('mirror', opts.flip && Math.random() < 0.5);
    root.querySelector('.g-count').textContent = opts.count ? `${n} / ${opts.count}` : `#${n}`;
    left = opts.seconds;
    shown.push({ ...item, started: Date.now() });
    setTime();
    if (item.src && upcoming) upcoming.then((u) => { if (u?.src) { const p = new Image(); p.referrerPolicy = 'no-referrer'; p.src = u.src; } });
  }
  function advance() {
    if (ended) return;
    if (shown.length) shown[shown.length - 1].spent = Math.round((Date.now() - shown[shown.length - 1].started) / 1000);
    navigator.vibrate?.(60);
    show();
  }
  timer = setInterval(() => {
    if (paused || ended || !cur || img.style.visibility === 'hidden') return;
    left--;
    setTime();
    if (left <= 0) advance();
  }, 1000);

  root.querySelectorAll('[data-g]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const a = b.dataset.g;
    if (a === 'end') history.back();
    if (a === 'skip') advance();
    if (a === 'pause') { paused = !paused; b.textContent = paused ? '▶' : '⏸'; root.classList.toggle('paused', paused); }
    if (a === 'board' && cur) {
      const wasPaused = paused; paused = true;
      const name = await addToBoard(cur.album, cur.picture, cur.index || 0, ctx);
      paused = wasPaused;
      if (name) toast(`Saved to ${name}`);
    }
  }));
  root.querySelector('.g-stage').onclick = () => root.classList.toggle('hide-ui');

  function finish() {
    if (ended) return;
    ended = true;
    if (shown.length && !shown[shown.length - 1].spent) shown[shown.length - 1].spent = Math.round((Date.now() - shown[shown.length - 1].started) / 1000);
    clearInterval(timer);
    window.removeEventListener('popstate', onPop);
    N.onVolumeKey(null);
    N.setReading(false);
    root.remove();
    document.body.classList.remove('reading');
    if (history.state?.gesture) history.back();
    summary(shown, opts, ctx);
  }
  fetchNext();
  show();
}

function summary(shown, opts, ctx) {
  const total = shown.reduce((s, x) => s + (x.spent || 0), 0);
  app.innerHTML = `${ctx.libraryNav('boards')}
    <div class="box"><h3>Session done 🎉</h3>
      <p class="small">${shown.length} image${shown.length === 1 ? '' : 's'} · ${fmt(total)} of drawing</p>
      <div class="row"><button class="primary" id="again">Go again</button><a class="btn" href="#/practice">Change settings</a></div>
    </div>
    <div class="grid thumbs">${shown.map((s) => `<a class="thumb" href="${s.albumId ? `#/album/${s.albumId}` : 'javascript:void(0)'}">${imgTag(s.picture?.thumb || s.src)}<span>${fmt(s.spent || 0)}</span></a>`).join('')}</div>`;
  $('#again').onclick = () => startSession(opts, ctx);
}
