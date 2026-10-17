// Reference finder: pick a body part, clothing item, pose, angle or expression and browse matching images.
import * as L from './api.js';
import { $, app, esc, store, imgTag, toast } from './util.js';
import { addToBoard } from './boards.js';

// label -> luscious search term
export const REF_GROUPS = {
  Body: { Hands: 'hands', Feet: 'feet', Legs: 'legs', Thighs: 'thighs', Hips: 'hips', Butt: 'ass', Back: 'back', Chest: 'breasts', Abs: 'abs', Muscles: 'muscular', Face: 'face', Eyes: 'eyes', Lips: 'lips', Hair: 'long hair', 'Neck & shoulders': 'shoulders' },
  Clothing: { Lingerie: 'lingerie', Stockings: 'stockings', Pantyhose: 'pantyhose', Bikini: 'bikini', Swimsuit: 'swimsuit', 'School uniform': 'school uniform', Maid: 'maid', Kimono: 'kimono', Bodysuit: 'bodysuit', 'Latex / leather': 'latex', Dress: 'dress', Skirt: 'skirt', Heels: 'high heels', Gloves: 'gloves', Glasses: 'glasses', Cosplay: 'cosplay' },
  Poses: { Standing: 'standing', Sitting: 'sitting', Kneeling: 'kneeling', Lying: 'lying', 'Bent over': 'bent over', Squatting: 'squatting', 'All fours': 'all fours', Stretching: 'stretching', 'From behind': 'from behind', 'Legs up': 'legs up', Spread: 'spread legs', Action: 'dynamic pose', Couple: 'couple' },
  Angles: { 'From above': 'from above', 'From below': 'from below', 'Side view': 'side view', 'Close-up': 'close-up', 'Full body': 'full body', POV: 'pov', 'Mirror / selfie': 'selfie' },
  Expressions: { Smile: 'smile', Blush: 'blush', Shy: 'shy', Wink: 'wink', 'Tongue out': 'tongue out', Crying: 'crying', Angry: 'angry', Ahegao: 'ahegao' },
  'Light & mood': { Dark: 'dark', Sunlight: 'sunlight', 'Wet skin': 'wet', Oiled: 'oiled', Monochrome: 'monochrome', Silhouette: 'silhouette' },
};

export function renderRefs(ctx) {
  const sec = store.get('ldl_ref_sec', 'hentai');
  const recent = store.get('ldl_ref_recent', []);
  app.innerHTML = `${ctx.libraryNav('refs')}
    <div class="chips" style="margin-bottom:10px">${['hentai', 'real'].map((s) => `<button data-sec="${s}" class="${s === sec ? 'on' : ''}">${s === 'hentai' ? 'Hentai / drawn' : 'Real'}</button>`).join('')}</div>
    <form id="refQ" class="row" style="margin-top:0"><input name="q" placeholder="Find refs for… (e.g. hands holding, side braid)" autocomplete="off" style="flex:1"><button class="primary">Find</button></form>
    ${recent.length ? `<h3 class="refh">Recent</h3><div class="chips wrap">${recent.map((t) => `<a class="chip" href="#/refs/${sec}/${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : ''}
    ${Object.entries(REF_GROUPS).map(([g, items]) => `<h3 class="refh">${esc(g)}</h3>
      <div class="chips wrap">${Object.entries(items).map(([label, term]) => `<a class="chip" href="#/refs/${sec}/${encodeURIComponent(term)}/${encodeURIComponent(label)}">${esc(label)}</a>`).join('')}</div>`).join('')}`;
  app.querySelectorAll('[data-sec]').forEach((b) => (b.onclick = () => { store.set('ldl_ref_sec', b.dataset.sec); renderRefs(ctx); }));
  $('#refQ').onsubmit = (e) => {
    e.preventDefault();
    const q = String(new FormData(e.target).get('q')).trim();
    if (q) location.hash = `#/refs/${sec}/${encodeURIComponent(q)}`;
  };
}

function remember(term) {
  const r = [term, ...store.get('ldl_ref_recent', []).filter((t) => t !== term)].slice(0, 10);
  store.set('ldl_ref_recent', r);
}
// Hide pictures whose own tags hit the user's hidden categories.
const pictureHidden = (p, ctx) => !!ctx.hiddenReason({ audiences: [], genres: [], tags: p.tags || [] });

export async function renderRefResults(sec, term, label, ctx) {
  remember(label || term);
  const title = esc(label || term);
  const head = `${ctx.libraryNav('refs')}<div class="row" style="margin-top:0;justify-content:space-between"><h2 style="margin:0">🔎 ${title}</h2><a class="btn" href="#/refs">All categories</a></div>`;
  app.innerHTML = head + '<div class="center"><div class="spinner"></div></div>';
  let pics = null;
  try { pics = await L.searchPictures(term, 1); } catch { pics = null; }
  if (pics && pics.items.length) return pictureGrid(sec, term, title, head, pics, ctx);
  return albumStrips(sec, term, head, ctx);
}

// Mode 1: luscious can search single pictures -> one grid of matching images.
function pictureGrid(sec, term, title, head, first, ctx) {
  const items = [];
  let page = 1, hasNext = true;
  const add = (res) => {
    for (const p of res.items) if (!p.animated && !pictureHidden(p, ctx) && !items.some((x) => x.id === p.id)) items.push(p);
    hasNext = !!res.info?.has_next_page && res.items.length > 0;
  };
  add(first);
  const draw = () => {
    app.innerHTML = `${head}<p class="muted small">Single images tagged “${title}”. Tap to study, then ＋ Board to keep it.</p>
      <div class="grid thumbs">${items.map((p, i) => `<div class="thumb" data-i="${i}">${imgTag(p.thumb)}</div>`).join('')}</div>
      ${hasNext ? '<div class="center"><button id="moreR">Load more</button></div>' : ''}`;
    app.querySelectorAll('.thumb').forEach((t) => (t.onclick = () => openPics(items, +t.dataset.i, title, ctx)));
    $('#moreR')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Loading…';
      try { add(await L.searchPictures(term, ++page)); draw(); } catch (err) { e.target.textContent = err.message; }
    });
  };
  draw();
}

function openPics(items, start, title, ctx) {
  ctx.openReader({
    title: `Refs: ${title}`, start, mode: 'ltr',
    pages: items.map((p) => ({ src: p.original, fallback: p.large })),
    onAddToBoard: (i) => {
      const p = items[i];
      return addToBoard(p.album || { id: 'refs', title: `Refs: ${title}` }, p, 0, ctx);
    },
  });
}

// Mode 2: only album search works -> albums matching the term, each with a strip of its pages.
async function albumStrips(sec, term, head, ctx) {
  const rows = [];
  let page = 0, hasNext = true;
  const loadMore = async () => {
    let added = 0;
    while (hasNext && added < 8) {
      const res = await L.listAlbums({ section: sec, q: term, sort: 'rating_all_time', page: ++page });
      hasNext = !!res.info?.has_next_page && res.items.length > 0;
      for (const a of res.items) if (!ctx.hiddenReason(a) && !rows.some((r) => r.album.id === a.id)) { rows.push({ album: a, pics: null }); added++; }
      if (page > 6) break;
    }
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); fillStrip(+en.target.dataset.r); }
  }, { rootMargin: '300px 0px' });
  async function fillStrip(r) {
    const row = rows[r];
    const el = app.querySelector(`.strip[data-r="${r}"]`);
    if (!row || !el) return;
    try {
      row.pics = row.pics || (await L.firstPictures(row.album.id)).filter((p) => !/\.(mp4|webm)(\?|$)/i.test(p.original));
      el.innerHTML = row.pics.slice(0, 16).map((p, i) => `<div class="sthumb" data-i="${i}">${imgTag(p.thumb)}</div>`).join('') || '<span class="muted small">No pages</span>';
      el.querySelectorAll('.sthumb').forEach((t) => (t.onclick = () => openAlbumAt(row, +t.dataset.i, ctx)));
    } catch { el.innerHTML = '<span class="muted small">Couldn’t load pages</span>'; }
  }
  const draw = () => {
    io.disconnect();
    app.innerHTML = `${head}<p class="muted small">Albums tagged “${esc(term)}”, with their pages. Tap a page to study it, then ＋ Board to keep it.</p>
      ${rows.map((row, r) => `<div class="refrow">
        <a class="refrow-t" href="#/album/${row.album.id}">${esc(row.album.title)} <span class="muted small">· ${row.album.pictures} pages ›</span></a>
        <div class="strip" data-r="${r}">${row.pics ? '' : '<div class="spinner"></div>'}</div></div>`).join('') || '<p class="muted">Nothing found. Try another word.</p>'}
      ${hasNext ? '<div class="center"><button id="moreR">Load more</button></div>' : ''}`;
    app.querySelectorAll('.strip').forEach((s) => { if (rows[+s.dataset.r].pics) fillStrip(+s.dataset.r); else io.observe(s); });
    $('#moreR')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Loading…';
      try { await loadMore(); draw(); } catch (err) { e.target.textContent = err.message; }
    });
  };
  try { await loadMore(); } catch (e) { return ctx.showError(e); }
  draw();
}

function openAlbumAt(row, i, ctx) {
  ctx.openReader({
    title: row.album.title, start: i, mode: 'ltr',
    pages: row.pics.map((p) => ({ src: p.original, fallback: p.large })),
    onAddToBoard: (k) => addToBoard(row.album, row.pics[k], k, ctx),
  });
}
