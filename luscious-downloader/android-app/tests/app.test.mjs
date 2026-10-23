// End-to-end tests for Miwaku. Run: npm test (from android-app/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAll, newPage, text } from './harness.mjs';

let env;
before(async () => { env = await startAll(); });
after(async () => { await env?.close(); });

const titles = (page) => page.$$eval('#app .grid .card .t', (els) => els.map((e) => e.textContent));
const noErrors = (page) => assert.deepEqual(page.errors, [], 'no JavaScript errors');

test('first run asks for 18+ and walks through setup', async () => {
  const p = await newPage(env, { onboarded: false });
  await p.goto(env.url);
  await p.waitForSelector('#ageYes');
  assert.match(await text(p, '.ob'), /18\+ only/);
  assert.equal(await p.isVisible('#tabbar'), false, 'no tab bar before setup');
  await p.click('#ageYes');
  await p.waitForSelector('[data-show=gay]');
  assert.equal(await p.isChecked('[data-show=gay]'), false, 'gay hidden by default');
  await p.click('#next');
  await p.waitForSelector('input[name=loc]');
  assert.equal(await p.$eval('input[name=loc]:checked', (e) => e.value), '1', 'SD card chosen by default');
  await p.click('#next');
  await p.click('#start');
  await p.waitForSelector('.ocard', { timeout: 20000 });
  assert.equal(await p.$eval('#tabbar a.on', (a) => a.dataset.tab), 'observe', 'opens on Observe');
  assert.equal(await p.evaluate(() => localStorage.getItem('ldl_onboarded')), 'true');
  noErrors(p);
});

test('under-18 is stopped', async () => {
  const p = await newPage(env, { onboarded: false });
  await p.goto(env.url);
  await p.click('#ageNo');
  assert.match(await text(p, '.ob'), /only for adults/);
  assert.equal(await p.locator('.f-card').count(), 0);
});

test('Hentai tab hides real photos, gay/futa/furry and minor-tagged albums', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/hentai');
  await p.waitForSelector('.card');
  const t = await titles(p);
  assert.ok(t.length >= 10, 'shows albums');
  assert.ok(t.every((x) => x.startsWith('Hentai')), 'only hentai albums');
  for (const hidden of ['Hentai 5', 'Hentai 7', 'Hentai 11', 'Hentai 13']) assert.ok(!t.includes(hidden), `${hidden} is hidden`);
  noErrors(p);
});

test('turning on "gay" in settings shows those albums, but minors stay blocked', async () => {
  const p = await newPage(env, { storage: { ldl_prefs: { show: { gay: true, futa: false, furry: false }, hideTags: [] } } });
  await p.goto(env.url + '#/hentai');
  await p.waitForSelector('.card');
  const t = await titles(p);
  assert.ok(t.includes('Hentai 5') && t.includes('Hentai 11'), 'gay albums visible');
  assert.ok(!t.includes('Hentai 13'), 'minor-tagged album still blocked');
});

test('Art tab filters every planted bad post and respects the Danbooru 2-tag limit', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/art/long_hair%20thighhighs%20smile');
  await p.waitForSelector('.grid.art .thumb', { timeout: 20000 });
  const count = await p.locator('.grid.art .thumb').count();
  assert.ok(count > 0);
  assert.equal(count % 3, 0, 'exactly 3 allowed posts per site page');
  const dan = env.booruHits.filter((h) => h.site === 'danbooru' && h.tags.includes('long_hair'));
  assert.ok(dan.length && dan.every((h) => h.tags.split(' ').filter((t) => !/^-?(rating|order):/.test(t)).length <= 2));
  const gel = env.booruHits.find((h) => h.site === 'gelbooru');
  assert.match(gel.tags, /-loli/, 'minor tags excluded in the query where possible');
  noErrors(p);
});

test('Discover feed: like saves to ♥ Liked and teaches the taste model; dislike moves on', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/feed');
  await p.waitForSelector('.f-card .f-like', { timeout: 20000 });
  await p.click('.f-card[data-i="0"] .f-like');
  await p.waitForTimeout(200);
  const taste = await p.evaluate(() => JSON.parse(localStorage.ldl_taste));
  assert.equal(taste.likes, 1);
  assert.ok(Object.values(taste.w).some((v) => v > 0));
  const boards = await p.evaluate(() => JSON.parse(localStorage.ldl_boards));
  assert.ok(boards.boards.some((b) => b.name === '♥ Liked') && boards.items.length === 1);
  await p.click('.f-card[data-i="0"] .f-like');
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.ldl_taste).likes), 0, 'unlike undoes');
  await p.click('.f-card[data-i="1"] .f-dis');
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.ldl_taste).dislikes), 1);
  noErrors(p);
});

test('viewer study tools, palette and saving to a board', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/album/2');
  await p.waitForSelector('#read');
  await p.click('#read');
  await p.waitForSelector('.r-img');
  await p.waitForTimeout(400);
  await p.mouse.click(205, 450);
  await p.waitForSelector('.reader.menu-open');
  for (const t of ['flip', 'gray', 'grid']) await p.click(`[data-tool=${t}]`);
  const cls = await p.$eval('.reader', (e) => e.className);
  assert.match(cls, /flip/); assert.match(cls, /gray/); assert.match(cls, /grid/);
  await p.click('[data-tool=palette]');
  await p.waitForSelector('.pal button', { timeout: 10000 });
  await p.click('.sheet-wrap', { position: { x: 10, y: 10 } });
  await p.click('[data-tool=board]');
  await p.fill('.newb input', 'Poses');
  await p.click('.newb button');
  await p.waitForSelector('.toast');
  assert.match(await text(p, '.toast'), /Saved to Poses/);
  noErrors(p);
});

test('Refs: body-part search on art sites returns single tagged images', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/refs');
  await p.waitForSelector('.refh');
  await p.click('.chip:has-text("Hands")');
  await p.waitForSelector('.grid.thumbs .thumb', { timeout: 20000 });
  assert.match(await text(p, '#app'), /hand_focus/);
  noErrors(p);
});

test('More like this finds similar images', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/feed');
  await p.waitForSelector('.f-card .f-sim', { timeout: 20000 });
  await p.click('.f-card[data-i="0"] .f-sim');
  await p.waitForSelector('.grid.thumbs .thumb', { timeout: 20000 });
  assert.ok((await p.locator('.grid.thumbs .thumb').count()) > 0);
  noErrors(p);
});

test('sign-in: wrong password shows the site message, right one finds the account', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/login');
  await p.waitForSelector('#loginForm');
  await p.fill('[name=login]', 'bob'); await p.fill('[name=password]', 'nope');
  await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('.err');
  assert.match(await text(p, '.err'), /Wrong username or password/);
  await p.fill('[name=login]', 'bob'); await p.fill('[name=password]', 'pw');
  await p.click('#loginForm button[type=submit]');
  await p.waitForFunction(() => /favorites/.test(document.querySelector('h2')?.textContent || ''), null, { timeout: 15000 });
  assert.equal(JSON.parse(await p.evaluate(() => localStorage.ldl_user)).id, '42');
  noErrors(p);
});

test('connection check reports every site as working', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/check');
  await p.waitForSelector('#copyReport', { timeout: 60000 });
  const failed = await p.$$eval('.check.fail b', (b) => b.map((x) => x.textContent));
  assert.deepEqual(failed, [], 'no failed checks');
  noErrors(p);
});

test('sort options are detected from the site', async () => {
  const p = await newPage(env);
  await p.goto(env.url + '#/hentai');
  await p.waitForFunction(() => document.querySelectorAll('.sortbar .chip').length > 3, null, { timeout: 30000 });
  const sorts = await p.evaluate(() => JSON.parse(localStorage.ldl_sorts).values);
  assert.ok(sorts.includes('rating_30_days') && !sorts.includes('rating_14_days'));
});

// ---------- observation ----------
const DISCOVER = { ldl_observe: { source: 'discover', tag: '', slowMins: 5, memLook: 30, memCount: 2, gesSecs: 30, gesCount: 5, valSecs: 60, valCount: 1 } };

test('slow look: guided steps switch on the right aid, notes are kept, saved to the journal', async () => {
  const p = await newPage(env, { storage: DISCOVER });
  await p.goto(env.url + '#/observe');
  await p.click('[data-go=slow]');
  await p.waitForSelector('.obs .o-title', { timeout: 20000 });
  assert.equal(await text(p, '.o-title'), 'Just look');
  await p.click('[data-c=next]'); // Gesture
  await p.click('[data-c=note]');
  await p.fill('.sheet textarea', 'line of action runs from the head down the left leg');
  await p.click('.sheet button.primary');
  await p.click('[data-c=next]'); // Big shapes
  assert.equal(await text(p, '.o-title'), 'Big shapes');
  assert.match(await p.$eval('.o-img', (i) => i.style.filter), /blur/, 'squint aid on');
  assert.ok(await p.$eval('[data-aid=squint]', (b) => b.classList.contains('on')));
  for (let i = 0; i < 4; i++) await p.click('[data-c=next]'); // Light, Light and shadow, Negative space, Proportions
  assert.equal(await text(p, '.o-title'), 'Proportions');
  assert.ok(await p.$eval('.o-wrap', (w) => w.classList.contains('grid')), 'grid aid on');
  while ((await text(p, '[data-c=next]')) !== 'Finish') await p.click('[data-c=next]');
  assert.ok(await p.$eval('.o-wrap', (w) => w.classList.contains('flip')), 'last step mirrors the image');
  await p.click('[data-c=next]');
  await p.fill('.refl', 'I noticed the shadow shapes only at the end');
  await p.click('[data-done]');
  await p.waitForSelector('#refl', { timeout: 10000 });
  const j = await p.evaluate(() => JSON.parse(localStorage.ldl_journal));
  assert.equal(j[0].type, 'slow');
  assert.equal(j[0].notes[0].step, 'Gesture');
  assert.match(j[0].reflection, /shadow shapes/);
  noErrors(p);
});

test('memory drawing: look, image hides, reveal, rate and note what was missed', async () => {
  const p = await newPage(env, { storage: DISCOVER });
  await p.goto(env.url + '#/observe');
  await p.click('[data-go=memory]');
  await p.waitForSelector('.obs .o-title', { timeout: 20000 });
  assert.equal(await text(p, '.o-title'), 'Memorise');
  assert.equal(await p.isVisible('.o-hidden'), false);
  await p.click('[data-c=next]');
  assert.equal(await text(p, '.o-title'), 'Draw from memory');
  assert.equal(await p.isVisible('.o-hidden'), true, 'image hidden while drawing');
  await p.click('[data-c=reveal]');
  assert.equal(await text(p, '.o-title'), 'Compare');
  await p.click('[data-star="4"]');
  await p.fill('.missed', 'the angle of the hips');
  await p.click('[data-c=next]'); // next image
  assert.match(await text(p, '.o-prog'), /Image 2\/2/);
  await p.click('[data-c=next]'); await p.click('[data-c=reveal]'); await p.click('[data-star="2"]');
  await p.click('[data-c=next]'); // finish
  await p.click('[data-done]');
  await p.waitForSelector('#refl', { timeout: 10000 });
  const j = await p.evaluate(() => JSON.parse(localStorage.ldl_journal));
  assert.equal(j[0].type, 'memory');
  assert.equal(j[0].avgRating, 3);
  assert.equal(j[0].images[0].missed, 'the angle of the hips');
  assert.match(await text(p, '#app'), /What I missed/);
  noErrors(p);
});

test('journal shows time observed and the sessions', async () => {
  const now = Date.now();
  const p = await newPage(env, { storage: { ldl_journal: [
    { id: 'a', at: now, type: 'gesture', seconds: 300, images: [] },
    { id: 'b', at: now - 864e5, type: 'slow', seconds: 600, images: [] },
  ] } });
  await p.goto(env.url + '#/journal');
  await p.waitForSelector('.stats');
  assert.match(await text(p, '.stats'), /5 min\s*today/);
  assert.match(await text(p, '.stats'), /2\s*day streak/);
  assert.equal(await p.locator('.jitem').count(), 2);
});
