// Full-screen reader for manga and picture albums.
// Paged (left-to-right / right-to-left) with pinch & double-tap zoom, or a continuous long strip.

const PREFS_KEY = 'ldl_reader';
const DEFAULTS = { fit: 'screen', bg: 'black', invertTaps: false, keepAwake: true, preload: 4, showPageNum: true };
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
export function openReader({ title = '', pages, start = 0, mode = 'ltr', onPage, onMode, onClose }) {
  if (active) active.close(true);
  const prefs = readerPrefs();
  const root = document.createElement('div');
  root.className = 'reader';
  root.innerHTML = `
    <div class="r-stage"></div>
    <div class="r-pill"></div>
    <div class="r-menu">
      <div class="r-top">
        <button class="r-close" aria-label="Close">✕</button>
        <div class="r-title">${esc(title)}</div>
      </div>
      <div class="r-bottom">
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

  // Taps: left/right thirds turn pages, middle toggles the menu.
  const tapZone = (x) => {
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
  requestWake();
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
      const urls = [pages[i].src, pages[i].fallback].filter(Boolean);
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
  stage.innerHTML = '<img class="r-img" alt=""><div class="r-msg"></div>';
  const img = stage.querySelector('.r-img');
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
    im.onerror = () => {
      if (pages[i].fallback && im.src !== pages[i].fallback) return (im.src = pages[i].fallback);
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
