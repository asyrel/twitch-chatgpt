// Artist tracking: follow uploaders (luscious users) or artist tags, see their new albums, keep notes.
import * as L from './api.js';
import { $, app, esc, store, loading } from './util.js';

const KEY = 'ldl_artists';
const list = () => store.get(KEY, []);
const saveList = (l) => store.set(KEY, l);
export const artistKey = (type, id) => `${type}:${id}`;
export const isFollowing = (type, id) => list().some((a) => a.key === artistKey(type, id));
export const artistHref = (type, id, name) => `#/artist/${type}/${encodeURIComponent(id)}/${encodeURIComponent(name || '')}`;

function follow(type, id, name) {
  const l = list();
  if (!l.some((a) => a.key === artistKey(type, id))) l.push({ key: artistKey(type, id), type, id: String(id), name, notes: '', followedAt: Date.now(), seen: [], newCount: 0, lastCheck: 0 });
  saveList(l);
}
function unfollow(type, id) { saveList(list().filter((a) => a.key !== artistKey(type, id))); }
function update(key, patch) {
  const l = list();
  const a = l.find((x) => x.key === key);
  if (a) Object.assign(a, patch);
  saveList(l);
  return a;
}
// Notes are kept even for artists you don't follow.
const notesOf = (key) => store.get('ldl_artist_notes', {})[key] || '';
function setNotes(key, text) {
  const all = store.get('ldl_artist_notes', {});
  if (text.trim()) all[key] = text; else delete all[key];
  store.set('ldl_artist_notes', all);
}

// First page of an artist's albums, newest first.
function fetchAlbums(type, id, name, page = 1) {
  if (type === 'user') return L.userAlbums(id, page);
  return L.listAlbums({ q: name || id, sort: 'date_newest', page }); // artist tags: search by name
}

// Updates "new album" counts for followed artists (at most every 30 minutes each).
export async function checkNew(force = false) {
  const l = list();
  let changed = false;
  await Promise.all(l.map(async (a) => {
    if (!force && Date.now() - (a.lastCheck || 0) < 30 * 60e3) return;
    try {
      const res = await fetchAlbums(a.type, a.id, a.name);
      const ids = res.items.map((x) => x.id);
      if (!a.seen?.length) a.seen = ids; // first check: everything counts as seen
      a.newCount = ids.filter((x) => !a.seen.includes(x)).length;
      a.lastCheck = Date.now();
      changed = true;
    } catch {}
  }));
  if (changed) {
    const fresh = list();
    for (const a of l) { const f = fresh.find((x) => x.key === a.key); if (f) Object.assign(f, { seen: a.seen, newCount: a.newCount, lastCheck: a.lastCheck }); }
    saveList(fresh);
  }
  return list().reduce((n, a) => n + (a.newCount || 0), 0);
}

export function renderArtists(ctx) {
  const l = list().sort((a, b) => (b.newCount || 0) - (a.newCount || 0) || a.name.localeCompare(b.name));
  const draw = () => {
    const cur = list().sort((a, b) => (b.newCount || 0) - (a.newCount || 0) || a.name.localeCompare(b.name));
    app.innerHTML = `${ctx.libraryNav('artists')}
      ${cur.length ? `<div class="list">${cur.map((a) => `<a class="item artist-row" href="${artistHref(a.type, a.id, a.name)}">
        <span><b>${esc(a.name)}</b> <span class="muted small">${a.type === 'user' ? 'uploader' : 'artist tag'}</span>
        ${notesOf(a.key) ? `<br><span class="muted small">${esc(notesOf(a.key).slice(0, 80))}</span>` : ''}</span>
        ${a.newCount ? `<span class="newbadge">${a.newCount} new</span>` : '<span class="muted small">›</span>'}</a>`).join('')}</div>
        <div class="center"><button id="refreshA">Check for new albums</button></div>`
      : `<div class="box"><h3>No artists followed yet</h3><p class="muted small">Open an album and tap the uploader's name or an artist tag, then tap <b>Follow</b>. You'll see their new albums here, and you can keep notes on their style.</p></div>`}`;
    $('#refreshA')?.addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'Checking…'; await checkNew(true); draw(); });
  };
  draw();
  if (l.length) checkNew().then(draw);
}

export async function renderArtist(type, id, name, ctx) {
  const key = artistKey(type, id);
  let profile = null;
  let page = 0, hasNext = true;
  const items = [];
  const followed = list().find((a) => a.key === key);
  const seenBefore = new Set(followed?.seen || []);
  loading();
  if (type === 'user') {
    try { profile = await L.getProfile(id); name = profile.name || name; } catch {}
  }
  const loadMore = async () => {
    page++;
    const res = await fetchAlbums(type, id, name, page);
    hasNext = !!res.info?.has_next_page && res.items.length > 0;
    for (const a of res.items) if (!ctx.hiddenReason(a) && !items.some((x) => x.id === a.id)) items.push(a);
    draw();
  };
  const draw = () => {
    const following = isFollowing(type, id);
    app.innerHTML = `
      <div class="artist-head">
        <div style="min-width:0">
          <h2 style="margin:0">${esc(name || id)}</h2>
          <div class="muted small">${type === 'user' ? `Uploader${profile ? ` · ${profile.albums ?? '?'} albums` : ''}` : 'Artist tag (albums found by search)'}</div>
        </div>
        <button id="followBtn" class="${following ? '' : 'primary'}">${following ? '✓ Following' : '＋ Follow'}</button>
      </div>
      <label class="muted small" style="display:block;margin:10px 0 4px">My notes (style, what to study, favorite works)</label>
      <textarea id="notes" rows="2" placeholder="e.g. great hands and fabric folds, soft cel shading">${esc(notesOf(key))}</textarea>
      <h2 style="margin-top:14px">Albums</h2>
      ${items.length ? `<div class="grid">${items.map((a) => ctx.card(a).replace('<div class="cover">', `<div class="cover">${followed && !seenBefore.has(a.id) && seenBefore.size ? '<span class="badge new">NEW</span>' : ''}`)).join('')}</div>` : '<p class="muted">No albums found.</p>'}
      ${hasNext ? '<div class="center"><button id="moreA">Load more</button></div>' : ''}`;
    $('#followBtn').onclick = () => { isFollowing(type, id) ? unfollow(type, id) : follow(type, id, name); draw(); };
    const notes = $('#notes');
    notes.oninput = () => setNotes(key, notes.value);
    $('#moreA')?.addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'Loading…'; await loadMore(); });
  };
  try {
    await loadMore();
  } catch (e) {
    ctx.showError(e);
    return;
  }
  // Viewing an artist marks their current albums as seen.
  if (followed) update(key, { seen: [...new Set([...(followed.seen || []), ...items.map((a) => a.id)])], newCount: 0, name: name || followed.name });
}
