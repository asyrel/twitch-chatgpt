import { setReading, onVolumeKey } from './native.js';
import { imageDataUrl } from './api.js';
import { sheet, toast } from './util.js';

// Full-screen reader for manga and picture albums.
// Paged (left-to-right / right-to-left) with pinch & double-tap zoom, or a continuous long strip.

const PREFS_KEY = 'ldl_reader';
const DEFAULTS = { fit: 'screen', bg: 'black', invertTaps: false, keepAwake: true, preload: 4, showPageNum: true, volumeKeys: true, fullscreen: true };
export function readerPrefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
export function saveReaderPrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
}
const BG = { black: '#000', gray: '#2b2b2b', white: '#fff' };
export const MODES = { rtl: 'Right to left', ltr: 'Left to right', webtoon: 'Long strip' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

let active = null;

/**
 * pages: [{ src, fallback? }]  start: page index  mode: 'rtl'|'ltr'|'webtoon'
 * onPage(index), onMode(mode), onClose(index)
 */
export function openReader({ title = '', pages, start = 0, mode = 'ltr', onPage, onMode, onClose, onAddToBoard, onSimilar }) {
  ensureValuesFilter();
  if (active) active.close(true);
  const prefs = readerPrefs();
  const root = document.createElement('div');
  root.className = 'reader';
  root.innerHTML = `
    <div class="r-stage"></div>
    <div class="r-pill"></div>
    <div class="r-swatch" hidden></div>
    <div class="r-menu">
      <div class="r-top">
        <button class="r-close" aria-label="Close">✕</button>
        <div class="r-title">${esc(title)}</div>
      </div>
      <div class="r-bottom">
        <div class="r-tools">
          <button data-tool="flip" title="Mirror">⇋<span>Flip</span></button>
          <button data-tool="gray" title="Grayscale">◐<span>Gray</span></button>
          <button data-tool="values" title="Value study (4 tones)">▤<span>Values</span></button>
          <button data-tool="grid" title="Grid">▦<span class="r-gridlbl">Grid</span></button>
          <button data-tool="palette" title="Color palette">🎨<span>Palette</span></button>
          <button data-tool="picker" title="Pick a color">💧<span>Picker</span></button>
          ${onAddToBoard ? '<button data-tool="board" title="Save to a board">＋<span>Board</span></button>' : ''}
          ${onSimilar ? '<button data-tool="similar" title="More like this">≈<span>Similar</span></button>' : ''}
        </div>
        <div class="r-seek"><span class="r-num"></span><input type="range" min="1" step="1"><span class="r-total"></span></div>
        <div class="r-opts">
          <select class="r-mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <select class="r-fit"><option value="screen">Fit screen</option><option value="width">Fit width</option></select>
          <select class="r-bg"><option value="black">Black</option><option value="gray">Gray</option><option value="white">White</option></select>
          <label class="r-chk"><input type="checkbox" class="r-inv"> Invert taps</label>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('reading');
  const $ = (s) => root.querySelector(s);
  const stage = $('.r-stage');
  const seek = $('.r-seek input');
  seek.max = pages.length;
  $('.r-total').textContent = pages.length;

  let index = clamp(start | 0, 0, pages.length - 1);
  let engine = null;
  let menuOpen = false;
  let wakeLock = null;

  const setMenu = (open) => { menuOpen = open; root.classList.toggle('menu-open', open); };
  const applyBg = () => { root.style.background = BG[prefs.bg] || '#000'; root.classList.toggle('light', prefs.bg === 'white'); };
  const updateUi = () => {
    $('.r-num').textContent = index + 1;
    seek.value = index + 1;
    seek.style.direction = mode === 'rtl' ? 'rtl' : 'ltr';
    $('.r-pill').textContent = `${index + 1} / ${pages.length}`;
    $('.r-pill').hidden = !prefs.showPageNum;
    $('.r-fit').disabled = mode === 'webtoon';
  };
  const pageChanged = (i) => { index = i; updateUi(); onPage?.(i); };

  // ----- drawing study tools -----
  const study = { flip: false, gray: false, values: false, grid: 0, picker: false };
  const GRIDS = [0, 3, 4, 6];
  const applyStudy = () => {
    root.classList.toggle('flip', study.flip);
    root.classList.toggle('gray', study.gray && !study.values);
    root.classList.toggle('values', study.values);
    root.classList.toggle('grid', study.grid > 0);
    root.classList.toggle('picking', study.picker);
    root.style.setProperty('--gn', study.grid || 3);
    $('.r-gridlbl').textContent = study.grid ? `${study.grid}×${study.grid}` : 'Grid';
    root.querySelectorAll('[data-tool]').forEach((b) => {
      const k = b.dataset.tool;
      b.classList.toggle('on', k === 'grid' ? study.grid > 0 : !!study[k]);
    });
    if (!study.picker) $('.r-swatch').hidden = true;
  };
  // The image under a screen point, and where in it (0..1), accounting for mirroring.
  const imageAt = (x, y) => {
    for (const el of root.querySelectorAll('.r-img, .r-cell.ok img')) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width > 0) {
        let nx = (x - r.left) / r.width;
        if (study.flip) nx = 1 - nx;
        return { src: el.currentSrc || el.src, nx, ny: (y - r.top) / r.height };
      }
    }
    return null;
  };
  const currentSrc = () => {
    const el = mode === 'webtoon' ? root.querySelector(`.r-cell[data-i="${index}"] img`) : root.querySelector('.r-img');
    return el?.currentSrc || el?.src || pages[index]?.src;
  };
  async function pickAt(x, y) {
    const hit = imageAt(x, y);
    const sw = $('.r-swatch');
    if (!hit) { sw.hidden = true; return; }
    try {
      const { ctx, w, h } = await pixelsFor(hit.src);
      const d = ctx.getImageData(Math.min(w - 1, Math.floor(hit.nx * w)), Math.min(h - 1, Math.floor(hit.ny * h)), 1, 1).data;
      const hex = toHex(d[0], d[1], d[2]);
      sw.innerHTML = `<i style="background:${hex}"></i><b>${hex}</b><small>${hsvText(d[0], d[1], d[2])}</small>`;
      sw.style.left = `${clamp(x - 70, 8, window.innerWidth - 150)}px`;
      sw.style.top = `${clamp(y - 90, 8, window.innerHeight - 70)}px`;
      sw.hidden = false;
      sw.onclick = (e) => { e.stopPropagation(); copy(hex); };
    } catch {
      toast("Couldn't read this image's colors");
    }
  }
  async function showPalette() {
    try {
      const { ctx, w, h } = await pixelsFor(currentSrc());
      const colors = palette(ctx.getImageData(0, 0, w, h).data, 8);
      await sheet(`<h3>Palette · page ${index + 1}</h3>
        <div class="pal">${colors.map((c) => `<button data-hex="${c.hex}"><i style="background:${c.hex}"></i><b>${c.hex}</b><small>${c.pct}%</small></button>`).join('')}</div>
        <p class="muted small">Tap a color to copy its code.</p>`, (el, close) => {
        el.querySelectorAll('[data-hex]').forEach((b) => (b.onclick = () => { copy(b.dataset.hex); close(); }));
      });
    } catch {
      toast("Couldn't read this image's colors");
    }
  }
  root.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = async () => {
    const k = b.dataset.tool;
    if (k === 'grid') study.grid = GRIDS[(GRIDS.indexOf(study.grid) + 1) % GRIDS.length];
    else if (k === 'palette') return showPalette();
    else if (k === 'similar') return onSimilar(index);
    else if (k === 'board') {
      const r = await onAddToBoard(index);
      if (r) toast(`Saved to ${r}`);
      return;
    } else if (k === 'picker') {
      study.picker = !study.picker;
      if (study.picker) { setMenu(false); toast('Tap the image to pick a color'); }
    } else study[k] = !study[k];
    applyStudy();
    engine.relayout?.();
  }));

  // Taps: left/right thirds turn pages, middle toggles the menu.
  const tapZone = (x, y) => {
    if (study.picker && !menuOpen) {
      const w = window.innerWidth;
      if (x > w * 0.3 && x < w * 0.7 && y > window.innerHeight * 0.85) return setMenu(true);
      return pickAt(x, y);
    }
    if (menuOpen) return setMenu(false);
    const w = window.innerWidth;
    if (x > w * 0.3 && x < w * 0.7) return setMenu(true);
    let forward = x >= w * 0.7;
    if (mode === 'rtl') forward = !forward;
    if (prefs.invertTaps) forward = !forward;
    forward ? engine.next() : engine.prev();
  };

  const startEngine = () => {
    engine?.destroy();
    stage.innerHTML = '';
    engine = (mode === 'webtoon' ? webtoonEngine : pagedEngine)({ stage, pages, start: index, mode, prefs, onChange: pageChanged, onTap: tapZone });
    updateUi();
  };

  $('.r-mode').value = mode;
  $('.r-fit').value = prefs.fit;
  $('.r-bg').value = prefs.bg;
  $('.r-inv').checked = prefs.invertTaps;
  $('.r-mode').onchange = (e) => { mode = e.target.value; onMode?.(mode); startEngine(); };
  $('.r-fit').onchange = (e) => { prefs.fit = e.target.value; saveReaderPrefs(prefs); startEngine(); };
  $('.r-bg').onchange = (e) => { prefs.bg = e.target.value; saveReaderPrefs(prefs); applyBg(); };
  $('.r-inv').onchange = (e) => { prefs.invertTaps = e.target.checked; saveReaderPrefs(prefs); };
  seek.oninput = () => { $('.r-num').textContent = seek.value; };
  seek.onchange = () => engine.goTo(+seek.value - 1);
  $('.r-close').onclick = () => history.back();

  const onKey = (e) => {
    if (e.key === 'Escape') return history.back();
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!fwd && !back) return;
    e.preventDefault();
    const rtlFlip = mode === 'rtl' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft');
    (fwd !== rtlFlip) ? engine.next() : engine.prev();
  };
  const onResize = () => engine.relayout?.();
  const requestWake = async () => {
    if (!prefs.keepAwake || document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  };
  const onVisibility = () => requestWake();
  const onPop = () => close();

  function close(silent) {
    if (active !== api) return;
    active = null;
    engine?.destroy();
    root.remove();
    document.body.classList.remove('reading');
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('visibilitychange', onVisibility);
    wakeLock?.release?.().catch(() => {});
    onVolumeKey(null);
    setReading(false);
    if (!silent) onClose?.(index);
  }
  const api = { close };
  active = api;

  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  history.pushState({ reader: 1 }, '');
  window.addEventListener('popstate', onPop);
  applyBg();
  applyStudy();
  requestWake();
  setReading(true, { keepAwake: prefs.keepAwake, volumeKeys: prefs.volumeKeys, fullscreen: prefs.fullscreen });
  // Volume down = next page, volume up = previous (like most Android manga readers).
  onVolumeKey((dir) => (dir > 0 ? engine.next() : engine.prev()));
  startEngine();
  onPage?.(index);
  return api;
}
export const closeReader = () => active?.close();
export const readerOpen = () => !!active;

// ---------- image loading with cache + fallback ----------
function makeLoader(pages) {
  const cache = new Map();
  function load(i) {
    if (i < 0 || i >= pages.length) return Promise.resolve(null);
    if (cache.has(i)) return cache.get(i);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      const urls = [pages[i].src, pages[i].fallback, pages[i].fallback2].filter(Boolean);
      let k = 0;
      img.onload = () => resolve(img);
      img.onerror = () => (++k < urls.length ? (img.src = urls[k]) : (cache.delete(i), reject(new Error('load failed'))));
      img.src = urls[0];
    });
    p.catch(() => {});
    cache.set(i, p);
    // keep memory bounded
    if (cache.size > 24) for (const key of cache.keys()) { if (Math.abs(key - i) > 10) { cache.delete(key); break; } }
    return p;
  }
  return { load, cache };
}

// ---------- paged engine ----------
function pagedEngine({ stage, pages, start, mode, prefs, onChange, onTap }) {
  const loader = makeLoader(pages);
  stage.classList.add('paged');
  stage.innerHTML = '<div class="r-view"><img class="r-img" alt=""><div class="r-grid"></div></div><div class="r-msg"></div>';
  const img = stage.querySelector('.r-img');
  const grid = stage.querySelector('.r-grid');
  const msg = stage.querySelector('.r-msg');
  let index = start;
  let nw = 1, nh = 1, base = 1, scale = 1, tx = 0, ty = 0, offset = 0;
  let loaded = false;
  let token = 0;

  const W = () => stage.clientWidth;
  const H = () => stage.clientHeight;
  const bounds = (s = scale) => {
    const w = nw * s, h = nh * s;
    return {
      minX: w <= W() ? (W() - w) / 2 : W() - w, maxX: w <= W() ? (W() - w) / 2 : 0,
      minY: h <= H() ? (H() - h) / 2 : H() - h, maxY: h <= H() ? (H() - h) / 2 : 0,
    };
  };
  const apply = (animate) => {
    img.style.transition = animate ? 'transform .2s ease-out' : 'none';
    img.style.transform = `translate(${tx + offset}px, ${ty}px) scale(${scale})`;
    grid.style.transition = img.style.transition;
    grid.style.width = `${nw}px`;
    grid.style.height = `${nh}px`;
    grid.style.transform = img.style.transform;
    grid.style.setProperty('--lw', `${1.25 / scale}px`);
    grid.style.visibility = img.style.visibility;
  };
  const layout = () => {
    if (!loaded) return;
    base = prefs.fit === 'width' ? W() / nw : Math.min(W() / nw, H() / nh);
    scale = base;
    const b = bounds();
    tx = b.minX === b.maxX ? b.minX : 0;
    ty = b.maxY; // top-aligned when taller than the screen
    offset = 0;
    apply(false);
  };

  async function show(i, from = 0) {
    const my = ++token;
    index = i;
    onChange(i);
    loaded = false;
    img.style.visibility = 'hidden';
    grid.style.visibility = 'hidden';
    msg.innerHTML = '<div class="spinner"></div>';
    try {
      const im = await loader.load(i);
      if (my !== token) return;
      img.src = im.src;
      nw = im.naturalWidth || 1; nh = im.naturalHeight || 1;
      loaded = true;
      msg.innerHTML = '';
      layout();
      if (from) { offset = from; apply(false); img.getBoundingClientRect(); offset = 0; apply(true); }
      img.style.visibility = 'visible';
      grid.style.visibility = 'visible';
    } catch {
      if (my !== token) return;
      msg.innerHTML = `<div>Couldn't load page ${i + 1}</div><button class="r-retry">Retry</button>`;
      msg.querySelector('.r-retry').onclick = (e) => { e.stopPropagation(); loader.cache.delete(i); show(i); };
    }
    for (let k = 1; k <= prefs.preload; k++) loader.load(i + k);
    loader.load(i - 1);
  }

  // dir: +1 next, -1 previous. Slides the page out in the reading direction.
  const visualSign = (dir) => (mode === 'rtl' ? dir : -dir);
  function turn(dir) {
    const ni = index + dir;
    if (ni < 0 || ni >= pages.length) {
      offset = 0; apply(true);
      flash(ni < 0 ? 'First page' : 'Last page');
      return;
    }
    const out = visualSign(dir) * W();
    offset = out; apply(true);
    setTimeout(() => show(ni, -out * 0.35), 140);
  }
  let flashTimer;
  function flash(text) {
    msg.innerHTML = `<div class="r-flash">${text}</div>`;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (loaded) msg.innerHTML = ''; }, 900);
  }

  // Fit-width pages taller than the screen scroll down before turning.
  function next() {
    const b = bounds();
    if (loaded && ty > b.minY + 2) { ty = Math.max(b.minY, ty - H() * 0.85); return apply(true); }
    turn(1);
  }
  function prev() {
    const b = bounds();
    if (loaded && ty < b.maxY - 2) { ty = Math.min(b.maxY, ty + H() * 0.85); return apply(true); }
    turn(-1);
  }

  function zoomAt(x, y, target) {
    const s = clamp(target, base, base * 5);
    tx = x - ((x - tx) / scale) * s;
    ty = y - ((y - ty) / scale) * s;
    scale = s;
    const b = bounds();
    tx = clamp(tx, b.minX, b.maxX); ty = clamp(ty, b.minY, b.maxY);
  }

  // ----- gestures -----
  const pts = new Map();
  let gesture = null;
  let lastTap = null;
  let tapTimer = null;

  function down(e) {
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), moved: false, overX: 0 };
    } else if (pts.size === 2 && loaded) {
      const [a, b] = [...pts.values()];
      gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: scale, moved: true };
      offset = 0;
    }
  }
  function move(e) {
    if (!pts.has(e.pointerId) || !gesture) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.kind === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (gesture.mx != null) { tx += mx - gesture.mx; ty += my - gesture.my; }
      gesture.mx = mx; gesture.my = my;
      zoomAt(mx, my, gesture.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0));
      return apply(false);
    }
    if (gesture.kind !== 'pan') return;
    const dx = e.clientX - gesture.lx, dy = e.clientY - gesture.ly;
    gesture.lx = e.clientX; gesture.ly = e.clientY;
    if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 8) gesture.moved = true;
    if (!gesture.moved || !loaded) return;
    const b = bounds();
    // Pan inside the page; whatever goes past the horizontal edge becomes a page swipe.
    const wantX = tx + dx;
    tx = clamp(wantX, b.minX, b.maxX);
    gesture.overX += wantX - tx;
    ty = clamp(ty + dy, b.minY, b.maxY);
    offset = gesture.overX * (scale > base * 1.02 ? 0.5 : 1);
    apply(false);
  }
  function up(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    const g = gesture;
    if (pts.size === 1 && g?.kind === 'pinch') {
      const [p] = [...pts.values()];
      gesture = { kind: 'pan', sx: p.x, sy: p.y, lx: p.x, ly: p.y, t: performance.now(), moved: true, overX: 0 };
      return;
    }
    if (pts.size) return;
    gesture = null;
    if (!g) return;
    if (g.kind === 'pinch') { if (scale < base * 1.02) layout(); return; }
    if (!g.moved) return handleTap(e.clientX, e.clientY);
    const dt = performance.now() - g.t;
    const over = g.overX;
    const fast = Math.abs(over) > 30 && Math.abs(over) / dt > 0.5;
    if (Math.abs(over) > W() * 0.18 || fast) {
      const forward = mode === 'rtl' ? over > 0 : over < 0;
      return turn(forward ? 1 : -1);
    }
    offset = 0; apply(true);
  }
  function handleTap(x, y) {
    const now = performance.now();
    if (lastTap && now - lastTap.t < 280 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
      clearTimeout(tapTimer);
      lastTap = null;
      if (!loaded) return;
      if (scale > base * 1.05) layout();
      else { zoomAt(x, y, base * 2.5); apply(true); }
      return;
    }
    lastTap = { t: now, x, y };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { lastTap = null; onTap(x, y); }, 260);
  }
  const wheel = (e) => { if (!loaded) return; e.preventDefault(); zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); apply(false); };

  const off = new AbortController();
  const signal = off.signal;
  stage.addEventListener('pointerdown', down, { signal });
  stage.addEventListener('pointermove', move, { signal });
  stage.addEventListener('pointerup', up, { signal });
  stage.addEventListener('pointercancel', up, { signal });
  stage.addEventListener('wheel', wheel, { passive: false, signal });
  show(index);

  return {
    next, prev,
    goTo: (i) => show(clamp(i, 0, pages.length - 1)),
    relayout: layout,
    destroy() { token++; clearTimeout(tapTimer); off.abort(); stage.classList.remove('paged'); },
  };
}

// ---------- long strip (webtoon) engine ----------
function webtoonEngine({ stage, pages, start, prefs, onChange, onTap }) {
  const off = new AbortController();
  const signal = off.signal;
  stage.classList.add('strip');
  stage.innerHTML = pages.map((p, i) => `<div class="r-cell" data-i="${i}"><img alt="" data-i="${i}" referrerpolicy="no-referrer"></div>`).join('');
  const cells = [...stage.querySelectorAll('.r-cell')];
  const imgs = cells.map((c) => c.firstElementChild);
  let index = start;

  const load = (i) => {
    const im = imgs[i];
    if (!im || im.dataset.state) return;
    im.dataset.state = 'loading';
    im.onload = () => { im.dataset.state = 'done'; cells[i].classList.add('ok'); };
    const urls = [pages[i].src, pages[i].fallback, pages[i].fallback2].filter(Boolean);
    let k = 0;
    im.onerror = () => {
      if (++k < urls.length) return (im.src = urls[k]);
      im.dataset.state = 'error';
      cells[i].classList.add('err');
      cells[i].onclick = (e) => { e.stopPropagation(); cells[i].classList.remove('err'); delete im.dataset.state; cells[i].onclick = null; load(i); };
    };
    im.src = pages[i].src;
  };

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) {
      const i = +en.target.dataset.i;
      for (let k = i - 1; k <= i + prefs.preload; k++) load(k);
    }
  }, { root: stage, rootMargin: '150% 0px' });
  cells.forEach((c) => io.observe(c));

  let raf = 0;
  let quietUntil = 0; // ignore scroll-derived page changes right after a jump
  const onScroll = () => {
    if (performance.now() < quietUntil) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const mid = stage.getBoundingClientRect().top + stage.clientHeight * 0.25;
      let lo = 0, hi = cells.length - 1;
      while (lo < hi) { // binary search for the cell under the reading line
        const m = (lo + hi) >> 1;
        if (cells[m].getBoundingClientRect().bottom < mid) lo = m + 1; else hi = m;
      }
      if (lo !== index) { index = lo; onChange(lo); }
    });
  };
  stage.addEventListener('scroll', onScroll, { passive: true, signal });

  // Taps (not drags) go to the shared tap handler.
  let downAt = null;
  stage.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY, t: performance.now() }), { signal });
  stage.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const still = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 10 && performance.now() - downAt.t < 350;
    downAt = null;
    if (still) onTap(e.clientX, e.clientY);
  }, { signal });

  const goTo = (i) => {
    i = clamp(i, 0, pages.length - 1);
    for (let k = i - 1; k <= i + prefs.preload; k++) load(k);
    quietUntil = performance.now() + 600;
    cells[i].scrollIntoView({ block: 'start' });
    index = i; onChange(i);
  };
  requestAnimationFrame(() => goTo(start));

  return {
    next: () => stage.scrollBy({ top: stage.clientHeight * 0.8, behavior: 'smooth' }),
    prev: () => stage.scrollBy({ top: -stage.clientHeight * 0.8, behavior: 'smooth' }),
    goTo,
    destroy() { io.disconnect(); off.abort(); cancelAnimationFrame(raf); stage.classList.remove('strip'); },
  };
}

// ---------- color helpers ----------
const toHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
function hsvText(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round(((h * 60) + 360) % 360);
  return `H${h} S${max ? Math.round((d / max) * 100) : 0} V${Math.round((max / 255) * 100)}`;
}
function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast(`Copied ${text}`), () => toast(text));
}

// Pixel access needs a same-origin image, so remote pages are fetched natively first.
const pixelCache = new Map();
function pixelsFor(src) {
  if (!src) return Promise.reject(new Error('no image'));
  if (pixelCache.has(src)) return pixelCache.get(src);
  const p = (async () => {
    const sameOrigin = src.startsWith('data:') || src.startsWith('blob:') || src.startsWith(location.origin);
    const url = sameOrigin ? src : await imageDataUrl(src);
    const im = new Image();
    im.decoding = 'async';
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
    const k = Math.min(1, 900 / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
    ctx.getImageData(0, 0, 1, 1); // throws now if the canvas is tainted
    return { ctx, w, h };
  })();
  p.catch(() => pixelCache.delete(src));
  pixelCache.set(src, p);
  if (pixelCache.size > 6) pixelCache.delete(pixelCache.keys().next().value);
  return p;
}

// Dominant colors with k-means on a sample of pixels (skips near-transparent ones).
function palette(data, k) {
  const px = [];
  const step = Math.max(1, Math.floor(data.length / 4 / 6000));
  for (let i = 0; i < data.length; i += 4 * step) if (data[i + 3] > 128) px.push([data[i], data[i + 1], data[i + 2]]);
  if (!px.length) return [];
  let cents = Array.from({ length: k }, (_, i) => px[Math.floor((i + 0.5) * px.length / k)].slice());
  let counts = new Array(k).fill(0);
  for (let it = 0; it < 10; it++) {
    const sums = cents.map(() => [0, 0, 0]);
    counts = new Array(k).fill(0);
    for (const p of px) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (p[0] - cents[c][0]) ** 2 + (p[1] - cents[c][1]) ** 2 + (p[2] - cents[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2]; counts[best]++;
    }
    cents = cents.map((c, i) => (counts[i] ? sums[i].map((v) => v / counts[i]) : c));
  }
  return cents.map((c, i) => ({ hex: toHex(...c.map((v) => Math.round(v))), n: counts[i] }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((c) => ({ ...c, pct: Math.max(1, Math.round((c.n / px.length) * 100)) }));
}

// SVG filter that reduces an image to 4 gray values (for value/notan studies).
function ensureValuesFilter() {
  if (document.getElementById('ldl-values')) return;
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  d.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><filter id="ldl-values" color-interpolation-filters="sRGB">
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer><feFuncR type="discrete" tableValues="0.08 0.38 0.68 0.95"/><feFuncG type="discrete" tableValues="0.08 0.38 0.68 0.95"/><feFuncB type="discrete" tableValues="0.08 0.38 0.68 0.95"/></feComponentTransfer>
  </filter></svg>`;
  document.body.appendChild(d);
}
