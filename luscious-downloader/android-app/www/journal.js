// Observation journal: every session (slow look, memory drawing, gesture, value study) with its
// images, notes and ratings, plus totals and a daily streak.
import { $, app, esc, store, imgTag, uid } from './util.js';

const KEY = 'ldl_journal';
export const TYPES = {
  slow: { icon: '👁', name: 'Slow look' },
  memory: { icon: '🧠', name: 'Memory drawing' },
  gesture: { icon: '✏️', name: 'Gesture' },
  values: { icon: '◐', name: 'Value & shape study' },
};
export const entries = () => store.get(KEY, []);

export function addEntry(e) {
  const all = entries();
  const entry = { id: uid(), at: Date.now(), ...e };
  all.unshift(entry);
  store.set(KEY, all.slice(0, 500));
  return entry;
}
export function updateEntry(id, patch) {
  const all = entries();
  const e = all.find((x) => x.id === id);
  if (e) Object.assign(e, patch);
  store.set(KEY, all);
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
export function stats() {
  const all = entries();
  const today = dayKey(Date.now());
  const todaySecs = all.filter((e) => dayKey(e.at) === today).reduce((s, e) => s + (e.seconds || 0), 0);
  const totalSecs = all.reduce((s, e) => s + (e.seconds || 0), 0);
  // Streak: consecutive days (ending today or yesterday) with at least one session.
  const days = new Set(all.map((e) => dayKey(e.at)));
  let streak = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return { todaySecs, totalSecs, sessions: all.length, streak };
}
export const fmtMins = (s) => (!s ? '0 min' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export function renderJournal() {
  const all = entries();
  const s = stats();
  app.innerHTML = `<h2>📓 Journal</h2>
    <div class="stats">
      <div><b>${fmtMins(s.todaySecs)}</b><span>today</span></div>
      <div><b>${s.streak}</b><span>day streak</span></div>
      <div><b>${fmtMins(s.totalSecs)}</b><span>observed</span></div>
      <div><b>${s.sessions}</b><span>sessions</span></div>
    </div>
    ${all.length ? `<div class="jlist">${all.map((e) => `<a class="jitem" href="#/journal/${e.id}">
        <div class="jthumbs">${(e.images || []).slice(0, 3).map((i) => imgTag(i.thumb || i.src)).join('')}</div>
        <div class="jtext"><b>${TYPES[e.type]?.icon || ''} ${esc(TYPES[e.type]?.name || e.type)}</b>
          <span class="muted small">${new Date(e.at).toLocaleDateString()} · ${fmtMins(e.seconds || 0)} · ${(e.images || []).length} image${(e.images || []).length === 1 ? '' : 's'}${e.avgRating ? ` · ★ ${e.avgRating}` : ''}</span>
          ${e.reflection ? `<span class="small">${esc(e.reflection.slice(0, 90))}</span>` : ''}</div></a>`).join('')}</div>`
      : '<div class="box"><h3>No sessions yet</h3><p class="muted small">Start one from 👁 Observe. Everything you notice gets saved here.</p></div>'}`;
}

export function renderEntry(id, ctx) {
  const e = entries().find((x) => x.id === id);
  if (!e) { location.hash = '#/journal'; return; }
  const notes = e.notes || [];
  app.innerHTML = `<div class="page-head"><a class="back" href="#/journal">‹</a><h2>${TYPES[e.type]?.icon || ''} ${esc(TYPES[e.type]?.name || '')}</h2></div>
    <p class="muted small">${new Date(e.at).toLocaleString()} · ${fmtMins(e.seconds || 0)}</p>
    <div class="grid thumbs">${(e.images || []).map((im, i) => `<div class="thumb" data-i="${i}">${imgTag(im.thumb || im.src)}${im.rating ? `<span>★ ${im.rating}</span>` : ''}</div>`).join('')}</div>
    ${notes.length ? `<div class="box"><h3>What I noticed</h3>${notes.map((n) => `<p class="small"><b>${esc(n.step)}</b><br>${esc(n.text)}</p>`).join('')}</div>` : ''}
    ${(e.images || []).some((i) => i.missed) ? `<div class="box"><h3>What I missed</h3>${e.images.filter((i) => i.missed).map((i) => `<p class="small">${esc(i.missed)}</p>`).join('')}</div>` : ''}
    <div class="box"><h3>Reflection</h3><textarea id="refl" rows="3" placeholder="What did you see by the end that you missed at first?">${esc(e.reflection || '')}</textarea></div>
    <div class="row"><button class="primary" id="again">Observe these again</button><button id="delE">Delete</button></div>`;
  $('#refl').oninput = (ev) => updateEntry(id, { reflection: ev.target.value });
  app.querySelectorAll('.thumb').forEach((t) => (t.onclick = () => ctx.openReader({ title: 'Journal', pages: e.images.map((im) => ({ src: im.src, fallback: im.fallback })), start: +t.dataset.i, mode: 'ltr' })));
  $('#again').onclick = () => ctx.startObserve({ type: e.type, images: e.images, opts: e.opts || {} });
  $('#delE').onclick = () => {
    if (!confirm('Delete this journal entry?')) return;
    store.set(KEY, entries().filter((x) => x.id !== id));
    location.hash = '#/journal';
  };
}
