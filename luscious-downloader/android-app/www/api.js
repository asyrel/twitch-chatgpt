import * as N from './native.js';

// luscious.net client that runs inside the Android app (no server needed).
// On the phone, requests go through Capacitor's native HTTP so the site's CORS rules don't apply.
const Cap = window.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
const plugin = (name) => Cap?.Plugins?.[name] || Cap?.registerPlugin?.(name);
const Http = isNative ? plugin('CapacitorHttp') : null;

// luscious.net has served its API from a few hosts over time; try each and remember the one that works.
const ENDPOINTS = [
  'https://www.luscious.net/graphql/nobatch/',
  'https://members.luscious.net/graphql/nobatch/',
  'https://api.luscious.net/graphql/nobatch/',
];
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
function endpointOrder() {
  const forced = ls.get('ldl_api');
  if (forced) return [forced];
  const good = ls.get('ldl_api_ok');
  return good && ENDPOINTS.includes(good) ? [good, ...ENDPOINTS.filter((e) => e !== good)] : ENDPOINTS;
}
const SITE = 'https://www.luscious.net';
// Use the phone's real browser identity, so luscious.net (and its bot check) sees a normal visitor.
export const UA = navigator.userAgent;

export class ApiError extends Error {
  constructor(message, { blocked = false, challenge = false, details = [] } = {}) {
    super(message);
    this.blocked = blocked;
    this.challenge = challenge;
    this.details = details;
  }
}

async function postOnce(url, body) {
  const origin = new URL(url).origin;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'User-Agent': UA,
    Origin: origin,
    Referer: origin + '/',
  };
  if (Http) {
    const r = await Http.request({ url, method: 'POST', data: body, headers, responseType: 'text' });
    const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status: r.status, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data), headers: h };
  }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text(), headers: { server: r.headers.get('server') || '', 'cf-mitigated': r.headers.get('cf-mitigated') || '' } };
}

async function postJson(path, body) {
  const details = [];
  let challenge = false;
  for (const base of endpointOrder()) {
    const url = base + path;
    let res;
    try {
      res = await postOnce(url, body);
    } catch (e) {
      details.push(`${new URL(base).host}: ${e.message || e}`);
      continue;
    }
    let json = null;
    try { json = JSON.parse(res.text); } catch {}
    if (json && (res.status < 400 || json.errors)) {
      ls.set('ldl_api_ok', base);
      return json;
    }
    const isCf = res.headers['cf-mitigated'] === 'challenge' || /just a moment|cf-chl|challenge-platform|attention required/i.test(res.text || '');
    challenge ||= isCf;
    const snippet = (res.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    details.push(`${new URL(base).host}: HTTP ${res.status}${res.headers.server ? ` (${res.headers.server})` : ''}${isCf ? ' – bot check' : ''}${snippet ? ` – ${snippet}` : ''}`);
  }
  throw new ApiError(
    challenge ? 'luscious.net wants to check you\'re not a bot.' : 'luscious.net refused the request.',
    { blocked: true, challenge, details },
  );
}

// Fields the live API rejected; they're dropped from later queries.
const unknownFields = new Set();
function stripFields(query) {
  let q = query;
  for (const f of unknownFields) {
    // Remove "field" or "field { ... }" (one level of nesting is enough for our queries).
    q = q.replace(new RegExp(`\\b${f}\\s*\\{[^{}]*\\}`, 'g'), '').replace(new RegExp(`\\b${f}\\b(?!\\s*[:(])`, 'g'), '');
  }
  return q;
}

async function gql(operationName, query, variables) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const json = await postJson(`?operationName=${operationName}`, { id: 1, operationName, query: stripFields(query), variables });
    if (!json.errors?.length) return json.data;
    const bad = json.errors.map((e) => e.message?.match(/Cannot query field ["'](\w+)["']/)?.[1]).filter(Boolean);
    if (!bad.length || bad.every((f) => unknownFields.has(f))) throw new Error(json.errors.map((e) => e.message).join('; '));
    bad.forEach((f) => unknownFields.add(f));
  }
  throw new Error('Luscious API query failed');
}

// ---------- parsing ----------
export function parseAlbumId(input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/albums\/[^/?#]*?_(\d+)(?:[/?#]|$)/) || s.match(/_id_(\d+)/) || s.match(/\/albums?\/(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}
export function parseUserId(input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/users?\/(?:[^/?#]*?_)?(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}
export const looksLikeAlbum = (s) => /^\d+$/.test(s.trim()) || /luscious\.net\/.*(albums?\/|_id_)/i.test(s);
export function absUrl(u) {
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return SITE + u;
  return u;
}

// ---------- queries ----------
const CARD = 'id title url number_of_pictures number_of_animated_pictures is_manga cover { url } tags { text } content { id title } audiences { id title } genres { id title }';
const LIST_QUERY = `query AlbumList($input: AlbumListInput!) {
  album { list(input: $input) {
    info { page has_next_page total_items total_pages }
    items { ... on Album { ${CARD} } }
  } }
}`;
const ALBUM_QUERY = `query AlbumGet($id: ID!) {
  album { get(id: $id) {
    ... on Album { ${CARD} description created_by { name display_name } language { title } }
    ... on MutationError { errors { code message } }
  } }
}`;
const PICTURES_QUERY = `query AlbumListOwnPictures($input: PictureListInput!) {
  picture { list(input: $input) {
    info { page has_next_page total_items total_pages }
    items { id title position is_animated url_to_original url_to_video download_url thumbnails { width url } }
  } }
}`;
const PROFILE_QUERY = `query ProfileGet($user_id: ID!) {
  userprofile { get(user_id: $user_id) {
    ... on UserProfile { id user { id name display_name } number_of_albums number_of_favorite_albums }
    ... on MutationError { errors { code message } }
  } }
}`;

function normAlbum(a) {
  return {
    id: String(a.id),
    title: a.title || `Album ${a.id}`,
    url: absUrl(a.url),
    description: a.description || '',
    pictures: a.number_of_pictures ?? 0,
    animated: a.number_of_animated_pictures ?? 0,
    cover: absUrl(a.cover?.url),
    author: a.created_by?.display_name || a.created_by?.name || null,
    language: a.language?.title || null,
    tags: (a.tags || []).map((t) => t.text).filter(Boolean),
    genres: (a.genres || []).map((g) => g.title).filter(Boolean),
    audiences: (a.audiences || []).map((g) => g.title).filter(Boolean),
    content: a.content?.title || null,
    isManga: a.is_manga ?? null,
  };
}
const errorsOf = (x) => x?.errors?.length && x.errors.map((e) => e.message || e.code).join('; ');

async function albumList(display, filters, page) {
  const data = await gql('AlbumList', LIST_QUERY, { input: { display, filters, page } });
  const list = data?.album?.list;
  if (!list) throw new Error('Could not load albums');
  return { info: list.info, items: (list.items || []).filter((a) => a?.id).map(normAlbum) };
}

// Content types, audiences and genres (with their ids), as luscious.net defines them.
const CATEGORIES_QUERY = `query BootStrapMediaCategories {
  media_categories {
    content_types { id title }
    audiences { id title }
    genres { id title }
  }
}`;
let categoriesPromise = null;
export function getCategories() {
  if (!categoriesPromise) {
    categoriesPromise = (async () => {
      try {
        const cached = JSON.parse(localStorage.getItem('ldl_categories') || 'null');
        if (cached && Date.now() - cached.at < 7 * 864e5) return cached.data;
      } catch {}
      const data = await gql('BootStrapMediaCategories', CATEGORIES_QUERY, {});
      const mc = data?.media_categories || {};
      const out = { content: mc.content_types || [], audiences: mc.audiences || [], genres: mc.genres || [] };
      try { localStorage.setItem('ldl_categories', JSON.stringify({ at: Date.now(), data: out })); } catch {}
      return out;
    })().catch((e) => { categoriesPromise = null; throw e; });
  }
  return categoriesPromise;
}

export const CONTENT_MATCH = { hentai: /hentai|anime|drawn|cartoon|toon/i, real: /real|photo/i };

// Which content type an album belongs to: 'hentai', 'real', or null if unknown.
export function contentKind(album) {
  if (!album.content) return null;
  if (CONTENT_MATCH.real.test(album.content)) return 'real';
  if (CONTENT_MATCH.hentai.test(album.content)) return 'hentai';
  return 'other';
}

export const SORTS = ['date_trending', 'date_newest', 'rating_all_time', 'search_score'];

// section: 'hentai' | 'real' | 'manga' | null (everything)
export async function listAlbums({ section = null, q = '', sort = '', page = 1 } = {}) {
  q = String(q || '').trim();
  const display = SORTS.includes(sort) ? sort : q ? 'search_score' : 'date_trending';
  const filters = [{ name: 'album_type', value: section === 'manga' ? 'manga' : 'pictures' }];
  if (!section) filters.length = 0;
  if (section === 'hentai' || section === 'real') {
    const cats = await getCategories().catch(() => null);
    const ct = cats?.content.find((c) => CONTENT_MATCH[section].test(c.title));
    if (ct) filters.push({ name: 'content_id', value: String(ct.id) });
  }
  if (q) filters.push({ name: 'search_query', value: q });
  return albumList(display, filters, page);
}
export const searchAlbums = (q, page, sort) => listAlbums({ q, page, sort });

export function favoriteAlbums(userId, page = 1) {
  return albumList('date_newest', [{ name: 'favorite_by_user_id', value: String(userId) }], page);
}

export async function getProfile(userId) {
  const data = await gql('ProfileGet', PROFILE_QUERY, { user_id: String(userId) });
  const p = data?.userprofile?.get;
  if (!p || errorsOf(p)) throw new Error(errorsOf(p) || 'User not found');
  return {
    id: String(p.user?.id ?? userId),
    name: p.user?.display_name || p.user?.name || `User ${userId}`,
    favorites: p.number_of_favorite_albums ?? null,
  };
}

export async function getAlbum(id) {
  const data = await gql('AlbumGet', ALBUM_QUERY, { id: String(id) });
  const a = data?.album?.get;
  if (!a || errorsOf(a) || !a.id) throw new Error(errorsOf(a) || 'Album not found');
  return normAlbum(a);
}

function largestThumb(thumbs) {
  const sorted = (thumbs || []).filter((t) => t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url ?? null;
}
function pickThumb(thumbs) {
  const sorted = (thumbs || []).filter((t) => t.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((t) => (t.width || 0) >= 300) || sorted[sorted.length - 1])?.url ?? null;
}

export async function getAllPictures(albumId, onProgress) {
  const all = [];
  for (let page = 1; page < 1000; page++) {
    const data = await gql('AlbumListOwnPictures', PICTURES_QUERY, {
      input: { filters: [{ name: 'album_id', value: String(albumId) }], display: 'position', page },
    });
    const list = data?.picture?.list;
    if (!list) throw new Error('Could not list pictures');
    for (const p of list.items) {
      all.push({
        id: String(p.id),
        title: p.title || '',
        animated: !!p.is_animated,
        original: absUrl(p.url_to_video || p.url_to_original || p.download_url),
        // luscious.net sometimes refuses full-size originals; its largest preview (~1680px) still works.
        large: p.url_to_video ? null : absUrl(largestThumb(p.thumbnails)),
        thumb: absUrl(pickThumb(p.thumbnails) || p.url_to_original),
      });
    }
    onProgress?.(all.length, list.info.total_items);
    if (!list.info.has_next_page || !list.items.length) break;
  }
  return all;
}

// ---------- images & saving ----------
// Loads an image as a data: URL through native HTTP (used if the <img> tag can't load it directly).
export async function imageDataUrl(url) {
  if (!Http) return url;
  const r = await Http.request({ url, method: 'GET', responseType: 'blob', headers: { 'User-Agent': UA, Referer: SITE + '/' } });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const type = r.headers?.['Content-Type'] || r.headers?.['content-type'] || 'image/jpeg';
  return `data:${type};base64,${r.data}`;
}

export function safeName(s, max = 80) {
  return (String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[. ]+$/, '')) || 'untitled';
}
export function fileNameFor(pic, index, total) {
  const width = Math.max(3, String(total).length);
  let ext = '';
  try { ext = (new URL(pic.original).pathname.match(/\.[a-z0-9]{2,5}$/i) || [''])[0].toLowerCase(); } catch {}
  const base = pic.title ? `_${safeName(pic.title.replace(/\.[a-z0-9]{2,5}$/i, ''), 60)}` : '';
  return `${String(index + 1).padStart(width, '0')}${base}${ext || '.jpg'}`;
}

// ---------- saving to the phone ----------
// Folder name for an album inside the download location.
export const albumFolder = (album) => `${safeName(album.title)} (${album.id})`;

// Saves every picture of an album (skips files already saved). Runs natively so it keeps going in the background.
// Compression presets. The Galaxy A25 screen is 1080px wide; extra width is kept for zooming in.
// Pages are only ever scaled evenly, never cropped.
export const COMPRESSION = {
  lossless: { label: 'Lossless – identical quality, full size (recommended)', compress: { lossless: true } },
  full: { label: 'Full size, visually identical (WebP 92%)', compress: { quality: 92, maxWidth: 0 } },
  balanced: { label: 'Smaller (WebP 80%, max 1440px wide)', compress: { quality: 80, maxWidth: 1440 } },
  small: { label: 'Smallest (WebP 70%, max 1080px wide)', compress: { quality: 70, maxWidth: 1080 } },
  off: { label: 'Off – keep files exactly as downloaded', compress: null },
};

export async function saveAlbum(album, pictures, target, { onProgress, jobId, compression = 'lossless' } = {}) {
  if (!N.hasNative) throw new Error('Saving only works in the Android app.');
  if (!target) throw new Error('Choose a download location in Settings first.');
  const folder = albumFolder(album);
  const files = pictures.map((p, i) => ({ url: p.original, fallback: p.large || '', name: fileNameFor(p, i, pictures.length) }));
  const compress = COMPRESSION[compression]?.compress || null;
  const r = await N.downloadAlbum({ target, folder, title: album.title, files, jobId, compress, userAgent: UA, onProgress });
  return { folder, failed: r.failed, cancelled: r.cancelled, originalBytes: r.originalBytes || 0, savedBytes: r.savedBytes || 0 };
}

// URLs of a saved album's files on the phone, for offline reading. null if not saved.
export async function localUrls(target, folder, pictures) {
  if (!N.hasNative || !target || !folder) return null;
  try {
    const r = await N.listAlbum(target, folder);
    if (!r?.exists) return null;
    // Match by name without extension: compressed pages are saved as .webp.
    const stem = (n) => n.replace(/\.[a-z0-9]{2,5}$/i, '');
    const byName = new Map(r.files.map((f) => [stem(f.name), f.uri]));
    return pictures.map((p, i) => {
      const uri = byName.get(stem(fileNameFor(p, i, pictures.length)));
      return uri ? N.fileSrc(uri) : null;
    });
  } catch {
    return null;
  }
}
