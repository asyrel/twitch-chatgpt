// Fake Danbooru / Gelbooru / Yande.re / Konachan APIs for tests.
// Each page plants things the app must never show: a loli-tagged post, a yaoi post, a real photo,
// a safe-for-work post and a video.
import http from 'node:http';

export function startBooru(port) {
  const base = `http://127.0.0.1:${port}`;
  const hits = [];
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const SPECIAL = ['loli smile', 'yaoi 2boys', 'photo_(medium) cosplay', 'thighhighs smile', 'long_hair hand_focus', 'sitting'];
  function posts(site, page) {
    const out = [];
    for (let i = 0; i < 13; i++) {
      const id = page * 100 + i;
      const rating = i === 9 ? 'g' : i % 2 ? 'e' : 'q';
      const img = `${base}/img/${site}_${id}.${i === 8 ? 'mp4' : 'png'}`;
      // 10–12: planted low-quality posts (AI image, very low score, tiny image)
      const tags = i === 10 ? 'ai-generated smile' : i >= 11 ? 'smile' : SPECIAL[i % 6];
      const score = i === 11 ? 1 : 100 - i;
      const w = i === 12 ? 300 : 800, h = i === 12 ? 400 : 1200;
      if (site === 'danbooru') out.push({ id, file_url: img, large_file_url: img, preview_file_url: img, tag_string: tags, tag_string_artist: 'artist_' + (i % 3), rating: i >= 10 ? 'e' : rating, image_width: w, image_height: h, score });
      else out.push({ id, file_url: img, sample_url: img, preview_url: img, tags, rating: i >= 10 ? (site === 'gelbooru' ? 'explicit' : 'e') : site === 'gelbooru' ? { e: 'explicit', q: 'questionable', g: 'general' }[rating] : rating === 'g' ? 's' : rating, width: w, height: h, score });
    }
    return out;
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, base);
    if (u.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    const site = u.searchParams.get('site');
    const tags = u.searchParams.get('tags') || '';
    hits.push({ site, tags });
    const normal = tags.split(' ').filter((t) => t && !/^-?(rating|order):/.test(t));
    if (site === 'danbooru' && normal.length > 2) { res.writeHead(422, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: false, message: 'You cannot search for more than 2 tags at a time.' })); }
    const page = site === 'gelbooru' ? +u.searchParams.get('pid') + 1 : +u.searchParams.get('page') || 1;
    const body = site === 'gelbooru' ? { '@attributes': { count: 99 }, post: posts(site, page) } : posts(site, page);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, hits })));
}
