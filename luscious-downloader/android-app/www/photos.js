// Real photo references from luscious.net's "Real People" albums.
// Only used where you ask for them (Find → Real photos, Observe → Real photo refs), never in Browse.
// The always-on minor block and your hidden categories still apply.
import * as L from './api.js';
import * as RG from './redgifs.js';
import { shuffle } from './util.js';

export const realAllowed = (album, ctx) => L.contentKind(album) === 'real' && !ctx.hiddenReason(album, undefined, { allowReal: true });

// Blocked/hidden check for a RedGIFs photo (minor block, hidden categories, your hidden tags).
export const photoAllowed = (x, ctx) => !ctx.hiddenReason({ audiences: [], genres: [], tags: x.tags }, undefined, { allowReal: true })
  && (Math.min(x.width || 0, x.height || 0) === 0 || Math.min(x.width, x.height) >= 600);

// n random real photos, optionally for a tag: RedGIFs first, luscious real albums as a backup.
export async function realRefs(n, tag, ctx) {
  try {
    const out = await redgifsRefs(n, tag, ctx);
    if (out.length) return out;
  } catch {}
  return lusciousRefs(n, tag, ctx);
}

async function redgifsRefs(n, tag, ctx) {
  const out = [];
  const seen = new Set();
  let maxPage = 5;
  for (let tries = 0; tries < 5 && out.length < n; tries++) {
    const page = 1 + Math.floor(Math.random() * maxPage);
    const r = await RG.searchPhotos(tag || '', page, Math.random() < 0.5 ? 'top' : 'trending');
    if (!r.items.length) { maxPage = Math.max(1, page - 1); continue; }
    if (!r.more) maxPage = Math.min(maxPage, page);
    for (const x of shuffle(r.items)) {
      if (out.length >= n || seen.has(x.key) || !photoAllowed(x, ctx)) continue;
      seen.add(x.key);
      const { album, picture } = RG.asAlbumPicture(x);
      out.push({ key: x.key, src: x.src, fallback: x.fallback, thumb: x.thumb, title: album.title, album, picture, tags: x.tags });
    }
  }
  return out;
}

async function lusciousRefs(n, tag, ctx) {
  const out = [];
  const usedAlbums = new Set();
  let maxPage = tag ? 3 : 10;
  for (let tries = 0; tries < 8 && out.length < n; tries++) {
    const page = 1 + Math.floor(Math.random() * maxPage);
    const res = await L.listAlbums({ section: 'real', q: (tag || '').replace(/_/g, ' '), sort: Math.random() < 0.5 ? 'rating_all_time' : 'date_trending', page });
    // Fewer pages than guessed: aim lower next time.
    if (!res.items.length) { maxPage = Math.max(1, page - 1); continue; }
    if (res.info?.total_pages) maxPage = Math.min(maxPage, res.info.total_pages);
    else if (!res.info?.has_next_page) maxPage = Math.min(maxPage, page);
    const albums = shuffle(res.items.filter((a) => realAllowed(a, ctx) && !usedAlbums.has(a.id)));
    if (!albums.length) continue;
    for (const a of albums.slice(0, 2)) {
      usedAlbums.add(a.id);
      try {
        const pics = (await L.firstPictures(a.id)).filter((p) => !/\.(mp4|webm|gif)(\?|$)/i.test(p.original));
        if (!pics.length) continue;
        const i = Math.floor(Math.random() * pics.length);
        const p = pics[i];
        out.push({ key: `lus:${p.id}`, src: p.original, fallback: p.large, thumb: p.thumb, title: a.title, album: a, picture: p, index: i });
        if (out.length >= n) break;
      } catch {}
    }
  }
  return out;
}
