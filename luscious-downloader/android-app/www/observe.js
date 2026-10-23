// Observe: the heart of Miwaku. Pick references, then run an observation session:
// slow look (guided), memory drawing, gesture, or value & shape study. Everything goes to the journal.
import * as B from './boorus.js';
import * as N from './native.js';
import { $, app, esc, store, shuffle, sheet, toast } from './util.js';
import { loadBoards, boardItems, pagesFor, addToBoard } from './boards.js';
import { postHidden } from './art.js';
import { addEntry, updateEntry, stats, fmtMins, TYPES } from './journal.js';

// ---------- what to look for (standard observation practice) ----------
const SLOW_STEPS = [
  { t: 'Just look', d: "Don't analyse yet. Let your eyes wander over the whole image.", w: 0.7 },
  { t: 'Gesture', d: 'Find the line of action: the one long curve running through the whole pose. Trace it with your eyes.', w: 1 },
  { t: 'Big shapes', d: 'Squint. Ignore the details. What are the 3–5 biggest shapes?', aid: 'squint', w: 1 },
  { t: 'Light', d: 'Where is the light coming from? Find the darkest dark and the lightest light.', aid: 'values', w: 1 },
  { t: 'Light and shadow', d: 'Follow the edge where light turns into shadow as it travels across each form.', aid: 'notan', w: 1 },
  { t: 'Negative space', d: 'Look at the shapes between and around the figure, not the figure itself.', aid: 'invert', w: 1 },
  { t: 'Proportions', d: 'Compare sizes. How many heads tall? Where is the halfway point? What lines up vertically?', aid: 'grid', w: 1.2 },
  { t: 'Edges', d: 'Where are edges sharp? Where do they soften or melt into the background?', w: 1 },
  { t: 'Overlaps', d: 'What is in front of what? Where do forms wrap around and overlap each other?', w: 0.8 },
  { t: 'Details', d: 'Only now the details: which small things make this image work?', w: 0.8 },
  { t: 'Fresh eyes', d: 'Mirrored. What looks different now? What did you not notice before?', aid: 'flip', w: 0.6 },
];
const VALUE_STEPS = [
  { t: 'Big shapes', d: 'Squint until the details disappear. How many big shapes are left?', aid: 'squint', w: 1 },
  { t: 'Value groups', d: 'Group everything into four values: light, light-mid, dark-mid and dark.', aid: 'values', w: 1 },
  { t: 'Light vs shadow', d: 'Only two values now. Which shapes are in light and which are in shadow?', aid: 'notan', w: 1 },
];
const GESTURE_STEP = { t: 'Gesture', d: 'Line of action first, then the big rhythm. No details.', w: 1 };
const MEMORY_STEP = { t: 'Memorise', d: "Memorise the line of action, the big shapes and where the darks are. You'll draw it without looking.", w: 1 };

const AIDS = { squint: 'Squint', values: 'Values', notan: 'Light/shadow', invert: 'Negative', grid: 'Grid', flip: 'Flip' };

export const observePrefs = () => ({
  source: 'boards', tag: '', slowMins: 10, memLook: 60, memCount: 3, gesSecs: 60, gesCount: 10, valSecs: 120, valCount: 3,
  ...store.get('ldl_observe', {}),
});
const savePrefs = (p) => store.set('ldl_observe', p);

// ---------- reference pool ----------
async function pickRefs(source, n, ctx) {
  if (source === 'discover') return discover(observePrefs().tag, n, ctx);
  const d = loadBoards();
  const items = source.startsWith('board:') ? boardItems(source.slice(6), d) : d.items;
  if (!items.length) return [];
  const chosen = shuffle(items).slice(0, n);
  const pages = await pagesFor(chosen);
  return chosen.map((it, i) => ({
    key: it.pictureId, src: pages[i].src, fallback: pages[i].fallback || it.large, thumb: it.thumb, title: it.albumTitle,
    album: { id: it.albumId, title: it.albumTitle, author: it.author, authorId: it.authorId, pageUrl: it.pageUrl },
    picture: { id: it.pictureId, original: it.original, large: it.large, thumb: it.thumb },
  }));
}
async function discover(tag, n, ctx) {
  const out = [];
  const seen = new Set();
  for (let tries = 0; tries < 6 && out.length < n; tries++) {
    const r = await B.searchAll(B.enabledSites(), B.booruTag(tag || ''), 1 + Math.floor(Math.random() * 15), 'top');
    for (const x of shuffle(r.items)) {
      if (out.length >= n || seen.has(x.key) || postHidden(x, ctx)) continue;
      seen.add(x.key);
      const { album, picture } = B.asAlbumPicture(x);
      out.push({ key: x.key, src: x.sample || x.original, fallback: x.original, thumb: x.thumb, title: album.title, album, picture });
    }
  }
  return out;
}

// ---------- home ----------
export function renderObserve(ctx) {
  const p = observePrefs();
  const d = loadBoards();
  const s = stats();
  const boards = d.boards.filter((b) => boardItems(b.id, d).length);
  const sources = [['boards', `All my refs (${d.items.length})`], ...boards.map((b) => [`board:${b.id}`, `${b.name} (${boardItems(b.id, d).length})`]), ['discover', 'Discover new refs']];
  if (!sources.some(([k]) => k === p.source) || (p.source === 'boards' && !d.items.length)) p.source = 'discover';
  const chips = (key, vals, fmt) => `<div class="chips wrap mini">${vals.map((v) => `<button data-k="${key}" data-v="${v}" class="${p[key] === v ? 'on' : ''}">${fmt(v)}</button>`).join('')}</div>`;
  const secs = (v) => (v >= 60 ? `${v / 60}m` : `${v}s`);
  app.innerHTML = `
    <div class="obs-head"><h2>👁 Observe</h2><span class="muted small">${fmtMins(s.todaySecs)} today · ${s.streak}🔥</span></div>
    <div class="box">
      <h3>References</h3>
      <select id="src">${sources.map(([k, v]) => `<option value="${esc(k)}" ${k === p.source ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <div id="tagWrap" ${p.source === 'discover' ? '' : 'hidden'}><input id="tag" placeholder="Optional tag, e.g. sitting, hand_focus, from_behind" value="${esc(p.tag)}" autocapitalize="none"></div>
      ${!d.items.length ? '<p class="muted small">You have no saved refs yet, so sessions use new images from the art sites. To use your own, save images to a board: open any image, tap its middle, then ＋ Board.</p><a class="btn" href="#/refs" style="width:100%;margin-top:8px">🔎 Find refs to save</a>' : ''}
    </div>
    <div class="ocard"><div class="ohead"><i>👁</i><div><b>Slow look</b><p>One image, guided step by step: gesture, big shapes, light, negative space, proportions, edges.</p></div></div>
      ${chips('slowMins', [5, 10, 15], (v) => `${v} min`)}<button class="primary go" data-go="slow">Start slow look</button></div>
    <div class="ocard"><div class="ohead"><i>🧠</i><div><b>Memory drawing</b><p>Study an image, it hides, draw it from memory, then compare and note what you missed.</p></div></div>
      ${chips('memLook', [30, 60, 120, 300], (v) => `look ${secs(v)}`)}${chips('memCount', [1, 3, 5], (v) => `${v} image${v > 1 ? 's' : ''}`)}<button class="primary go" data-go="memory">Start memory drawing</button></div>
    <div class="ocard"><div class="ohead"><i>✏️</i><div><b>Gesture</b><p>Quick timed poses. Find the line of action first, then the rhythm.</p></div></div>
      ${chips('gesSecs', [30, 60, 120], secs)}${chips('gesCount', [5, 10, 20], (v) => `${v} poses`)}<button class="primary go" data-go="gesture">Start gesture</button></div>
    <div class="ocard"><div class="ohead"><i>◐</i><div><b>Value & shape study</b><p>Squint, group the values, then light against shadow. Trains you to see big shapes.</p></div></div>
      ${chips('valSecs', [60, 120, 180], secs)}${chips('valCount', [1, 3, 5], (v) => `${v} image${v > 1 ? 's' : ''}`)}<button class="primary go" data-go="values">Start value study</button></div>`;
  $('#src').onchange = (e) => { p.source = e.target.value; savePrefs(p); $('#tagWrap').hidden = p.source !== 'discover'; };
  $('#tag').onchange = (e) => { p.tag = e.target.value.trim(); savePrefs(p); };
  app.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { p[b.dataset.k] = +b.dataset.v; savePrefs(p); renderObserve(ctx); }));
  app.querySelectorAll('[data-go]').forEach((b) => (b.onclick = async () => {
    const type = b.dataset.go;
    const n = type === 'slow' ? 1 : type === 'memory' ? p.memCount : type === 'gesture' ? p.gesCount : p.valCount;
    b.disabled = true; b.textContent = 'Finding references…';
    let images = [];
    try { images = await pickRefs(p.source, n, ctx); } catch {}
    b.disabled = false; b.textContent = `Start ${TYPES[type].name.toLowerCase()}`;
    if (!images.length) return toast(p.source === 'discover' ? "Couldn't find references – check your connection" : 'No refs here yet – save some or pick Discover');
    startObserve({ type, images, opts: { ...p } }, ctx);
  }));
}

// ---------- session player ----------
function planFor(type, opts) {
  if (type === 'slow') {
    const total = (opts.slowMins || 10) * 60;
    const sum = SLOW_STEPS.reduce((s, x) => s + x.w, 0);
    return [SLOW_STEPS.map((x) => ({ ...x, secs: Math.max(20, Math.round((x.w / sum) * total / 5) * 5) }))];
  }
  if (type === 'values') return null; // per image, built below
  return null;
}

let filtersReady = false;
function ensureFilters() {
  if (filtersReady || document.getElementById('obs-values')) { filtersReady = true; return; }
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  d.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">
    <filter id="obs-values" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncR type="discrete" tableValues="0.08 0.38 0.68 0.95"/><feFuncG type="discrete" tableValues="0.08 0.38 0.68 0.95"/><feFuncB type="discrete" tableValues="0.08 0.38 0.68 0.95"/></feComponentTransfer></filter>
    <filter id="obs-notan" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncR type="discrete" tableValues="0.1 0.95"/><feFuncG type="discrete" tableValues="0.1 0.95"/><feFuncB type="discrete" tableValues="0.1 0.95"/></feComponentTransfer></filter>
  </svg>`;
  document.body.appendChild(d);
  filtersReady = true;
}

export function startObserve({ type, images, opts = {} }, ctx) {
  ensureFilters();
  // Build the list of steps for every image.
  const steps = [];
  images.forEach((img, i) => {
    if (type === 'slow') planFor('slow', opts)[0].forEach((s) => steps.push({ ...s, img: i }));
    else if (type === 'values') {
      const each = Math.max(20, Math.round((opts.valSecs || 120) / VALUE_STEPS.length));
      VALUE_STEPS.forEach((s) => steps.push({ ...s, secs: each, img: i }));
    } else if (type === 'gesture') steps.push({ ...GESTURE_STEP, secs: opts.gesSecs || 60, img: i });
    else if (type === 'memory') {
      steps.push({ ...MEMORY_STEP, secs: opts.memLook || 60, img: i, phase: 'look' });
      steps.push({ t: 'Draw from memory', d: 'The image is hidden. Draw what you remember: big shapes first. Tap Reveal when you’re done.', img: i, phase: 'draw', secs: 0 });
      steps.push({ t: 'Compare', d: 'Compare with your drawing. How close was it? What did you miss?', img: i, phase: 'compare', secs: 0 });
    }
  });

  const results = images.map((im) => ({ key: im.key, src: im.src, fallback: im.fallback, thumb: im.thumb, title: im.title }));
  const notes = [];
  let k = 0, left = 0, paused = false, ended = false, elapsed = 0, manualAids = new Set(), timer = null;

  const root = document.createElement('div');
  root.className = 'obs';
  root.innerHTML = `
    <div class="o-stage"><div class="o-wrap"><img class="o-img" alt="" referrerpolicy="no-referrer"><div class="o-grid"></div></div>
      <div class="o-hidden" hidden><div class="o-big">✍️</div><b>Draw from memory</b><span class="o-count"></span></div></div>
    <div class="o-top"><span class="o-prog"></span><span class="o-time"></span></div>
    <div class="o-bar"><div></div></div>
    <div class="o-card">
      <div class="o-step"><b class="o-title"></b><p class="o-desc"></p></div>
      <div class="o-aids">${Object.entries(AIDS).map(([k2, v]) => `<button data-aid="${k2}">${v}</button>`).join('')}</div>
      <div class="o-phase"></div>
      <div class="o-ctrl">
        <button data-c="end" aria-label="End session">✕<span>End</span></button>
        <button data-c="note" aria-label="Write a note">✎<span>Note</span></button>
        <button data-c="pause" aria-label="Pause">⏸<span>Pause</span></button>
        <button data-c="board" aria-label="Save to board">＋<span>Save</span></button>
        <button data-c="next" class="primary" aria-label="Next">Next ›</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('reading');
  const $r = (s) => root.querySelector(s);
  const img = $r('.o-img');
  N.setReading(true, { keepAwake: true, volumeKeys: true, fullscreen: true });
  N.onVolumeKey(() => next());
  history.pushState({ observe: 1 }, '');
  const onPop = () => finish();
  window.addEventListener('popstate', onPop);

  let shownImg = -1;
  function showImage(i) {
    if (shownImg === i) return;
    shownImg = i;
    const im = images[i];
    const urls = [im.src, im.fallback, im.thumb].filter(Boolean);
    let u = 0;
    img.onerror = () => { if (++u < urls.length) img.src = urls[u]; };
    img.src = urls[0];
    const nx = images[i + 1];
    if (nx) { const pre = new Image(); pre.referrerPolicy = 'no-referrer'; pre.src = nx.src; }
  }
  function applyAids(step) {
    const on = new Set(manualAids);
    if (step.aid) on.add(step.aid);
    const f = [];
    if (on.has('squint')) f.push('blur(7px)');
    if (on.has('values')) f.push('url(#obs-values)');
    if (on.has('notan') || on.has('invert')) f.push('url(#obs-notan)');
    if (on.has('invert')) f.push('invert(1)');
    img.style.filter = f.join(' ');
    $r('.o-wrap').classList.toggle('flip', on.has('flip'));
    $r('.o-wrap').classList.toggle('grid', on.has('grid'));
    root.querySelectorAll('[data-aid]').forEach((b) => b.classList.toggle('on', on.has(b.dataset.aid)));
  }
  const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`);
  function render() {
    const st = steps[k];
    const per = steps.filter((s) => s.img === st.img);
    $r('.o-prog').textContent = `${images.length > 1 ? `Image ${st.img + 1}/${images.length} · ` : ''}${type === 'slow' || type === 'values' ? `Step ${per.indexOf(st) + 1}/${per.length}` : TYPES[type].name}`;
    $r('.o-title').textContent = st.t;
    $r('.o-desc').textContent = st.d;
    showImage(st.img);
    const hidden = st.phase === 'draw';
    $r('.o-hidden').hidden = !hidden;
    $r('.o-wrap').style.visibility = hidden ? 'hidden' : 'visible';
    $r('.o-aids').hidden = hidden || st.phase === 'compare';
    const phase = $r('.o-phase');
    if (st.phase === 'draw') phase.innerHTML = '<button class="primary wide" data-c="reveal">Reveal and compare</button>';
    else if (st.phase === 'compare') {
      const r = results[st.img];
      phase.innerHTML = `<div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" class="${r.rating >= n ? 'on' : ''}">★</button>`).join('')}</div>
        <input class="missed" placeholder="What did I miss?" value="${esc(r.missed || '')}">`;
      phase.querySelectorAll('[data-star]').forEach((b) => (b.onclick = () => { r.rating = +b.dataset.star; render(); }));
      phase.querySelector('.missed').oninput = (e) => { r.missed = e.target.value; };
    } else phase.innerHTML = '';
    phase.querySelector('[data-c=reveal]')?.addEventListener('click', next);
    $r('[data-c=next]').textContent = k === steps.length - 1 ? 'Finish' : st.phase === 'compare' ? 'Next image ›' : 'Next ›';
    $r('[data-c=next]').hidden = st.phase === 'draw'; // "Reveal and compare" is the only next step while drawing
    applyAids(st);
    left = st.secs;
    setTime();
  }
  function setTime() {
    const st = steps[k];
    const timed = st.secs > 0;
    $r('.o-time').textContent = timed ? fmt(Math.max(0, left)) : st.phase === 'draw' ? fmt(-left) : '';
    $r('.o-bar div').style.width = timed ? `${(left / st.secs) * 100}%` : '0';
    $r('.o-count').textContent = st.phase === 'draw' ? fmt(-left) : '';
    root.classList.toggle('ending', timed && left <= 5);
  }
  function next() {
    if (ended) return;
    if (k >= steps.length - 1) return finish();
    if (steps[k].secs > 0) navigator.vibrate?.(40);
    k++;
    render();
  }
  timer = setInterval(() => {
    if (paused || ended) return;
    elapsed++;
    left--;
    setTime();
    const st = steps[k];
    if (st.secs > 0 && left <= 0) next();
  }, 1000);

  root.querySelectorAll('[data-aid]').forEach((b) => (b.onclick = () => {
    const a = b.dataset.aid;
    manualAids.has(a) ? manualAids.delete(a) : manualAids.add(a);
    applyAids(steps[k]);
  }));
  root.querySelector('.o-ctrl').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'end') history.back();
    if (c === 'next') next();
    if (c === 'pause') {
      paused = !paused;
      const b = e.target.closest('[data-c]');
      b.innerHTML = paused ? '▶<span>Resume</span>' : '⏸<span>Pause</span>';
      root.classList.toggle('paused', paused);
    }
    if (c === 'note') {
      const st = steps[k];
      const was = paused; paused = true;
      const label = `${images.length > 1 ? `Image ${st.img + 1} · ` : ''}${st.t}`;
      const existing = notes.find((n) => n.step === label);
      const text = await sheet(`<h3>✎ ${esc(label)}</h3><p class="muted small">${esc(st.d)}</p>
        <textarea rows="4" placeholder="What do you notice?">${esc(existing?.text || '')}</textarea><button class="primary" style="width:100%;margin-top:10px">Save note</button>`,
      (el, close) => { const ta = el.querySelector('textarea'); ta.focus(); el.querySelector('button').onclick = () => close(ta.value.trim()); });
      if (text) { if (existing) existing.text = text; else notes.push({ step: label, text }); toast('Noted'); }
      paused = was;
    }
    if (c === 'board') {
      const st = steps[k];
      const im = images[st.img];
      if (!im.album || !im.picture) return;
      const was = paused; paused = true;
      const n = await addToBoard(im.album, im.picture, 0, ctx);
      paused = was;
      if (n) toast(`Saved to ${n}`);
    }
  });

  function finish() {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    window.removeEventListener('popstate', onPop);
    N.onVolumeKey(null);
    N.setReading(false);
    const rated = results.filter((r) => r.rating);
    const entry = addEntry({
      type, seconds: elapsed, opts, notes,
      images: results.map((r, i) => ({ ...r, ...(images[i].album ? {} : {}) })),
      avgRating: rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10 : null,
    });
    root.querySelector('.o-card').innerHTML = `<div class="o-step"><b>Session done · ${fmtMins(elapsed)}</b>
        <p class="o-desc">What did you see by the end that you missed at first?</p></div>
      <textarea class="refl" rows="3" placeholder="Your reflection (saved to the journal)"></textarea>
      <div class="o-ctrl"><button class="primary wide" data-done>Save to journal</button></div>`;
    root.querySelector('.o-top').innerHTML = '';
    root.querySelector('.o-bar').hidden = true;
    img.style.filter = '';
    root.querySelector('.o-hidden').hidden = true;
    root.querySelector('.o-wrap').style.visibility = 'visible';
    root.querySelector('.refl').oninput = (e) => updateEntry(entry.id, { reflection: e.target.value });
    root.querySelector('[data-done]').onclick = () => {
      root.remove();
      document.body.classList.remove('reading');
      if (history.state?.observe) history.back();
      setTimeout(() => (location.hash = `#/journal/${entry.id}`), 50);
    };
  }
  render();
}
