// "For You": an endless, swipeable feed that learns from ♥ / 👎 (see taste.js).
// Liked images are saved to the "♥ Liked" board (and downloaded for offline use).
import * as L from './api.js';
import * as B from './boorus.js';
import * as T from './taste.js';
import { $, app, esc, store, sheet, toast } from './util.js';
import { postHidden } from './art.js';
import { showSimilar } from './similar.js';
import { addToNamedBoard, removeFromNamedBoard, isInBoard, LIKED_BOARD, pickBoard, addToBoard } from './boards.js';

export const feedPrefs = () => ({ luscious: true, ...store.get('ldl_feed', {}) });

let state = null; // survives tab switches so you come back to the same spot

// ---------- candidates ----------
async function fromArtSites(q, ctx) {
  const sites = B.enabledSites();
  if (!sites.length) return [];
  const page = 1 + Math.floor(Math.random() * (q.explore ? 25 : 8));
  const r = await B.searchAll(sites, q.tag, page, Math.random() < 0.55 ? 'top' : 'new');
  return r.items.filter((x) => !postHidden(x, ctx)).map((x) => {
    const { album, picture } = B.asAlbumPicture(x);
    return { key: x.key, src: x.sample || x.original, fallback: x.original, thumb: x.thumb, tags: [...x.tags, ...x.artists.map((a) => `artist:${a}`)], label: B.SITES[x.site].name, artists: x.artists, album, picture, pageUrl: x.pageUrl };
  });
}
async function fromLuscious(q, ctx) {
  const res = await L.listAlbums({ section: 'hentai', q: q.tag.replace(/_/g, ' '), sort: Math.random() < 0.5 ? 'rating_all_time' : 'date_trending', page: 1 + Math.floor(Math.random() * 5) });
  const albums = res.items.filter((a) => !ctx.hiddenReason(a));
  const picks = [];
  for (const a of albums.sort(() => Math.random() - 0.5).slice(0, 2)) {
    try {
      const pics = (await L.firstPictures(a.id)).filter((p) => !/\.(mp4|webm|gif)(\?|$)/i.test(p.original));
      if (!pics.length) continue;
      const i = Math.floor(Math.random() * pics.length);
      const p = pics[i];
      picks.push({ key: `lus:${p.id}`, src: p.original, fallback: p.large, thumb: p.thumb, tags: [...a.tags, ...a.genres, ...a.audiences, ...(a.author ? [`artist:${a.author}`] : [])], label: 'Luscious', artists: a.author ? [a.author] : [], album: a, picture: p, index: i, albumId: a.id });
    } catch {}
  }
  return picks;
}

async function refill(ctx) {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    const taste = T.loadTaste();
    const seen = new Set(taste.seen);
    const queries = [T.nextQuery(), T.nextQuery()];
    const jobs = queries.map((q) => fromArtSites(q, ctx).catch(() => []));
    if (feedPrefs().luscious && Math.random() < 0.35) jobs.push(fromLuscious(T.nextQuery(), ctx).catch(() => []));
    const found = (await Promise.all(jobs)).flat()
      .filter((c) => !seen.has(c.key) && !state.keys.has(c.key) && !T.disliked(c.tags, taste));
    // Best guesses first, with some randomness so it keeps discovering.
    const ranked = found.map((c) => ({ c, s: T.score(c.tags, taste) + Math.random() * 1.2 })).sort((a, b) => b.s - a.s).map((x) => x.c);
    for (const c of ranked.slice(0, 8)) { state.keys.add(c.key); state.items.push(c); }
    return ranked.length;
  })().finally(() => { state.loading = null; });
  return state.loading;
}

// ---------- screen ----------
export async function renderFeed(ctx) {
  if (!state) state = { items: [], keys: new Set(), cur: 0, reacted: {}, shownAt: 0 };
  app.innerHTML = `<div class="feed">
      <div class="f-top"><a class="f-pill" href="#/boards">‹ Refs</a><b>✨ Discover</b><button id="tasteBtn" class="f-pill">Your taste</button></div>
      <div class="f-scroll"></div>
    </div>`;
  $('#tasteBtn').onclick = () => (location.hash = '#/taste');
  const scroller = app.querySelector('.f-scroll');
  if (!B.enabledSites().length && !feedPrefs().luscious) {
    scroller.innerHTML = '<div class="f-empty">Turn on an art site in ⚙ Settings to fill your feed.</div>';
    return;
  }
  if (state.items.length < 3) {
    scroller.innerHTML = '<div class="f-empty"><div class="spinner"></div><p>Finding things you might like…</p></div>';
    for (let i = 0; i < 3 && state.items.length < 4; i++) await refill(ctx);
    if (!document.body.contains(scroller)) return;
    if (!state.items.length) { scroller.innerHTML = '<div class="f-empty">Couldn’t load images. Check your connection, or open ⚙ Settings → Art sites.<br><button onclick="location.reload()">Retry</button></div>'; return; }
  }
  scroller.innerHTML = state.items.map(cardHtml).join('') + '<div class="f-more"><div class="spinner"></div></div>';
  wire(scroller, ctx);
  const target = scroller.querySelector(`.f-card[data-i="${state.cur}"]`);
  if (target) scroller.scrollTop = target.offsetTop;
}

function cardHtml(c, i) {
  const liked = state.reacted[c.key] === 1;
  return `<section class="f-card ${liked ? 'liked' : ''}" data-i="${i}">
    <img class="f-img" alt="" referrerpolicy="no-referrer" data-src="${esc(c.src)}">
    <div class="f-heart">♥</div>
    <div class="f-actions">
      <button class="f-like" aria-label="Like">♥<span>${liked ? 'Liked' : 'Like'}</span></button>
      <button class="f-dis" aria-label="Show less">👎<span>Less</span></button>
      <button class="f-board" aria-label="Save to board">＋<span>Board</span></button>
      <button class="f-sim" aria-label="More like this">≈<span>Similar</span></button>
      <button class="f-open" aria-label="Study">⤢<span>Study</span></button>
      <button class="f-info" aria-label="Details">⋯<span>More</span></button>
    </div>
    <div class="f-caption">${esc(c.label)}${c.artists?.length ? ` · ${esc(c.artists[0].replace(/_/g, ' '))}` : ''}</div>
  </section>`;
}

function setImages(scroller) {
  // Keep only nearby images in memory (smooth on mid-range phones).
  scroller.querySelectorAll('.f-card').forEach((card) => {
    const i = +card.dataset.i;
    const img = card.querySelector('.f-img');
    const near = i >= state.cur - 2 && i <= state.cur + 3;
    if (near && !img.getAttribute('src')) {
      const c = state.items[i];
      const urls = [c.src, c.fallback, c.thumb].filter(Boolean);
      let k = 0;
      img.onerror = () => { if (++k < urls.length) img.src = urls[k]; };
      img.src = urls[0];
    } else if (!near && Math.abs(i - state.cur) > 8 && img.getAttribute('src')) {
      img.removeAttribute('src');
    }
  });
}

function wire(scroller, ctx) {
  const cards = () => [...scroller.querySelectorAll('.f-card')];
  const appendNew = () => {
    const have = cards().length;
    const html = state.items.slice(have).map((c, k) => cardHtml(c, have + k)).join('');
    scroller.querySelector('.f-more').insertAdjacentHTML('beforebegin', html);
    bindCards(scroller, ctx);
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting || en.intersectionRatio < 0.6) continue;
      const i = +en.target.dataset.i;
      if (i === state.cur && state.shownAt) continue;
      onLeave(state.cur);
      state.cur = i;
      state.shownAt = Date.now();
      T.markSeen(state.items[i].key);
      setImages(scroller);
      if (state.items.length - i < 4) refill(ctx).then(() => { if (document.body.contains(scroller)) appendNew(); });
    }
  }, { root: scroller, threshold: [0.6] });
  scroller._io = io;
  bindCards(scroller, ctx);
  setImages(scroller);
}

// Quiet learning from how long you looked at the image you're leaving.
function onLeave(i) {
  const c = state.items[i];
  if (!c || state.reacted[c.key] || !state.shownAt) return;
  const secs = (Date.now() - state.shownAt) / 1000;
  if (secs >= 6) T.nudge(c.tags, 0.25);
  else if (secs < 1.2) T.nudge(c.tags, -0.12);
}

function bindCards(scroller, ctx) {
  scroller.querySelectorAll('.f-card:not([data-bound])').forEach((card) => {
    card.dataset.bound = '1';
    scroller._io.observe(card);
    const i = +card.dataset.i;
    const c = state.items[i];
    const like = () => {
      const was = state.reacted[c.key];
      if (was === 1) { // undo
        T.unlearn(c.tags, 1);
        delete state.reacted[c.key];
        removeFromNamedBoard(LIKED_BOARD, c.picture.id);
        card.classList.remove('liked');
        card.querySelector('.f-like span').textContent = 'Like';
        return;
      }
      if (was === -1) T.unlearn(c.tags, -1);
      T.learn(c.tags, 1);
      state.reacted[c.key] = 1;
      addToNamedBoard(LIKED_BOARD, c.album, c.picture, c.index || 0, ctx, { tags: T.features(c.tags).slice(0, 40) });
      card.classList.add('liked', 'pop');
      setTimeout(() => card.classList.remove('pop'), 700);
      card.querySelector('.f-like span').textContent = 'Liked';
      navigator.vibrate?.(15);
    };
    const dislike = () => {
      if (state.reacted[c.key] === 1) { T.unlearn(c.tags, 1); removeFromNamedBoard(LIKED_BOARD, c.picture.id); }
      if (state.reacted[c.key] !== -1) T.learn(c.tags, -1);
      state.reacted[c.key] = -1;
      card.classList.add('gone');
      toast('Got it – less like this');
      setTimeout(() => scroller.scrollBy({ top: scroller.clientHeight, behavior: 'smooth' }), 250);
    };
    card.querySelector('.f-like').onclick = like;
    card.querySelector('.f-dis').onclick = dislike;
    card.querySelector('.f-board').onclick = async () => { const n = await addToBoard(c.album, c.picture, c.index || 0, ctx); if (n) toast(`Saved to ${n}`); };
    card.querySelector('.f-sim').onclick = () => showSimilar(c);
    card.querySelector('.f-open').onclick = () => ctx.openReader({
      title: c.label, pages: [{ src: c.src, fallback: c.fallback }], start: 0, mode: 'ltr',
      onAddToBoard: () => addToBoard(c.album, c.picture, c.index || 0, ctx),
      onSimilar: () => showSimilar(c),
    });
    card.querySelector('.f-info').onclick = () => infoSheet(c);
    // Double-tap the image to like.
    let last = 0;
    card.querySelector('.f-img').addEventListener('click', () => {
      const now = Date.now();
      if (now - last < 300) { if (state.reacted[c.key] !== 1) like(); last = 0; } else last = now;
    });
  });
}

function infoSheet(c) {
  const f = T.features(c.tags).filter((t) => !t.startsWith('artist:')).slice(0, 40);
  sheet(`<h3>${esc(c.label)}${c.artists?.length ? ` · ${esc(c.artists.join(', ').replace(/_/g, ' '))}` : ''}</h3>
    ${c.albumId ? `<a class="opt btn" href="#/album/${c.albumId}">Open the album</a>` : ''}
    ${c.pageUrl ? `<a class="opt btn" href="${esc(c.pageUrl)}" target="_blank" rel="noopener">Open post on ${esc(c.label)}</a>` : ''}
    <button class="opt" data-sim="1">≈ More like this</button>
    <p class="muted small">Tap a tag to tune your feed:</p>
    <div class="chips wrap">${f.map((t) => `<button data-t="${esc(t)}">${esc(t.replace(/_/g, ' '))}</button>`).join('')}</div>`, (el, close) => {
    el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { close(); tagSheet(b.dataset.t); }));
    el.querySelector('[data-sim]').onclick = () => { close(); showSimilar(c); };
  });
}

export function tagSheet(tag) {
  const label = tag.replace(/_/g, ' ');
  return sheet(`<h3>${esc(label)}</h3>
    <button class="opt" data-a="more">👍 Show more of this</button>
    <button class="opt" data-a="less">👎 Show less of this</button>
    <button class="opt" data-a="never" style="color:#ff7b9c">🚫 Never show this</button>
    <button class="opt" data-a="forget">Forget what you learned about it</button>`, (el, close) => {
    el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'more') { T.bump(tag, 2); toast(`More “${label}”`); }
      if (a === 'less') { T.bump(tag, -2); toast(`Less “${label}”`); }
      if (a === 'forget') { T.forget(tag); toast('Forgotten'); }
      if (a === 'never') {
        const p = { show: {}, hideTags: [], ...store.get('ldl_prefs', {}) };
        p.hideTags = [...new Set([...(p.hideTags || []), label])];
        store.set('ldl_prefs', p);
        T.bump(tag, -10);
        toast(`“${label}” will never be shown`);
      }
      close(a);
    }));
  });
}

// ---------- "Your taste" screen ----------
export function renderTaste(ctx) {
  const t = T.loadTaste();
  const { liked, disliked } = T.topTags(30);
  const chips = (list) => list.map(([tag, v]) => `<button data-t="${esc(tag)}" class="tchip" style="--w:${Math.min(1, Math.abs(v) / 6)}">${esc(tag.replace(/^artist:/, '🎨 ').replace(/_/g, ' '))}</button>`).join('');
  app.innerHTML = `<div class="page-head"><a class="back" href="#/feed">‹</a><h2>Your taste</h2></div>
    <div class="box">
      <p class="small">${t.likes} like${t.likes === 1 ? '' : 's'} · ${t.dislikes} dislike${t.dislikes === 1 ? '' : 's'}. The more you react, the better For You gets.</p>
      <a class="btn" href="#/board-liked">Open ♥ Liked</a>
    </div>
    <div class="box"><h3>You like</h3>${liked.length ? `<div class="chips wrap">${chips(liked)}</div>` : '<p class="muted small">Nothing yet – tap ♥ on images you like.</p>'}</div>
    <div class="box"><h3>Less of</h3>${disliked.length ? `<div class="chips wrap neg">${chips(disliked)}</div>` : '<p class="muted small">Nothing yet – tap 👎 on images you don’t want.</p>'}</div>
    <div class="box"><h3>Feed sources</h3>
      <label class="switch"><input type="checkbox" id="fLus" ${feedPrefs().luscious ? 'checked' : ''}><span>Include luscious albums</span></label>
      <p class="muted small">Art sites are set in ⚙ Settings → Art sites.</p>
      <button id="resetTaste">Reset what For You has learned</button>
    </div>`;
  app.querySelectorAll('[data-t]').forEach((b) => (b.onclick = async () => { await tagSheet(b.dataset.t); renderTaste(ctx); }));
  $('#fLus').onchange = (e) => store.set('ldl_feed', { ...feedPrefs(), luscious: e.target.checked });
  $('#resetTaste').onclick = () => {
    if (!confirm('Forget everything For You has learned? (Your ♥ Liked board stays.)')) return;
    T.resetTaste();
    state = null;
    renderTaste(ctx);
  };
}
// Clear cached feed (e.g. after settings changes).
export const resetFeed = () => { state = null; };
