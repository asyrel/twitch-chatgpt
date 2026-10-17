// "More like this": finds images similar to one you're looking at, using its artist and most distinctive tags.
import * as B from './boorus.js';
import * as T from './taste.js';
import { $, app, esc, imgTag } from './util.js';
import { openPosts, postHidden } from './art.js';

// Tags almost every image has; they don't say what makes this one special.
const COMMON = new Set(('1girl 2girls 3girls 1boy 2boys solo solo_focus multiple_girls looking_at_viewer blush smile open_mouth closed_mouth ' +
  'long_hair short_hair medium_hair breasts large_breasts medium_breasts small_breasts nipples navel nude completely_nude pussy penis ' +
  'uncensored censored mosaic_censoring bar_censor simple_background white_background grey_background gradient_background ' +
  'standing sitting lying holding bangs hair_ornament sweat thighs collarbone cleavage bare_shoulders shiny shiny_skin ' +
  'hetero sex vaginal cum teeth tongue looking_back full_body upper_body cowboy_shot portrait hand_up arm_up arms_up ' +
  'eyebrows_visible_through_hair hair_between_eyes parted_lips heart spoken_heart english_text speech_bubble').split(' '));

let seed = null;
export function setSeed(s) {
  seed = s;
  try { sessionStorage.setItem('ldl_seed', JSON.stringify(s)); } catch {}
}
const getSeed = () => seed || (() => { try { return JSON.parse(sessionStorage.getItem('ldl_seed') || 'null'); } catch { return null; } })();

// Seed from an art-site post, a feed card or a board item: { key, thumb, tags, artists, label }.
export const seedFrom = (x) => ({
  key: x.key || x.picture?.id || x.id,
  thumb: x.thumb || x.picture?.thumb || x.src,
  tags: (x.tags || []).filter((t) => !String(t).startsWith('artist:')),
  artists: x.artists || (x.tags || []).filter((t) => String(t).startsWith('artist:')).map((t) => t.slice(7)),
  label: x.label || '',
});

function distinctive(tags) {
  const f = T.features(tags).map(B.booruTag).filter((t) => !COMMON.has(t) && !t.includes(':'));
  // Prefer tags you've liked before, then keep the rest in order.
  const w = T.loadTaste().w;
  return [...new Set(f)].sort((a, b) => (w[b] || 0) - (w[a] || 0));
}

function queries(s) {
  const q = [];
  for (const a of (s.artists || []).slice(0, 1)) q.push({ tags: B.booruTag(a), why: `artist ${a.replace(/_/g, ' ')}` });
  const d = distinctive(s.tags);
  const top = d.slice(0, 8);
  for (let i = 0; i + 1 < top.length && q.length < 4; i += 2) q.push({ tags: `${top[i]} ${top[i + 1]}`, why: `${top[i]} + ${top[i + 1]}` });
  if (q.length < 2 && top[0]) q.push({ tags: top[0], why: top[0] });
  if (!q.length) {
    const any = T.features(s.tags).map(B.booruTag).slice(0, 2);
    if (any.length) q.push({ tags: any.join(' '), why: any.join(' + ') });
  }
  return q;
}

// Shared tags (plus same artist) decide the order.
function similarity(s, x) {
  const a = new Set(T.features(s.tags).map(B.booruTag));
  const b = new Set(x.tags);
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += COMMON.has(t) ? 0.3 : 1;
  const sameArtist = (s.artists || []).some((ar) => x.artists.includes(B.booruTag(ar)));
  return shared / Math.sqrt(a.size + b.size || 1) + (sameArtist ? 2 : 0);
}

export async function renderSimilar(ctx) {
  const s = getSeed();
  if (!s) { location.hash = '#/feed'; return; }
  const sites = B.enabledSites();
  const qs = queries(s);
  const items = [];
  let page = 0, more = true, errors = [];
  const head = `<div class="page-head"><button class="back" onclick="history.back()">‹</button><h2>More like this</h2></div>
    <div class="seed">${s.thumb ? imgTag(s.thumb) : ''}<div><div class="small muted">Matching</div>
      <div class="chips wrap">${qs.map((q) => `<a class="chip" href="#/art/${encodeURIComponent(q.tags)}">${esc(q.why.replace(/_/g, ' '))}</a>`).join('') || '<span class="muted small">no tags on this image</span>'}</div></div></div>`;
  const load = async () => {
    page++;
    const results = await Promise.all(qs.map((q) => B.searchAll(sites, q.tags, page, 'top').catch((e) => ({ items: [], errors: [e.message], more: false }))));
    errors = results.flatMap((r) => r.errors || []);
    more = results.some((r) => r.more);
    const fresh = results.flatMap((r) => r.items).filter((x) => x.key !== s.key && !postHidden(x, ctx) && !items.some((y) => y.key === x.key));
    const seen = new Set();
    const ranked = fresh.filter((x) => !seen.has(x.key) && seen.add(x.key)).map((x) => ({ x, v: similarity(s, x) })).sort((a, b) => b.v - a.v).map((r) => r.x);
    items.push(...ranked);
  };
  const draw = () => {
    app.innerHTML = `${head}
      ${errors.length && !items.length ? `<div class="err">${esc(errors[0])}</div>` : ''}
      ${items.length ? `<div class="grid thumbs">${items.map((x, i) => `<div class="thumb" data-i="${i}">${imgTag(x.thumb || x.sample)}</div>`).join('')}</div>` : (qs.length ? '<p class="muted">Nothing similar found.</p>' : '')}
      ${more && items.length ? '<div class="center"><button id="moreSim">Load more</button></div>' : ''}`;
    app.querySelectorAll('.thumb').forEach((t) => (t.onclick = () => openPosts(items, +t.dataset.i, 'More like this', ctx)));
    $('#moreSim')?.addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'Loading…'; await load(); draw(); });
  };
  app.innerHTML = head + '<div class="center"><div class="spinner"></div></div>';
  if (!qs.length) { draw(); return; }
  if (!sites.length) { app.innerHTML = head + '<p class="muted">Turn on an art site in ⚙ Settings to find similar images.</p>'; return; }
  try { await load(); } catch (e) { errors = [e.message]; }
  draw();
}

// Opens "More like this" for something.
export function showSimilar(x) {
  setSeed(seedFrom(x));
  // Already on "More like this"? The address doesn't change, so trigger the screen change ourselves.
  if (location.hash === '#/similar') window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = '#/similar';
}
