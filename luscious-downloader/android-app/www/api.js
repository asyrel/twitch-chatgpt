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

// Plain GET returning JSON (used for the art sites). Goes through native HTTP in the app.
export async function getJson(url, headers = {}) {
  const h = { Accept: 'application/json', 'User-Agent': UA, ...headers };
  let status, text;
  if (Http) {
    const r = await Http.request({ url, method: 'GET', headers: h, responseType: 'text' });
    status = r.status;
    text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  } else {
    const r = await fetch(url);
    status = r.status;
    text = await r.text();
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (status >= 400 || (json === null && text)) {
    const msg = json?.message || json?.reason || (text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    throw Object.assign(new Error(`${new URL(url).host}: HTTP ${status}${msg ? ` – ${msg}` : ''}`), { status });
  }
  return json;
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
    const sent = stripFields(query);
    const json = await postJson(`?operationName=${operationName}`, { id: 1, operationName, query: sent, variables });
    if (!json.errors?.length) return json.data;
    const bad = json.errors.map((e) => e.message?.match(/Cannot query field ["'](\w+)["']/)?.[1]).filter(Boolean);
    // Another request may have learned about the bad field while this one was in flight: just retry.
    if (bad.length && stripFields(query) !== sent) continue;
    if (!bad.length || bad.every((f) => unknownFields.has(f))) throw new Error(json.errors.map((e) => e.message).join('; '));
    // Never strip the top-level groups every query relies on; just report the error instead.
    const PROTECTED = ['album', 'picture', 'userprofile', 'user', 'media_categories', 'list', 'get', 'items', 'info', 'id'];
    if (bad.some((f) => PROTECTED.includes(f))) throw new Error(json.errors.map((e) => e.message).join('; '));
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
const CARD = 'id title url number_of_pictures number_of_animated_pictures is_manga cover { url } tags { text category } content { id title } audiences { id title } genres { id title } created_by { id name display_name }';
const LIST_QUERY = `query AlbumList($input: AlbumListInput!) {
  album { list(input: $input) {
    info { page has_next_page total_items total_pages }
    items { ... on Album { ${CARD} } }
  } }
}`;
const ALBUM_QUERY = `query AlbumGet($id: ID!) {
  album { get(id: $id) {
    ... on Album { ${CARD} description language { title } }
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
    authorId: a.created_by?.id != null ? String(a.created_by.id) : null,
    // Artist tags: luscious tags can carry a category ("artist") or be written as "Artist: name".
    artists: [...new Set((a.tags || []).map((t) => (/artist/i.test(t.category || '') ? t.text : (t.text || '').match(/^artists?\s*:\s*(.+)$/i)?.[1])).filter(Boolean).map((x) => x.trim()))],
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

// ---------- sort options ----------
// Known/likely values for AlbumListInput.display. The real list is read from the API when possible.
const SORT_CANDIDATES = [
  'date_trending', 'date_newest', 'date_last_interaction',
  'rating_7_days', 'rating_14_days', 'rating_30_days', 'rating_90_days', 'rating_365_days', 'rating_all_time',
  'view_count_7_days', 'view_count_14_days', 'view_count_30_days', 'view_count_90_days', 'view_count_365_days', 'view_count_all_time',
  'favorites_7_days', 'favorites_30_days', 'favorites_365_days', 'favorites_all_time',
  'search_score',
];
const PERIOD_LABEL = { '1_day': 'Today', '7_days': '7 days', '14_days': '14 days', '30_days': '30 days', '90_days': '3 months', '180_days': '6 months', '365_days': '1 year', all_time: 'All time' };
const KIND_LABEL = { rating: 'Top rated', view_count: 'Most viewed', views: 'Most viewed', favorites: 'Most favorited', likes: 'Most liked', comments: 'Most commented' };

// Splits a display value into { kind, kindLabel, period, periodLabel }.
export function describeSort(v) {
  const simple = { date_trending: 'Trending', date_newest: 'Newest', date_last_interaction: 'Recently active', search_score: 'Best match', date_oldest: 'Oldest' };
  if (simple[v]) return { value: v, kind: v, kindLabel: simple[v], period: null, periodLabel: null };
  const m = v.match(/^([a-z_]+?)_((?:\d+_days?)|all_time|today|week|month|year)$/);
  if (m) {
    const period = m[2];
    return { value: v, kind: m[1], kindLabel: KIND_LABEL[m[1]] || m[1].replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), period, periodLabel: PERIOD_LABEL[period] || period.replace(/_/g, ' ') };
  }
  return { value: v, kind: v, kindLabel: v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), period: null, periodLabel: null };
}

let sortsPromise = null;
// Returns the display values luscious.net accepts, in a sensible order.
export function getSortOptions() {
  if (sortsPromise) return sortsPromise;
  sortsPromise = (async () => {
    try {
      const cached = JSON.parse(ls.get('ldl_sorts') || 'null');
      if (cached && Date.now() - cached.at < 7 * 864e5 && cached.values?.length) return cached.values;
    } catch {}
    let values = null;
    // 1) If "display" is an enum, the schema lists every option.
    try {
      const input = await fullType('AlbumListInput');
      const disp = named(input?.inputFields?.find((f) => f.name === 'display')?.type);
      if (disp?.kind === 'ENUM') values = (await fullType(disp.name))?.enumValues?.map((e) => e.name) || null;
    } catch {}
    // 2) Otherwise try likely values; keep the ones that work and give different results.
    if (!values?.length) {
      const seen = new Map();
      values = [];
      for (const v of SORT_CANDIDATES) {
        if (v === 'search_score') { values.push(v); continue; }
        try {
          const data = await gql('AlbumList', LIST_QUERY, { input: { display: v, filters: [{ name: 'album_type', value: 'pictures' }], page: 1 } });
          const ids = (data?.album?.list?.items || []).map((a) => a?.id).join(',');
          if (!ids) continue;
          if (seen.has(ids) && !['date_trending', 'date_newest', 'rating_all_time'].includes(v)) continue; // silently ignored value
          seen.set(ids, v);
          values.push(v);
        } catch {}
      }
    }
    const order = (v) => { const i = SORT_CANDIDATES.indexOf(v); return i < 0 ? 999 : i; };
    values = [...new Set(values)].sort((a, b) => order(a) - order(b));
    if (values.length) ls.set('ldl_sorts', JSON.stringify({ at: Date.now(), values }));
    return values.length ? values : ['date_trending', 'date_newest', 'rating_all_time', 'search_score'];
  })().catch(() => { sortsPromise = null; return ['date_trending', 'date_newest', 'rating_all_time', 'search_score']; });
  return sortsPromise;
}

// section: 'hentai' | 'real' | 'manga' | null (everything)
export async function listAlbums({ section = null, q = '', sort = '', page = 1, creatorId = null } = {}) {
  q = String(q || '').trim();
  const display = /^[a-z0-9_]+$/.test(sort || '') ? sort : q ? 'search_score' : 'date_trending';
  const filters = [{ name: 'album_type', value: section === 'manga' ? 'manga' : 'pictures' }];
  if (!section) filters.length = 0;
  if (section === 'hentai' || section === 'real') {
    const cats = await getCategories().catch(() => null);
    const ct = cats?.content.find((c) => CONTENT_MATCH[section].test(c.title));
    if (ct) filters.push({ name: 'content_id', value: String(ct.id) });
  }
  if (q) filters.push({ name: 'search_query', value: q });
  if (creatorId) filters.push({ name: 'created_by_id', value: String(creatorId) });
  return albumList(display, filters, page);
}
export const searchAlbums = (q, page, sort) => listAlbums({ q, page, sort });

// Albums uploaded by a user (newest first).
export function userAlbums(userId, page = 1) {
  return albumList('date_newest', [{ name: 'created_by_id', value: String(userId) }], page);
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
    albums: p.number_of_albums ?? null,
  };
}

// ---------- picture-level search (for the reference finder) ----------
const PIC_SEARCH_Q = `query PictureSearch($input: PictureListInput!) {
  picture { list(input: $input) {
    info { page has_next_page total_items }
    items { id title is_animated url_to_original url_to_video thumbnails { width url } tags { text } album { id title } }
  } }
}`;
function normPicture(p) {
  return {
    id: String(p.id), title: p.title || '', animated: !!p.is_animated,
    original: absUrl(p.url_to_video || p.url_to_original),
    large: p.url_to_video ? null : absUrl(largestThumb(p.thumbnails)),
    thumb: absUrl(pickThumb(p.thumbnails) || p.url_to_original),
    tags: (p.tags || []).map((t) => t.text).filter(Boolean),
    album: p.album?.id ? { id: String(p.album.id), title: p.album.title || '' } : null,
  };
}
async function pictureQuery(filters, page, display = 'rating_all_time') {
  const d = await gql('PictureSearch', PIC_SEARCH_Q, { input: { display, filters, page } });
  const list = d?.picture?.list;
  if (!list) throw new Error('no picture list');
  return { info: list.info, items: (list.items || []).filter((x) => x?.id).map(normPicture) };
}
// Which filter (if any) luscious accepts for searching single pictures. Checked once, cached.
let picStrategy = null;
async function pictureStrategy() {
  if (picStrategy) return picStrategy;
  try {
    const c = JSON.parse(ls.get('ldl_picsearch') || 'null');
    if (c && Date.now() - c.at < 7 * 864e5) return (picStrategy = c.s);
  } catch {}
  let base = null;
  try { base = (await pictureQuery([], 1)).items.map((x) => x.id).join(','); } catch {}
  let found = 'none';
  for (const [name, value] of [['search_query', 'stockings'], ['tagged', '+stockings'], ['tagged', 'stockings']]) {
    try {
      const r = await pictureQuery([{ name, value }], 1);
      const ids = r.items.map((x) => x.id).join(',');
      if (ids && ids !== base) { found = `${name}|${value.startsWith('+') ? '+' : ''}`; break; }
    } catch {}
  }
  ls.set('ldl_picsearch', JSON.stringify({ at: Date.now(), s: found }));
  return (picStrategy = found);
}
// Search single pictures by term. Returns null if luscious doesn't support it (use album search instead).
export async function searchPictures(term, page = 1) {
  const s = await pictureStrategy();
  if (s === 'none') return null;
  const [name, prefix] = s.split('|');
  const value = name === 'tagged' ? prefix + term.trim().toLowerCase().replace(/\s+/g, '_') : term;
  return pictureQuery([{ name, value }], page);
}
// First page of an album's pictures (up to ~50), for previews.
export const firstPictures = (albumId) => getAllPictures(albumId, null, 1);

// ---------- signed-in user ----------
// luscious.net doesn't document a "current user" query, so look for one in the API schema.
const TYPE_Q = `query LdlType($name: String!) { __type(name: $name) { name kind fields { name args { name type { kind } } type { kind name ofType { kind name ofType { kind name } } } } } }`;
const named = (t) => (t?.ofType ? named(t.ofType) : t);
async function typeInfo(name) {
  const d = await gql('LdlType', TYPE_Q, { name });
  return d?.__type || null;
}
const ME_NAMES = /^(me|viewer|current_user|currentuser|current|whoami|who_am_i|get_current|self|logged_in_user|get_me)$/i;
export async function currentUser() {
  const root = (await gql('LdlRoots', 'query LdlRoots { __schema { queryType { name } } }', {}))?.__schema?.queryType?.name;
  if (!root) return null;
  const rootType = await typeInfo(root);
  const candidates = [];
  for (const f of rootType?.fields || []) {
    const t = named(f.type);
    if (ME_NAMES.test(f.name) && t?.kind === 'OBJECT') candidates.push({ path: [f.name], type: t.name });
    else if (t?.kind === 'OBJECT' && !f.args.length && /user|account|profile|viewer/i.test(f.name)) {
      const ns = await typeInfo(t.name);
      for (const g of ns?.fields || []) {
        const gt = named(g.type);
        if (ME_NAMES.test(g.name) && gt?.kind === 'OBJECT' && !g.args.some((a) => a.type?.kind === 'NON_NULL')) candidates.push({ path: [f.name, g.name], type: gt.name });
      }
    }
  }
  for (const c of candidates) {
    const t = await typeInfo(c.type);
    const has = new Set((t?.fields || []).map((f) => f.name));
    const sel = ['id', 'name', 'display_name', 'username'].filter((x) => has.has(x));
    const userField = !has.has('id') && has.has('user') ? 'user { id name display_name }' : '';
    if (!sel.length && !userField) continue;
    let body = `${c.path.at(-1)} { ${sel.join(' ')} ${userField} }`;
    for (let i = c.path.length - 2; i >= 0; i--) body = `${c.path[i]} { ${body} }`;
    try {
      const d = await gql('LdlMe', `query LdlMe { ${body} }`, {});
      let u = c.path.reduce((o, k) => o?.[k], d);
      if (u?.user) u = u.user;
      if (u?.id) return { id: String(u.id), name: u.display_name || u.name || u.username || `User ${u.id}` };
    } catch {}
  }
  return null;
}

// ---------- sign in (native form, no browser) ----------
// luscious.net doesn't document its login, so find the login mutation the website uses in the API schema.
const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name } } }';
const FULL_TYPE_Q = `query LdlFullType($name: String!) { __type(name: $name) { name kind
  fields { name args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } }
  inputFields { name type { ${TYPE_REF} } } possibleTypes { name } enumValues { name } } }`;
const typeCache = new Map();
async function fullType(name) {
  if (!name) return null;
  if (!typeCache.has(name)) typeCache.set(name, gql('LdlFullType', FULL_TYPE_Q, { name }).then((d) => d?.__type || null).catch(() => null));
  return typeCache.get(name);
}
const isRequired = (t) => t?.kind === 'NON_NULL';
function typeString(t) {
  if (t.kind === 'NON_NULL') return typeString(t.ofType) + '!';
  if (t.kind === 'LIST') return `[${typeString(t.ofType)}]`;
  return t.name;
}
function credentialFor(name, login, password) {
  if (/pass/i.test(name)) return password;
  if (/^(login|username|user_name|user|email|name|identifier|login_or_email|email_or_username)$/i.test(name)) return login;
  if (/remember/i.test(name)) return true;
  return undefined;
}
async function loginArgs(field, login, password) {
  const values = {};
  for (const a of field.args) {
    const nt = named(a.type);
    if (nt.kind === 'INPUT_OBJECT') {
      const it = await fullType(nt.name);
      const obj = {};
      for (const f of it?.inputFields || []) {
        const v = credentialFor(f.name, login, password);
        if (v !== undefined) obj[f.name] = v;
        else if (isRequired(f.type)) return null;
      }
      values[a.name] = obj;
    } else {
      const v = credentialFor(a.name, login, password);
      if (v !== undefined) values[a.name] = v;
      else if (isRequired(a.type)) return null;
    }
  }
  return JSON.stringify(values).includes(JSON.stringify(password)) ? values : null;
}
const SAFE = /^(__typename|id|name|display_name|username|code|message|field|token|success|ok|status)$/;
async function selectionFor(typeName, depth = 2) {
  const t = await fullType(typeName);
  if (!t || t.kind === 'SCALAR' || t.kind === 'ENUM') return '';
  if (t.kind === 'UNION' || t.kind === 'INTERFACE') {
    const parts = ['__typename'];
    for (const pt of t.possibleTypes || []) {
      const sel = await selectionFor(pt.name, depth);
      if (sel) parts.push(`... on ${pt.name} ${sel}`);
    }
    return `{ ${parts.join(' ')} }`;
  }
  const parts = ['__typename'];
  for (const f of t.fields || []) {
    if (f.args.some((a) => isRequired(a.type))) continue;
    const nt = named(f.type);
    if ((nt.kind === 'SCALAR' || nt.kind === 'ENUM') && SAFE.test(f.name)) parts.push(f.name);
    else if (depth > 1 && /^(errors|user)$/.test(f.name) && nt.kind !== 'SCALAR') {
      const sel = await selectionFor(nt.name, depth - 1);
      if (sel) parts.push(`${f.name} ${sel}`);
    }
  }
  return `{ ${parts.join(' ')} }`;
}
function collectErrors(v, out = []) {
  if (!v || typeof v !== 'object') return out;
  if (Array.isArray(v)) { v.forEach((x) => collectErrors(x, out)); return out; }
  if (Array.isArray(v.errors)) v.errors.forEach((e) => out.push(e?.message || e?.code || String(e)));
  if (v.success === false || v.ok === false) out.push(v.message || 'Sign-in failed');
  for (const [k, x] of Object.entries(v)) if (k !== 'errors') collectErrors(x, out);
  return out;
}
async function loginViaApi(login, password, log) {
  const root = (await gql('LdlRoots2', 'query LdlRoots2 { __schema { mutationType { name } } }', {}))?.__schema?.mutationType?.name;
  if (!root) throw new Error('no mutations');
  const rootType = await fullType(root);
  const candidates = [];
  const isLogin = (n) => /^(login|log_in|sign_in|signin|authenticate|token_auth|obtain_token)$/i.test(n) || /login/i.test(n);
  for (const f of rootType?.fields || []) {
    if (isLogin(f.name)) candidates.push({ path: [f.name], field: f });
    const nt = named(f.type);
    if (nt?.kind === 'OBJECT' && !f.args.length) {
      const ns = await fullType(nt.name);
      for (const g of ns?.fields || []) if (isLogin(g.name)) candidates.push({ path: [f.name, g.name], field: g });
    }
  }
  if (!candidates.length) throw new Error('no login operation found');
  candidates.sort((a, b) => a.field.name.length - b.field.name.length);
  for (const c of candidates) {
    const args = await loginArgs(c.field, login, password);
    if (!args) { log.push(`${c.path.join('.')}: unknown arguments`); continue; }
    const decls = c.field.args.filter((a) => a.name in args).map((a) => `$${a.name}: ${typeString(a.type)}`);
    const call = c.field.args.filter((a) => a.name in args).map((a) => `${a.name}: $${a.name}`);
    let body = `${c.path.at(-1)}(${call.join(', ')}) ${await selectionFor(named(c.field.type).name)}`;
    for (let i = c.path.length - 2; i >= 0; i--) body = `${c.path[i]} { ${body} }`;
    const json = await postJson('?operationName=LdlLogin', { id: 1, operationName: 'LdlLogin', query: `mutation LdlLogin(${decls.join(', ')}) { ${body} }`, variables: args });
    const result = c.path.reduce((o, k) => o?.[k], json.data);
    const errors = [...(json.errors || []).map((e) => e.message), ...collectErrors(result)];
    log.push(`${c.path.join('.')}: ${errors.length ? errors.join('; ') : 'ok'}`);
    if (errors.length) throw Object.assign(new Error(errors[0]), { fromSite: true });
    return true;
  }
  throw new Error('no usable login operation');
}
// Older luscious.net (Django) login form, used if the API has no login operation.
async function loginViaForm(login, password, log) {
  if (!Http) throw new Error('form login needs the app');
  for (const path of ['/accounts/login/', '/login/']) {
    const url = SITE + path;
    const page = await Http.request({ url, method: 'GET', headers: { 'User-Agent': UA }, responseType: 'text' });
    if (page.status === 404) { log.push(`form ${path}: 404`); continue; }
    const html = typeof page.data === 'string' ? page.data : '';
    const token = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)/)?.[1];
    const form = new URLSearchParams({ login, username: login, email: login, password, remember: 'on' });
    if (token) form.set('csrfmiddlewaretoken', token);
    const r = await Http.request({
      url, method: 'POST', data: form.toString(), responseType: 'text',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Origin: SITE, Referer: url },
    });
    log.push(`form ${path}: HTTP ${r.status}`);
    return true;
  }
  throw new Error('no login form');
}

// Signs in with username/email + password. Returns { user } or throws with a readable message.
export async function signIn(login, password, hasSessionCookie) {
  const log = [];
  let apiError = null;
  try { await loginViaApi(login, password, log); } catch (e) { apiError = e; if (!e.fromSite) log.push(`api: ${e.message}`); }
  if (apiError?.fromSite) throw Object.assign(new Error(apiError.message), { details: log });
  if (apiError?.blocked) throw Object.assign(new Error(apiError.message), { details: [...log, ...apiError.details], blocked: true, challenge: apiError.challenge });
  if (apiError && !(await hasSessionCookie())) {
    try { await loginViaForm(login, password, log); } catch (e) { log.push(`form: ${e.message}`); }
  }
  if (!(await hasSessionCookie())) {
    throw Object.assign(new Error('Sign-in failed. Check your username and password.'), { details: log });
  }
  let user = null;
  try { user = await currentUser(); } catch {}
  return { user, details: log };
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

export async function getAllPictures(albumId, onProgress, maxPages = 1000) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
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
