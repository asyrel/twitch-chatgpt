// Client for luscious.net's public GraphQL API.
export const SITE = 'https://www.luscious.net';
export const API = process.env.LUSCIOUS_API || 'https://members.luscious.net/graphql/nobatch/';
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const ORIGIN = new URL(API).origin;

// Holds the luscious.net cookies for one signed-in user.
export class Session {
  constructor(cookies = {}) {
    this.cookies = { ...cookies };
  }
  get loggedIn() {
    return !!(this.cookies.sessionid || this.cookies.__token);
  }
  header() {
    return Object.entries(this.cookies).filter(([k]) => !k.startsWith('__')).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res) {
    const list = res.headers.getSetCookie?.() || [];
    for (const line of list) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a)) || value === '' || value === '""';
      if (expired) delete this.cookies[name];
      else this.cookies[name] = value;
    }
    return res;
  }
  headers(extra = {}) {
    const h = { 'User-Agent': UA, Referer: ORIGIN + '/', ...extra };
    const cookie = this.header();
    if (cookie) h.Cookie = cookie;
    if (this.cookies.__token) h.Authorization = `Bearer ${this.cookies.__token}`;
    if (this.cookies.csrftoken) h['X-CSRFToken'] = this.cookies.csrftoken;
    return h;
  }
}

// Raw GraphQL call. Returns the full JSON ({ data, errors }) without throwing on GraphQL errors.
export async function gqlRaw(operationName, query, variables, session = new Session()) {
  const res = await fetch(`${API}?operationName=${operationName}`, {
    method: 'POST',
    headers: session.headers({ 'Content-Type': 'application/json', Accept: 'application/json', Origin: ORIGIN }),
    body: JSON.stringify({ id: 1, operationName, query, variables }),
    redirect: 'manual',
  });
  session.absorb(res);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Luscious API returned HTTP ${res.status} (not JSON)`);
  }
  if (!res.ok && !json.errors) throw new Error(`Luscious API returned HTTP ${res.status}`);
  return json;
}

export async function gql(operationName, query, variables, session) {
  const json = await gqlRaw(operationName, query, variables, session);
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

// Accepts an album URL (any luscious.net subdomain) or a bare numeric id.
export function parseAlbumId(input) {
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return s;
  const m =
    s.match(/\/albums\/[^/?#]*?_(\d+)(?:[/?#]|$)/) ||
    s.match(/_id_(\d+)/) ||
    s.match(/\/albums?\/(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

export function absUrl(u) {
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return SITE + u;
  return u;
}

// Image proxying is limited to luscious hosts so the server is not an open proxy.
export function isLusciousHost(u) {
  try {
    const { protocol, hostname } = new URL(u);
    return (protocol === 'https:' || protocol === 'http:') &&
      (hostname === 'luscious.net' || hostname.endsWith('.luscious.net'));
  } catch {
    return false;
  }
}

const ALBUM_QUERY = `
query AlbumGet($id: ID!) {
  album {
    get(id: $id) {
      ... on Album {
        id title slug url description created number_of_pictures number_of_animated_pictures
        cover { url }
        created_by { name display_name }
        language { title }
        tags { text }
        genres { title }
      }
      ... on MutationError { errors { code message } }
    }
  }
}`;

const PICTURES_QUERY = `
query AlbumListOwnPictures($input: PictureListInput!) {
  picture {
    list(input: $input) {
      info { page has_next_page total_items total_pages }
      items {
        id title position width height is_animated
        url_to_original url_to_video download_url
        thumbnails { width height url }
      }
    }
  }
}`;

export const ALBUM_CARD_FIELDS = `id title slug url number_of_pictures number_of_animated_pictures cover { url } tags { text }`;

const SEARCH_QUERY = `
query AlbumList($input: AlbumListInput!) {
  album {
    list(input: $input) {
      info { page has_next_page total_items total_pages }
      items {
        ... on Album {
          id title slug url number_of_pictures number_of_animated_pictures
          cover { url }
          tags { text }
        }
      }
    }
  }
}`;

function pickThumb(thumbs) {
  if (!thumbs?.length) return null;
  const sorted = [...thumbs].filter((t) => t.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((t) => (t.width || 0) >= 300) || sorted[sorted.length - 1])?.url ?? null;
}

export function normAlbum(a) {
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
  };
}

export async function getAlbum(id, session) {
  const data = await gql('AlbumGet', ALBUM_QUERY, { id: String(id) }, session);
  const a = data?.album?.get;
  if (!a) throw new Error('Album not found');
  if (a.errors?.length) throw new Error(a.errors.map((e) => e.message || e.code).join('; '));
  if (!a.id) throw new Error('Album not found');
  return normAlbum(a);
}

export async function getPicturesPage(albumId, page = 1, session) {
  const data = await gql('AlbumListOwnPictures', PICTURES_QUERY, {
    input: { filters: [{ name: 'album_id', value: String(albumId) }], display: 'position', page },
  }, session);
  const list = data?.picture?.list;
  if (!list) throw new Error('Could not list pictures');
  return {
    info: list.info,
    items: list.items.map((p, i) => ({
      id: String(p.id),
      title: p.title || '',
      position: p.position ?? (page - 1) * 50 + i + 1,
      width: p.width,
      height: p.height,
      animated: !!p.is_animated,
      original: absUrl(p.url_to_video || p.url_to_original || p.download_url),
      thumb: absUrl(pickThumb(p.thumbnails) || p.url_to_original),
    })),
  };
}

export async function getAllPictures(albumId, onProgress, session) {
  const all = [];
  for (let page = 1; page < 1000; page++) {
    const { info, items } = await getPicturesPage(albumId, page, session);
    all.push(...items);
    onProgress?.(all.length, info.total_items);
    if (!info.has_next_page || !items.length) break;
  }
  return all;
}

export const SORTS = ['search_score', 'date_trending', 'date_newest', 'rating_all_time', 'date_last_interaction'];

export async function searchAlbums(query, page = 1, sort, session) {
  const q = String(query || '').trim();
  const display = SORTS.includes(sort) ? sort : q ? 'search_score' : 'date_trending';
  const filters = q ? [{ name: 'search_query', value: q }] : [];
  const data = await gql('AlbumList', SEARCH_QUERY, { input: { display, filters, page } }, session);
  const list = data?.album?.list;
  if (!list) throw new Error('Search failed');
  return { info: list.info, items: list.items.filter((a) => a?.id).map(normAlbum) };
}

export async function fetchImage(url, { retries = 3, signal, session } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: session ? session.headers() : { 'User-Agent': UA, Referer: 'https://www.luscious.net/' },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

export function safeName(s, max = 80) {
  return (String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, max).replace(/[. ]+$/, '')) || 'untitled';
}

export function fileNameFor(pic, index, total) {
  const width = Math.max(3, String(total).length);
  let ext = '';
  try {
    ext = (new URL(pic.original).pathname.match(/\.[a-z0-9]{2,5}$/i) || [''])[0].toLowerCase();
  } catch {}
  const base = pic.title ? `_${safeName(pic.title.replace(/\.[a-z0-9]{2,5}$/i, ''), 60)}` : '';
  return `${String(index + 1).padStart(width, '0')}${base}${ext || '.jpg'}`;
}

// Runs fn over items with limited concurrency, yielding results in order.
export async function* orderedPool(items, concurrency, fn) {
  const pending = new Map();
  let next = 0;
  const launch = () => {
    while (next < items.length && pending.size < concurrency) {
      const i = next++;
      pending.set(i, fn(items[i], i).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })));
    }
  };
  for (let i = 0; i < items.length; i++) {
    launch();
    const r = await pending.get(i);
    pending.delete(i);
    yield { index: i, item: items[i], ...r };
  }
}
