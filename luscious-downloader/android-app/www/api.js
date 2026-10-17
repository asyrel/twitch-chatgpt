// luscious.net client that runs inside the Android app (no server needed).
// On the phone, requests go through Capacitor's native HTTP so the site's CORS rules don't apply.
const Cap = window.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
const plugin = (name) => Cap?.Plugins?.[name] || Cap?.registerPlugin?.(name);
const Http = isNative ? plugin('CapacitorHttp') : null;
const FS = isNative ? plugin('Filesystem') : null;

const API = (() => {
  try { return localStorage.getItem('ldl_api') || 'https://members.luscious.net/graphql/nobatch/'; }
  catch { return 'https://members.luscious.net/graphql/nobatch/'; }
})();
const SITE = 'https://www.luscious.net';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

async function postJson(url, body) {
  if (Http) {
    const r = await Http.request({
      url, method: 'POST', data: body,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      responseType: 'json',
    });
    let data = r.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { throw new Error(`Luscious returned HTTP ${r.status}`); } }
    if (r.status >= 400 && !data?.errors) throw new Error(`Luscious returned HTTP ${r.status}`);
    return data;
  }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!data) throw new Error(`Luscious returned HTTP ${r.status}`);
  return data;
}

async function gql(operationName, query, variables) {
  const json = await postJson(`${API}?operationName=${operationName}`, { id: 1, operationName, query, variables });
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
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
const CARD = 'id title url number_of_pictures number_of_animated_pictures cover { url } tags { text }';
const LIST_QUERY = `query AlbumList($input: AlbumListInput!) {
  album { list(input: $input) {
    info { page has_next_page total_items total_pages }
    items { ... on Album { ${CARD} } }
  } }
}`;
const ALBUM_QUERY = `query AlbumGet($id: ID!) {
  album { get(id: $id) {
    ... on Album { ${CARD} description created_by { name display_name } language { title } genres { title } }
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
  };
}
const errorsOf = (x) => x?.errors?.length && x.errors.map((e) => e.message || e.code).join('; ');

async function albumList(display, filters, page) {
  const data = await gql('AlbumList', LIST_QUERY, { input: { display, filters, page } });
  const list = data?.album?.list;
  if (!list) throw new Error('Could not load albums');
  return { info: list.info, items: (list.items || []).filter((a) => a?.id).map(normAlbum) };
}

export const SORTS = ['date_trending', 'date_newest', 'rating_all_time', 'search_score'];
export function searchAlbums(query, page = 1, sort) {
  const q = String(query || '').trim();
  const display = SORTS.includes(sort) ? sort : q ? 'search_score' : 'date_trending';
  return albumList(display, q ? [{ name: 'search_query', value: q }] : [], page);
}

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
  const r = await Http.request({ url, method: 'GET', responseType: 'blob', headers: { 'User-Agent': UA } });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const type = r.headers?.['Content-Type'] || r.headers?.['content-type'] || 'image/jpeg';
  return `data:${type};base64,${r.data}`;
}

async function downloadBase64(url, retries = 3) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      if (Http) {
        const r = await Http.request({ url, method: 'GET', responseType: 'blob', headers: { 'User-Agent': UA } });
        if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
        return r.data;
      }
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let j = 0; j < buf.length; j += 0x8000) s += String.fromCharCode(...buf.subarray(j, j + 0x8000));
      return btoa(s);
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 600 * 2 ** i));
    }
  }
  throw last;
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

// Where albums are saved. Pictures/ shows up in the phone's gallery; Documents/ is the fallback.
const TARGETS = [
  { directory: 'EXTERNAL_STORAGE', root: 'Pictures/Luscious', label: 'Pictures/Luscious' },
  { directory: 'DOCUMENTS', root: 'Luscious', label: 'Documents/Luscious' },
];

async function exists(path, directory) {
  try { await FS.stat({ path, directory }); return true; } catch { return false; }
}

// Saves every picture of an album into its own folder on the phone. Skips files already saved.
export async function saveAlbum(album, pictures, { onProgress, signal, concurrency = 3 } = {}) {
  if (!FS) throw new Error('Saving to the phone only works in the Android app.');
  try { await FS.requestPermissions?.(); } catch {}
  const folder = `${safeName(album.title)} (${album.id})`;
  let target = null;
  for (const t of TARGETS) {
    try {
      await FS.mkdir({ path: `${t.root}/${folder}`, directory: t.directory, recursive: true }).catch(async (e) => {
        if (!(await exists(`${t.root}/${folder}`, t.directory))) throw e;
      });
      target = t;
      break;
    } catch {}
  }
  if (!target) throw new Error('Could not create a folder on the phone. Check storage permission.');

  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < pictures.length) {
      if (signal?.aborted) return;
      const i = next++;
      const p = pictures[i];
      const path = `${target.root}/${folder}/${fileNameFor(p, i, pictures.length)}`;
      try {
        if (!(await exists(path, target.directory))) {
          const data = await downloadBase64(p.original);
          if (signal?.aborted) return;
          await FS.writeFile({ path, data, directory: target.directory, recursive: true });
        }
      } catch {
        failed++;
      }
      done++;
      onProgress?.({ done, failed, total: pictures.length });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { folder: `${target.label}/${folder}`, failed, cancelled: !!signal?.aborted };
}
