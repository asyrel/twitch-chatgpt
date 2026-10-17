// On-device taste model: learns which tags you like from ♥ / 👎 in the For You feed.
// Each image is described by its tags; likes raise those tags' weights, dislikes lower them.
import { store } from './util.js';

const KEY = 'ldl_taste';
// Tags that say nothing about the content itself.
const META = /^(highres|absurdres|incredibly_absurdres|lowres|commentary|commentary_request|.*_commentary|.*_request|translated|translation_request|bad_.*|md5_mismatch|tagme|official_art|.*_text|text|signature|watermark|web_address|artist_name|twitter_username|patreon_username|dated|jpeg_artifacts|duplicate|resized|upscaled|third-party_edit|revision|tag|hentai|straight sex|straight_sex)$/;

export const loadTaste = () => ({ w: {}, likes: 0, dislikes: 0, seen: [], ...store.get(KEY, {}) });
const save = (t) => store.set(KEY, t);
export const norm = (tag) => String(tag).trim().toLowerCase().replace(/\s+/g, '_');
export const features = (tags) => [...new Set((tags || []).map(norm).filter((t) => t && !META.test(t)))];

// Learn from a reaction: +1 like, -1 dislike (undo by passing the opposite).
export function learn(tags, dir) {
  const t = loadTaste();
  const f = features(tags);
  if (!f.length) return;
  const step = (dir > 0 ? 1 : 1.25) / Math.sqrt(f.length);
  for (const tag of f) {
    const v = (t.w[tag] || 0) + dir * step;
    t.w[tag] = Math.max(-10, Math.min(10, Math.round(v * 1000) / 1000));
    if (Math.abs(t.w[tag]) < 0.01) delete t.w[tag];
  }
  if (dir > 0) t.likes++; else t.dislikes++;
  save(t);
}

export function markSeen(key) {
  const t = loadTaste();
  if (t.seen.includes(key)) return;
  t.seen.push(key);
  if (t.seen.length > 4000) t.seen = t.seen.slice(-3000);
  save(t);
}

// How much you'd probably like this image (higher = more).
export function score(tags, t = loadTaste()) {
  const f = features(tags);
  if (!f.length) return 0;
  return f.reduce((s, tag) => s + (t.w[tag] || 0), 0) / Math.sqrt(f.length);
}
// Images with a strongly disliked tag are skipped entirely.
export const disliked = (tags, t = loadTaste()) => features(tags).some((tag) => (t.w[tag] || 0) <= -2.5);

// Picks what to search for next: mostly your favourite tags, sometimes something new.
const EXPLORE = ['', '', '', 'smile', 'long_hair', 'thighhighs', 'large_breasts', 'ass', 'lingerie', 'bikini', 'from_behind', 'sitting', 'lying', 'blush', 'nude', 'pussy', 'nipples', 'swimsuit', 'school_uniform', 'maid', 'kimono', 'feet', 'thighs', 'cleavage', 'medium_breasts', 'short_hair', 'ponytail', 'dark_skin', 'muscular_female', 'glasses'];
export function nextQuery() {
  const t = loadTaste();
  const pos = Object.entries(t.w).filter(([, v]) => v > 0.3).sort((a, b) => b[1] - a[1]).slice(0, 40);
  const exploreRate = t.likes < 5 ? 0.7 : t.likes < 30 ? 0.4 : 0.25;
  if (!pos.length || Math.random() < exploreRate) return { tag: EXPLORE[Math.floor(Math.random() * EXPLORE.length)], explore: true };
  const total = pos.reduce((s, [, v]) => s + v ** 1.5, 0);
  let r = Math.random() * total;
  for (const [tag, v] of pos) { r -= v ** 1.5; if (r <= 0) return { tag, explore: false }; }
  return { tag: pos[0][0], explore: false };
}

export function topTags(n = 30) {
  const e = Object.entries(loadTaste().w);
  return {
    liked: e.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n),
    disliked: e.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, n),
  };
}
export function forget(tag) { const t = loadTaste(); delete t.w[tag]; save(t); }
export function resetTaste() { store.set(KEY, { w: {}, likes: 0, dislikes: 0, seen: [] }); }

// Undo a like/dislike (e.g. tapping ♥ again).
export function unlearn(tags, dir) {
  const t = loadTaste();
  const f = features(tags);
  const step = (dir > 0 ? 1 : 1.25) / Math.sqrt(f.length || 1);
  for (const tag of f) {
    const v = (t.w[tag] || 0) - dir * step;
    if (Math.abs(v) < 0.01) delete t.w[tag]; else t.w[tag] = Math.round(v * 1000) / 1000;
  }
  if (dir > 0) t.likes = Math.max(0, t.likes - 1); else t.dislikes = Math.max(0, t.dislikes - 1);
  save(t);
}
// Small, quiet signals: lingering on an image (+) or flicking past it (-).
export function nudge(tags, amount) {
  const t = loadTaste();
  const f = features(tags);
  if (!f.length) return;
  for (const tag of f) {
    const v = (t.w[tag] || 0) + amount / Math.sqrt(f.length);
    t.w[tag] = Math.max(-10, Math.min(10, Math.round(v * 1000) / 1000));
  }
  save(t);
}
// Directly push a tag up or down (from the tag sheet).
export function bump(tag, amount) {
  const t = loadTaste();
  t.w[norm(tag)] = Math.max(-10, Math.min(10, (t.w[norm(tag)] || 0) + amount));
  save(t);
}
