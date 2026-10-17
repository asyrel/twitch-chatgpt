// Small helpers shared by every screen.
export const $ = (s) => document.querySelector(s);
export const app = document.querySelector('#app');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
export const loading = () => (app.innerHTML = '<div class="center"><div class="spinner"></div></div>');
export const imgTag = (url) => url ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(url)}" data-src="${esc(url)}" alt="">` : '<img alt="">';
export const fmtBytes = (n) => n == null ? '' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Bottom sheet (modal) used for pickers. Resolves with whatever onPick returns, or null if dismissed.
export function sheet(html, setup) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'sheet-wrap';
    el.innerHTML = `<div class="sheet">${html}</div>`;
    document.body.appendChild(el);
    const close = (v = null) => { el.remove(); resolve(v); };
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    setup(el.querySelector('.sheet'), close);
  });
}

export function toast(text, ms = 1800) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}
