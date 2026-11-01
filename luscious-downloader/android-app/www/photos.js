// Real photo references from luscious.net's "Real People" albums.
// Only used where you ask for them (Find → Real photos, Observe → Real photo refs), never in Browse.
// The always-on minor block and your hidden categories still apply.
import * as L from './api.js';
import * as RG from './redgifs.js';
import { shuffle } from './util.js';
import { booruPrefs } from './boorus.js';

export const realAllowed = (album, ctx) => L.contentKind(album) === 'real' && !ctx.hiddenReason(album, undefined, { allowReal: true })
  && (ctx.prefs().realMen || ![...(album.tags || []), album.title || ''].some((t) => /\b(male|males|men|man|guy|guys|penis|cock|dick|gay|blowjob|handjob|cumshot)\b/i.test(String(t))));

// Photos showing men or a penis (hidden unless "Include men" is on in Settings).
const MALE = /^(cock|cocks|dick|dicks|big_dick|big_cock|huge_cock|huge_dick|penis|balls|male|males|men|man|guy|guys|boy|boys|dude|gay|twink|bulge|jerk|jerking|jerk_off|jerking_off|jerkoff|stroking|handjob|blowjob|bj|deepthroat|cumshot|facial|cum|creampie|bbc|bwc|hung|daddy|dilf|solo_male|male_masturbation|sex|fucking|couple|couples|threesome|gangbang|penetration|doggystyle|missionary|cowgirl|reverse_cowgirl|riding|pov_sex|anal|dp)$/i;
// Signs the photo is of a woman (required when men are hidden, since tags can be incomplete).
const FEMALE = /^(girl|girls|woman|women|female|females|babe|wife|milf|lesbian|boobs|tits|big_tits|small_tits|natural_tits|titties|breasts|nipples|pussy|spread_pussy|shaved_pussy|hairy_pussy|ass|big_ass|booty|butt|pawg|thick|curvy|petite|bbw|lingerie|stockings|bikini|panties|thong|nude|naked|legs|thighs|feet|latina|asian|ebony|blonde|brunette|redhead|goth|alt_girl|solo|solo_female|bent_over|all_fours|from_behind|spreading|legs_up|tattoo|pierced_nipples|fit|fitness|yoga_pants|mature|cosplay)$/i;
const norm = (t) => String(t).trim().replace(/[\s-]+/g, '_');
export const showsMen = (tags) => (tags || []).some((t) => MALE.test(norm(t)));
export const looksFemale = (tags) => (tags || []).some((t) => FEMALE.test(norm(t)));

// Photo quality (follows the Quality setting): popular photos from verified creators, big enough,
// and not tagged as amateur / selfie / phone snapshots.
const LOW_QUALITY = /^(amateur|homemade|home_made|selfie|selfies|mirror|mirror_selfie|snapchat|snap|webcam|cam|camgirl|candid|voyeur|hidden_cam|spy|caught|drunk|granny|gilf|old|ugly|real_amateur|girlfriend|gf|wife|exgf|ex_girlfriend|leaked|leak|onlyfans_leak|tiktok|instagram|phone)$/i;
const QUALITY_MIN = { good: 3, best: 3.8 }; // ≈ 1000 / 6000 likes, or 100 / 600 from a verified creator
export function photoQuality(x) {
  const side = Math.min(x.width || 0, x.height || 0);
  return Math.log10((x.likes || 0) + 1) + (x.verified ? 1 : 0) + (side >= 1400 ? 0.3 : 0) - ((x.tags || []).some((t) => LOW_QUALITY.test(norm(t))) ? 3 : 0);
}
export function photoGoodEnough(x, q = booruPrefs().quality) {
  if (q === 'any') return true;
  const side = Math.min(x.width || 0, x.height || 0);
  if (side && side < (q === 'best' ? 1200 : 900)) return false;
  return photoQuality(x) >= QUALITY_MIN[q];
}

// Blocked/hidden check for a RedGIFs photo (minor block, hidden categories, men, your hidden tags, quality).
export const photoAllowed = (x, ctx) => !ctx.hiddenReason({ audiences: [], genres: [], tags: x.tags }, undefined, { allowReal: true })
  && (ctx.prefs().realMen || (!showsMen(x.tags) && looksFemale(x.tags)))
  && (Math.min(x.width || 0, x.height || 0) === 0 || Math.min(x.width, x.height) >= 600)
  && photoGoodEnough(x);

// Used when no body part is picked, so random sessions start from women-focused tags.
const DEFAULT_TAGS = ['Pornstar', 'Glamour', 'Model', 'Perfect Body', 'Gorgeous', 'Beautiful', 'Lingerie', 'Boobs', 'Ass', 'Curvy', 'Fitness', 'Stockings', 'Nude', 'Big Tits'];

// n random real photos, optionally for a tag: RedGIFs first, luscious real albums as a backup.
export async function realRefs(n, tag, ctx) {
  try {
    return await redgifsRefs(n, tag, ctx);
  } catch {
    return lusciousRefs(n, tag, ctx); // only if RedGIFs can't be reached
  }
}

async function redgifsRefs(n, tag, ctx) {
  const out = [];
  const seen = new Set();
  let maxPage = 8;
  for (let tries = 0; tries < 6 && out.length < n; tries++) {
    const page = 1 + Math.floor(Math.random() * maxPage);
    const r = await RG.searchPhotos(tag || DEFAULT_TAGS[Math.floor(Math.random() * DEFAULT_TAGS.length)], page, 'top');
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
