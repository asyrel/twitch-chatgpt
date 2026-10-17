// Sign-in, current user and favorites for luscious.net.
//
// luscious.net has no documented API for these, so this module reads the
// GraphQL schema (introspection) to find the right calls at runtime, and
// falls back to the site's regular login form.
import { gqlRaw, Session, ORIGIN, ALBUM_CARD_FIELDS, normAlbum } from './luscious.js';

// ---------- schema introspection ----------
const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';
const TYPE_QUERY = `query IntrospectType($name: String!) {
  __type(name: $name) {
    name kind
    fields { name args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } }
    inputFields { name type { ${TYPE_REF} } }
    possibleTypes { name }
    enumValues { name }
  }
}`;

const typeCache = new Map();
let rootsCache = null;

async function getType(name) {
  if (!name) return null;
  if (typeCache.has(name)) return typeCache.get(name);
  const json = await gqlRaw('IntrospectType', TYPE_QUERY, { name });
  const t = json.data?.__type || null;
  typeCache.set(name, t);
  return t;
}

async function roots() {
  if (rootsCache) return rootsCache;
  const json = await gqlRaw('IntrospectRoots', 'query IntrospectRoots { __schema { queryType { name } mutationType { name } } }', {});
  const s = json.data?.__schema;
  if (!s) throw new Error('The luscious.net API does not allow schema lookups' + (json.errors ? `: ${json.errors[0].message}` : ''));
  rootsCache = { query: s.queryType?.name, mutation: s.mutationType?.name };
  return rootsCache;
}

const named = (t) => (t?.ofType ? named(t.ofType) : t);
const required = (t) => t?.kind === 'NON_NULL';
function typeString(t) {
  if (t.kind === 'NON_NULL') return typeString(t.ofType) + '!';
  if (t.kind === 'LIST') return `[${typeString(t.ofType)}]`;
  return t.name;
}

// Walks root fields and argument-free "namespace" fields (e.g. album { list }) to find matches.
async function findFields(rootName, match, depth = 2, path = [], seen = new Set()) {
  const type = await getType(rootName);
  if (!type?.fields || seen.has(rootName)) return [];
  seen.add(rootName);
  const out = [];
  for (const f of type.fields) {
    if (f.name.startsWith('__')) continue;
    if (match(f)) out.push({ path: [...path, f.name], field: f });
    const nt = named(f.type);
    if (depth > 1 && nt.kind === 'OBJECT' && f.args.length === 0) {
      out.push(...(await findFields(nt.name, match, depth - 1, [...path, f.name], seen)));
    }
  }
  return out;
}

const SAFE_SCALARS = /^(__typename|id|name|display_name|username|code|message|field|title|url|token|success|ok|status)$/;
async function selectionFor(typeName, depth = 2) {
  const t = await getType(typeName);
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
    if (f.args.some((a) => required(a.type))) continue;
    const nt = named(f.type);
    if ((nt.kind === 'SCALAR' || nt.kind === 'ENUM') && SAFE_SCALARS.test(f.name)) parts.push(f.name);
    else if (depth > 1 && /^(errors|user|me|viewer)$/.test(f.name) && nt.kind !== 'SCALAR') {
      const sel = await selectionFor(nt.name, depth - 1);
      if (sel) parts.push(`${f.name} ${sel}`);
    }
  }
  return `{ ${parts.join(' ')} }`;
}

async function buildOperation(kind, path, field, argValues) {
  const decls = [];
  const callArgs = [];
  const variables = {};
  for (const a of field.args) {
    if (!(a.name in argValues)) continue;
    decls.push(`$${a.name}: ${typeString(a.type)}`);
    callArgs.push(`${a.name}: $${a.name}`);
    variables[a.name] = argValues[a.name];
  }
  const sel = await selectionFor(named(field.type).name);
  let body = `${path[path.length - 1]}${callArgs.length ? `(${callArgs.join(', ')})` : ''} ${sel}`;
  for (let i = path.length - 2; i >= 0; i--) body = `${path[i]} { ${body} }`;
  const opName = 'Ldl' + path.map((p) => p[0].toUpperCase() + p.slice(1)).join('').replace(/\W/g, '');
  return { opName, query: `${kind} ${opName}${decls.length ? `(${decls.join(', ')})` : ''} { ${body} }`, variables };
}

const dig = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);

function collectErrors(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v) => collectErrors(v, out));
    return out;
  }
  if (Array.isArray(value.errors)) value.errors.forEach((e) => out.push(e?.message || e?.code || String(e)));
  if (typeof value.__typename === 'string' && /error/i.test(value.__typename) && !value.errors) out.push(value.message || value.__typename);
  for (const [k, v] of Object.entries(value)) if (k !== 'errors') collectErrors(v, out);
  return out;
}

// ---------- login ----------
function credentialFor(name, username, password) {
  if (/pass/i.test(name)) return password;
  if (/^(login|username|user_name|user|email|name|identifier|login_or_email)$/i.test(name)) return username;
  if (/remember/i.test(name)) return true;
  return undefined;
}

async function argsForLogin(field, username, password) {
  const values = {};
  for (const a of field.args) {
    const nt = named(a.type);
    if (nt.kind === 'INPUT_OBJECT') {
      const it = await getType(nt.name);
      const obj = {};
      for (const f of it?.inputFields || []) {
        const v = credentialFor(f.name, username, password);
        if (v !== undefined) obj[f.name] = v;
        else if (required(f.type)) return null;
      }
      if (!Object.values(obj).includes(password)) return null;
      values[a.name] = obj;
    } else {
      const v = credentialFor(a.name, username, password);
      if (v !== undefined) values[a.name] = v;
      else if (required(a.type)) return null;
    }
  }
  return JSON.stringify(values).includes(JSON.stringify(password)) ? values : null;
}

async function primeCsrf(session) {
  const res = await fetch(ORIGIN + '/', { headers: session.headers(), redirect: 'manual' }).catch(() => null);
  if (res) session.absorb(res);
}

async function loginViaGraphql(session, username, password, log) {
  const { mutation } = await roots();
  if (!mutation) throw new Error('no mutations in schema');
  const candidates = await findFields(mutation, (f) => /^(login|log_in|sign_in|signin|authenticate|token_auth|obtain_token)$/i.test(f.name) || /login/i.test(f.name));
  if (!candidates.length) throw new Error('no login mutation found');
  candidates.sort((a, b) => a.field.name.length - b.field.name.length);
  for (const c of candidates) {
    const args = await argsForLogin(c.field, username, password);
    if (!args) {
      log.push(`skip ${c.path.join('.')}: unknown arguments`);
      continue;
    }
    const op = await buildOperation('mutation', c.path, c.field, args);
    const json = await gqlRaw(op.opName, op.query, op.variables, session);
    const errors = [...(json.errors || []).map((e) => e.message), ...collectErrors(dig(json.data, c.path))];
    log.push(`${c.path.join('.')}: ${errors.length ? errors.join('; ') : 'ok'}`);
    if (errors.length) throw new Error(errors.join('; '));
    const result = dig(json.data, c.path);
    const token = typeof result === 'object' && result && (result.token || result.access_token);
    if (token && !session.loggedIn) session.cookies.__token = token;
    return true;
  }
  throw new Error('no usable login mutation');
}

async function loginViaForm(session, username, password, log) {
  for (const path of ['/accounts/login/', '/login/']) {
    const page = await fetch(ORIGIN + path, { headers: session.headers(), redirect: 'manual' });
    session.absorb(page);
    if (page.status === 404) continue;
    const html = await page.text();
    const token = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)/)?.[1] || session.cookies.csrftoken;
    const form = new URLSearchParams({ login: username, username, email: username, password, remember: 'on' });
    if (token) form.set('csrfmiddlewaretoken', token);
    const res = await fetch(ORIGIN + path, {
      method: 'POST',
      headers: session.headers({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Referer: ORIGIN + path }),
      body: form,
      redirect: 'manual',
    });
    session.absorb(res);
    log.push(`form ${path}: HTTP ${res.status}${session.loggedIn ? ' (session cookie set)' : ''}`);
    if (session.loggedIn) return true;
  }
  throw new Error('login form did not sign in');
}

export async function login(username, password) {
  const session = new Session();
  const log = [];
  await primeCsrf(session);
  let gqlError = null;
  try {
    await loginViaGraphql(session, username, password, log);
  } catch (err) {
    gqlError = err;
    log.push(`graphql login: ${err.message}`);
  }
  if (!session.loggedIn && !session.cookies.__token) {
    try {
      await loginViaForm(session, username, password, log);
    } catch (err) {
      log.push(`form login: ${err.message}`);
    }
  }
  const user = await currentUser(session).catch((e) => (log.push(`current user: ${e.message}`), null));
  if (!user && !session.loggedIn) {
    const reason = gqlError && !/no (usable )?login mutation|no mutations|schema lookups/.test(gqlError.message)
      ? gqlError.message : 'Sign-in failed. Check your username and password.';
    const e = new Error(reason);
    e.log = log;
    throw e;
  }
  return { session, user: user || { id: null, name: username }, log };
}

export async function loginWithCookie(raw) {
  const session = new Session();
  const text = String(raw || '').trim();
  if (text.includes('=')) {
    for (const part of text.split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) session.cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  } else if (text) session.cookies.sessionid = text;
  if (!session.loggedIn) throw new Error('No "sessionid" cookie found in what you pasted.');
  const user = await currentUser(session);
  if (!user) throw new Error('That cookie did not sign in (it may have expired).');
  return { session, user };
}

// ---------- current user ----------
let meField = undefined;
async function findMeField() {
  if (meField !== undefined) return meField;
  const { query } = await roots();
  const found = await findFields(query, (f) =>
    !f.args.some((a) => required(a.type)) &&
    named(f.type).kind === 'OBJECT' &&
    /^(me|viewer|current_user|currentuser|current|whoami|who_am_i|get_current|self|logged_in_user|get_me)$/i.test(f.name));
  meField = found[0] || null;
  return meField;
}

export async function currentUser(session) {
  const f = await findMeField();
  if (!f) return null;
  const op = await buildOperation('query', f.path, f.field, {});
  const json = await gqlRaw(op.opName, op.query, op.variables, session);
  const u = dig(json.data, f.path);
  if (!u || !u.id) return null;
  return { id: String(u.id), name: u.display_name || u.name || u.username || `User ${u.id}` };
}

// ---------- favorites ----------
const ALBUM_LIST_QUERY = `query LdlAlbumList($input: AlbumListInput!) {
  album { list(input: $input) {
    info { page has_next_page total_items total_pages }
    items { ... on Album { ${ALBUM_CARD_FIELDS} } }
  } }
}`;

async function albumList(session, filters, page = 1) {
  const json = await gqlRaw('LdlAlbumList', ALBUM_LIST_QUERY, { input: { display: 'date_newest', filters, page } }, session);
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data.album.list;
}

const strategyCache = new Map(); // user id -> working strategy

async function favoriteFieldStrategies() {
  const { query } = await roots();
  const found = await findFields(query, (f) => /fav/i.test(f.name));
  const out = [];
  for (const c of found) {
    const rt = await getType(named(c.field.type).name);
    const items = rt?.fields?.find((x) => x.name === 'items');
    if (!items) continue;
    const it = await getType(named(items.type).name);
    const albumish = it?.name === 'Album' || it?.possibleTypes?.some((p) => p.name === 'Album');
    if (!albumish) continue;
    out.push({ kind: 'field', path: c.path, field: c.field, hasInfo: rt.fields.some((x) => x.name === 'info') });
  }
  return out;
}

async function runFieldStrategy(s, session, user, page) {
  const args = {};
  for (const a of s.field.args) {
    const nt = named(a.type);
    if (nt.kind === 'INPUT_OBJECT') {
      const it = await getType(nt.name);
      const obj = {};
      for (const f of it?.inputFields || []) {
        if (f.name === 'page') obj.page = page;
        else if (f.name === 'filters') obj.filters = [];
        else if (f.name === 'display') obj.display = 'date_newest';
        else if (/user/.test(f.name) && user?.id) obj[f.name] = user.id;
        else if (required(f.type)) return null;
      }
      args[a.name] = obj;
    } else if (a.name === 'page') args.page = page;
    else if (/user/.test(a.name) && user?.id) args[a.name] = user.id;
    else if (required(a.type)) return null;
  }
  const decls = Object.keys(args).map((k) => `$${k}: ${typeString(s.field.args.find((a) => a.name === k).type)}`);
  const call = Object.keys(args).map((k) => `${k}: $${k}`);
  let body = `${s.path.at(-1)}${call.length ? `(${call.join(', ')})` : ''} {
    ${s.hasInfo ? 'info { page has_next_page total_items total_pages }' : ''}
    items { ... on Album { ${ALBUM_CARD_FIELDS} } } }`;
  for (let i = s.path.length - 2; i >= 0; i--) body = `${s.path[i]} { ${body} }`;
  const q = `query LdlFavorites${decls.length ? `(${decls.join(', ')})` : ''} { ${body} }`;
  const json = await gqlRaw('LdlFavorites', q, args, session);
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  return dig(json.data, s.path);
}

const FILTER_CANDIDATES = [
  ['favorite_by_user_id', 'uid'], ['favorited_by_user_id', 'uid'], ['favorite_by_user', 'uid'],
  ['favorites_of_user_id', 'uid'], ['favorite_user_id', 'uid'], ['user_favorites', 'uid'],
  ['favorited_by', 'uid'], ['favorite_by', 'uid'], ['favorites', 'uid'],
  ['is_favorite', 'true'], ['favorite', 'true'], ['my_favorites', 'true'], ['favorited', 'true'],
];

async function findFilterStrategy(session, user, log) {
  const base = await albumList(session, [], 1);
  const baseTotal = base.info.total_items;
  const baseIds = base.items.map((a) => a?.id).join(',');
  const candidates = [...FILTER_CANDIDATES];
  // If filter names are an enum, the schema tells us exactly which ones exist.
  const input = await getType('AlbumListInput');
  const filterType = await getType(named(input?.inputFields?.find((f) => f.name === 'filters')?.type)?.name);
  const nameEnum = await getType(named(filterType?.inputFields?.find((f) => f.name === 'name')?.type)?.name);
  if (nameEnum?.enumValues) {
    const favs = nameEnum.enumValues.map((v) => v.name).filter((n) => /fav/i.test(n));
    candidates.unshift(...favs.map((n) => [n, /user|by|of/i.test(n) ? 'uid' : 'true']));
  }
  for (const [name, kind] of candidates) {
    if (kind === 'uid' && !user?.id) continue;
    const value = kind === 'uid' ? String(user.id) : 'true';
    try {
      const res = await albumList(session, [{ name, value }], 1);
      const ids = res.items.map((a) => a?.id).join(',');
      const changed = res.info.total_items !== baseTotal || ids !== baseIds;
      log?.push(`filter ${name}=${value}: ${changed ? `${res.info.total_items} albums` : 'ignored'}`);
      if (changed) return { kind: 'filter', name, value };
    } catch (err) {
      log?.push(`filter ${name}: ${err.message}`);
    }
  }
  return null;
}

export async function favorites(session, user, page = 1, log = []) {
  const key = user?.id || 'anon';
  let strategy = strategyCache.get(key);
  if (!strategy) {
    for (const s of await favoriteFieldStrategies().catch((e) => (log.push(`schema: ${e.message}`), []))) {
      try {
        const r = await runFieldStrategy(s, session, user, 1);
        if (r) {
          log.push(`field ${s.path.join('.')}: ok`);
          strategy = s;
          break;
        }
      } catch (err) {
        log.push(`field ${s.path.join('.')}: ${err.message}`);
      }
    }
    if (!strategy) strategy = await findFilterStrategy(session, user, log);
    if (!strategy) {
      const e = new Error("Couldn't find how luscious.net lists favorites.");
      e.log = log;
      throw e;
    }
    strategyCache.set(key, strategy);
  }
  const list = strategy.kind === 'field'
    ? await runFieldStrategy(strategy, session, user, page)
    : await albumList(session, [{ name: strategy.name, value: strategy.value }], page);
  return {
    info: list.info || { page, has_next_page: false, total_items: list.items.length },
    items: (list.items || []).filter((a) => a?.id).map(normAlbum),
  };
}

// ---------- diagnostics ----------
export async function diagnose(session, user) {
  const out = { api: ORIGIN, signedIn: !!session?.loggedIn, user };
  try {
    const r = await roots();
    out.roots = r;
    const interesting = /login|log_in|sign|auth|token|fav|me$|^me|viewer|current|whoami/i;
    out.queryFields = (await findFields(r.query, (f) => interesting.test(f.name))).map((c) => `${c.path.join('.')}(${c.field.args.map((a) => a.name + ':' + typeString(a.type)).join(', ')}): ${typeString(c.field.type)}`);
    if (r.mutation) out.mutationFields = (await findFields(r.mutation, (f) => interesting.test(f.name))).map((c) => `${c.path.join('.')}(${c.field.args.map((a) => a.name + ':' + typeString(a.type)).join(', ')}): ${typeString(c.field.type)}`);
    const input = await getType('AlbumListInput');
    out.albumListInput = input?.inputFields?.map((f) => `${f.name}: ${typeString(f.type)}`);
  } catch (err) {
    out.schemaError = err.message;
  }
  if (session?.loggedIn) {
    const log = [];
    try {
      const fav = await favorites(session, user, 1, log);
      out.favorites = `${fav.info.total_items ?? fav.items.length} albums`;
    } catch (err) {
      out.favorites = err.message;
    }
    out.favoritesLog = log;
  }
  return out;
}
