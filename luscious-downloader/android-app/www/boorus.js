// Anime / hentai art image boards ("boorus") with open JSON APIs.
// Every result is a single drawn image with detailed tags, which makes them great for references.
import { getJson } from './api.js';
import { store } from './util.js';

// Always excluded in queries (where the site allows it) and filtered from results.
const MINOR_TAGS = ['loli', 'shota', 'toddlercon', 'child', 'young'];

export const SITES = {
  danbooru: { name: 'Danbooru', home: 'https://danbooru.donmai.us' },
  gelbooru: { name: 'Gelbooru', home: 'https://gelbooru.com' },
  yandere: { name: 'Yande.re', home: 'https://yande.re' },
  konachan: { name: 'Konachan', home: 'https://konachan.com' },
};

export function booruPrefs() {
  return {
    enabled: { danbooru: true, gelbooru: true, yandere: true, konachan: true },
    ratings: 'nsfw', // 'nsfw' = questionable + explicit, 'explicit' = explicit only
    danbooruUser: '', danbooruKey: '', gelbooruUser: '', gelbooruKey: '',
    ...store.get('ldl_boorus', {}),
  };
}
export const saveBooruPrefs = (p) => store.set('ldl_boorus', p);
export const enabledSites = () => Object.keys(SITES).filter((k) => booruPrefs().enabled[k]);

const enc = encodeURIComponent;
const toTags = (q) => String(q || '').trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
const absolute = (u, home) => (!u ? null : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? home + u : u);
const RATING = { g: 'general', s: 'sensitive', q: 'questionable', e: 'explicit', general: 'general', sensitive: 'sensitive', safe: 'sensitive', questionable: 'questionable', explicit: 'explicit' };

function post(site, raw) {
  const home = SITES[site].home;
  let tags, artists = [], rating, original, sample, thumb, w, h;
  if (site === 'danbooru') {
    tags = (raw.tag_string || '').split(' ').filter(Boolean);
    artists = (raw.tag_string_artist || '').split(' ').filter(Boolean);
    rating = RATING[raw.rating];
    original = raw.file_url; sample = raw.large_file_url; thumb = raw.preview_file_url;
    w = raw.image_width; h = raw.image_height;
  } else {
    tags = (raw.tags || '').split(' ').filter(Boolean);
    rating = RATING[raw.rating];
    original = raw.file_url; sample = raw.sample_url || raw.jpeg_url; thumb = raw.preview_url;
    w = raw.width; h = raw.height;
  }
  return {
    site, id: String(raw.id), key: `${site}:${raw.id}`,
    original: absolute(original, home), sample: absolute(sample, home), thumb: absolute(thumb, home),
    width: w || 0, height: h || 0, rating, score: raw.score ?? 0, tags, artists,
    pageUrl: site === 'danbooru' ? `${home}/posts/${raw.id}` : site === 'gelbooru' ? `${home}/index.php?page=post&s=view&id=${raw.id}` : `${home}/post/show/${raw.id}`,
    ext: (String(original || '').match(/\.([a-z0-9]+)(\?|$)/i)?.[1] || '').toLowerCase(),
  };
}

// Search one site. sort: 'new' | 'top'. Returns normalized posts (already filtered).
export async function searchSite(site, query, page = 1, sort = 'new', limit = 40) {
  const p = booruPrefs();
  const user = toTags(query).filter((t) => !MINOR_TAGS.includes(t.replace(/^-/, '')));
  let url, raw;
  if (site === 'danbooru') {
    // Anonymous Danbooru searches allow only 2 normal tags; rating/order are extra.
    const tags = [...user.slice(0, p.danbooruKey ? 6 : 2), p.ratings === 'explicit' ? 'rating:e' : '-rating:g'];
    if (sort === 'top') tags.push('order:score');
    url = `https://danbooru.donmai.us/posts.json?limit=${limit}&page=${page}&tags=${enc(tags.join(' '))}`;
    if (p.danbooruUser && p.danbooruKey) url += `&login=${enc(p.danbooruUser)}&api_key=${enc(p.danbooruKey)}`;
    raw = await getJson(url);
  } else if (site === 'gelbooru') {
    const tags = [...user, p.ratings === 'explicit' ? 'rating:explicit' : '-rating:general', ...MINOR_TAGS.map((t) => `-${t}`)];
    if (sort === 'top') tags.push('sort:score:desc');
    url = `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&limit=${limit}&pid=${page - 1}&tags=${enc(tags.join(' '))}`;
    if (p.gelbooruUser && p.gelbooruKey) url += `&user_id=${enc(p.gelbooruUser)}&api_key=${enc(p.gelbooruKey)}`;
    const j = await getJson(url);
    raw = Array.isArray(j) ? j : j?.post || [];
  } else {
    const home = SITES[site].home;
    const tags = [...user, p.ratings === 'explicit' ? 'rating:e' : '-rating:s', ...MINOR_TAGS.slice(0, 2).map((t) => `-${t}`)];
    if (sort === 'top') tags.push('order:score');
    url = `${home}/post.json?limit=${limit}&page=${page}&tags=${enc(tags.join(' '))}`;
    raw = await getJson(url);
  }
  return (Array.isArray(raw) ? raw : [])
    .map((r) => post(site, r))
    .filter((x) => x.original || x.sample)
    .filter((x) => !['mp4', 'webm', 'zip', 'swf'].includes(x.ext))
    .filter((x) => (p.ratings === 'explicit' ? x.rating === 'explicit' : x.rating === 'explicit' || x.rating === 'questionable'));
}

// Search several sites at once and interleave the results. Errors from one site don't stop the others.
export async function searchAll(sites, query, page = 1, sort = 'new') {
  const results = await Promise.all(sites.map((s) => searchSite(s, query, page, sort).then((items) => ({ s, items }), (error) => ({ s, items: [], error }))));
  const out = [];
  const max = Math.max(0, ...results.map((r) => r.items.length));
  for (let i = 0; i < max; i++) for (const r of results) if (r.items[i]) out.push(r.items[i]);
  return { items: out, errors: results.filter((r) => r.error).map((r) => `${SITES[r.s].name}: ${r.error.message}`), more: results.some((r) => r.items.length > 0) };
}

// Booru tag for a reference-finder term (most are the same with underscores).
const TAG_FOR = {
  face: 'portrait', eyes: 'eye_focus', 'open mouth': 'open_mouth', tongue: 'tongue_out', shoulders: 'bare_shoulders', arms: 'arms_up',
  hands: 'hand_focus', belly: 'stomach', waist: 'narrow_waist', 'big ass': 'huge_ass', 'big breasts': 'large_breasts', 'big penis': 'large_penis',
  'shaved pussy': 'pussy', slim: 'slender', athletic: 'toned', thick: 'thick_thighs', chubby: 'plump', muscle: 'muscular_female', tall: 'tall_female',
  milf: 'mature_female', stockings: 'thighhighs', swimsuit: 'one-piece_swimsuit', 'side view': 'from_side', 'dynamic pose': 'action',
  shy: 'embarrassed', wink: 'one_eye_closed', oiled: 'shiny_skin', 'tan lines': 'tanlines',
};
export const booruTag = (term) => TAG_FOR[term] || term.trim().toLowerCase().replace(/\s+/g, '_');

// Shapes a post like an album + picture so boards and the reader can use it.
export function asAlbumPicture(x) {
  return {
    album: { id: x.key, title: `${SITES[x.site].name} #${x.id}`, author: x.artists[0] || null, authorId: null, pageUrl: x.pageUrl },
    picture: { id: x.key, original: x.original || x.sample, large: x.sample, thumb: x.thumb || x.sample },
  };
}
