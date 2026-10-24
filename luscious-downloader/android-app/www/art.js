// Art tab: browse/search anime & hentai art across image boards (Danbooru, Gelbooru, Yande.re, Konachan).
import * as B from './boorus.js';
import { $, app, esc, store, imgTag } from './util.js';
import { addToBoard } from './boards.js';
import { showSimilar } from './similar.js';

// Hidden-category / blocked / real-photo check on a post's tags.
export const postHidden = (x, ctx) => !!ctx.hiddenReason({ audiences: [], genres: [], tags: x.tags.map((t) => t.replace(/_/g, ' ')).concat(x.tags) });

export function openPosts(items, start, title, ctx) {
  ctx.openReader({
    title, start, mode: 'ltr',
    pages: items.map((x) => ({ src: x.sample || x.original, fallback: x.original, fallback2: x.thumb })),
    onAddToBoard: (i) => { const { album, picture } = B.asAlbumPicture(items[i]); return addToBoard(album, picture, 0, ctx); },
    onSimilar: (i) => showSimilar(items[i]),
  });
}

export function renderArt(q, site, sort, ctx) {
  const enabled = B.enabledSites();
  if (!enabled.length) {
    app.innerHTML = '<div class="box"><h3>No art sites turned on</h3><p class="muted small">Turn some on in ⚙ Settings → Art sites.</p></div>';
    return;
  }
  site = site && (site === 'all' || enabled.includes(site)) ? site : store.get('ldl_art_site', 'all');
  sort = sort || store.get('ldl_art_sort', 'new');
  const sites = site === 'all' ? enabled : [site];
  const href = (s, o) => `#/art/${encodeURIComponent(q)}/${s}/${o}`;
  const items = [];
  let page = 0, more = true, errors = [];

  const draw = () => {
    app.innerHTML = `${ctx.libraryNav('browse')}
      <div class="sortbar artsort">
        <div class="chips">${['all', ...enabled].map((s) => `<a class="chip ${s === site ? 'on' : ''}" data-site="${s}" href="${href(s, sort)}">${s === 'all' ? 'All sites' : esc(B.SITES[s].name)}</a>`).join('')}</div>
        <div class="chips small-chips">${[['new', 'Newest'], ['top', 'Top rated']].map(([k, v]) => `<a class="chip ${k === sort ? 'on' : ''}" data-sort="${k}" href="${href(site, k)}">${v}</a>`).join('')}</div>
      </div>
      <h2>${q ? `Art: ${esc(q)}` : 'Latest art'}</h2>
      ${errors.length ? `<details class="small"><summary>⚠ ${errors.length} site${errors.length > 1 ? 's' : ''} didn't respond</summary><pre class="log">${esc(errors.join('\n'))}</pre></details>` : ''}
      ${items.length ? `<div class="grid thumbs art">${items.map((x, i) => `<div class="thumb" data-i="${i}">${imgTag(x.thumb || x.sample)}<span>${esc(B.SITES[x.site].name)}</span></div>`).join('')}</div>`
        : `<p class="muted">Nothing found${q ? '. Art sites use tags: try single words like <b>thighhighs</b>, <b>from_behind</b>, <b>smile</b>' : ''}.</p>`}
      ${more ? '<div class="center"><button id="moreArt">Load more</button></div>' : ''}
      <p class="muted small">Tip: search with tags separated by spaces, e.g. <i>long_hair thighhighs</i>. Danbooru allows 2 tags unless you add your API key in Settings.</p>`;
    app.querySelectorAll('[data-site]').forEach((a) => (a.onclick = () => store.set('ldl_art_site', a.dataset.site)));
    app.querySelectorAll('[data-sort]').forEach((a) => (a.onclick = () => store.set('ldl_art_sort', a.dataset.sort)));
    app.querySelectorAll('.thumb').forEach((t) => (t.onclick = () => openPosts(items, +t.dataset.i, q ? `Art: ${q}` : 'Art', ctx)));
    $('#moreArt')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Loading…';
      await load(); draw();
    });
  };
  const load = async () => {
    let added = 0;
    for (let tries = 0; tries < 3 && more && added < 20; tries++) {
      const r = await B.searchAll(sites, q, ++page, sort);
      errors = r.errors;
      more = r.more;
      for (const x of r.items) if (!postHidden(x, ctx) && !items.some((y) => y.key === x.key)) { items.push(x); added++; }
    }
  };
  app.innerHTML = '<div class="center"><div class="spinner"></div></div>';
  load().then(draw, (e) => ctx.showError(e));
}
