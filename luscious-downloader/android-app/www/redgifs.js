// RedGIFs: real NSFW photos (most of Reddit's NSFW media is hosted here), searchable by tag.
// Uses RedGIFs' public API with a free temporary token. Photos only (no videos).
import { getJson } from './api.js';
import { store } from './util.js';

const BASE = 'https://api.redgifs.com';
let token = null;

async function getToken(force = false) {
  const cached = store.get('ldl_rg_token', null);
  if (!force && token) return token;
  if (!force && cached && Date.now() - cached.at < 20 * 3600e3) return (token = cached.token);
  const r = await getJson(`${BASE}/v2/auth/temporary`);
  if (!r?.token) throw new Error('RedGIFs: no access token');
  token = r.token;
  store.set('ldl_rg_token', { token, at: Date.now() });
  return token;
}

// Reference-finder words -> RedGIFs tag names.
const TAG_FOR = {
  breasts: 'Boobs', 'small breasts': 'Small Tits', 'big breasts': 'Big Tits', 'huge breasts': 'Huge Tits', nipples: 'Nipples',
  'puffy nipples': 'Puffy Nipples', areolae: 'Big Areolas', ass: 'Ass', 'big ass': 'Big Ass', anus: 'Asshole', pussy: 'Pussy',
  'spread pussy': 'Spread Pussy', 'shaved pussy': 'Shaved Pussy', 'pubic hair': 'Hairy Pussy', penis: 'Cock', 'big penis': 'Big Dick',
  testicles: 'Balls', 'all fours': 'Doggystyle', 'from behind': 'From Behind', 'bent over': 'Bent Over', 'legs up': 'Legs Up',
  'spread legs': 'Spread Legs', stockings: 'Stockings', 'high heels': 'Heels', lingerie: 'Lingerie', bikini: 'Bikini',
  thighs: 'Thighs', feet: 'Feet', milf: 'MILF', 'thick': 'Thick', curvy: 'Curvy', petite: 'Petite', muscle: 'Muscular Girl',
  pov: 'POV', cosplay: 'Cosplay', 'tan lines': 'Tan Lines', 'wet': 'Wet', oiled: 'Oiled',
};
export const rgTag = (term) => TAG_FOR[String(term || '').toLowerCase()] || String(term || '').replace(/_/g, ' ').trim();

export const ORDERS = { top: 'top', trending: 'trending', latest: 'latest', top7: 'top7', top28: 'top28' };

// One page of photos for a tag. Returns normalized items.
export async function searchPhotos(term, page = 1, order = 'top') {
  const tag = rgTag(term);
  const url = (t) => `${BASE}/v2/gifs/search?type=i&order=${encodeURIComponent(ORDERS[order] || 'top')}&count=40&page=${page}${tag ? `&tags=${encodeURIComponent(tag)}` : ''}`;
  let j;
  try {
    j = await getJson(url(), { Authorization: `Bearer ${await getToken()}` });
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) throw e;
    j = await getJson(url(), { Authorization: `Bearer ${await getToken(true)}` }); // token expired
  }
  const items = (j?.gifs || []).filter((g) => g && g.urls && (g.urls.hd || g.urls.sd)).map((g) => ({
    key: `rg:${g.id}`, id: String(g.id), tags: (g.tags || []).map(String), user: g.userName || '',
    src: g.urls.hd || g.urls.sd, fallback: g.urls.sd, thumb: g.urls.thumbnail || g.urls.poster || g.urls.sd,
    width: g.width || 0, height: g.height || 0, pageUrl: `https://www.redgifs.com/watch/${g.id}`,
  }));
  return { items, more: page < (j?.pages || 1) };
}

// Shapes a photo like album + picture so boards and the reader can use it.
export function asAlbumPicture(x) {
  return {
    album: { id: x.key, title: `RedGIFs${x.user ? ` · ${x.user}` : ''}`, author: x.user || null, authorId: null, pageUrl: x.pageUrl },
    picture: { id: x.key, original: x.src, large: x.fallback, thumb: x.thumb },
  };
}
