// Screenshots of every main screen for design review: node tests/screens.mjs <outdir>
import { startAll, newPage } from './harness.mjs';
const out = process.argv[2] || '.';
const env = await startAll();
const shot = async (p, name, full = true) => { await p.waitForTimeout(500); await p.screenshot({ path: `${out}/${name}.png`, fullPage: full }); };
const OBS = { ldl_observe: { source: 'discover', slowMins: 10, memLook: 60, memCount: 2, gesSecs: 60, gesCount: 5, valSecs: 120, valCount: 1 } };
try {
  let p = await newPage(env, { onboarded: false });
  await p.goto(env.url); await p.waitForSelector('#ageYes'); await shot(p, '01-onboard-age', false);
  await p.click('#ageYes'); await p.click('#next'); await p.waitForSelector('input[name=loc]'); await shot(p, '02-onboard-save', false);
  await p.click('#next'); await shot(p, '03-onboard-tour', false);

  p = await newPage(env);
  await p.goto(env.url + '#/observe'); await p.waitForSelector('.ocard'); await shot(p, '04-observe-empty');
  await p.goto(env.url + '#/boards'); await p.waitForSelector('.libnav'); await shot(p, '05-refs-empty');
  await p.goto(env.url + '#/journal'); await p.waitForSelector('h2'); await shot(p, '06-journal-empty');

  p = await newPage(env, { storage: OBS });
  await p.goto(env.url + '#/art'); await p.waitForSelector('.grid.art .thumb', { timeout: 20000 }); await shot(p, '07-browse-art', false);
  await p.locator('.grid.art .thumb').first().click(); await p.waitForSelector('.r-img'); await p.mouse.click(205, 450); await p.waitForSelector('.reader.menu-open'); await shot(p, '08-viewer-menu', false);
  await p.click('[data-tool=board]'); await p.waitForSelector('.newb'); await shot(p, '09-board-picker', false);
  await p.fill('.newb input', 'Poses'); await p.click('.newb button'); await p.waitForTimeout(400);
  await p.goBack(); await p.goto(env.url + '#/boards'); await p.waitForSelector('.boards'); await shot(p, '10-refs-boards');
  await p.goto(env.url + '#/hentai'); await p.waitForSelector('.card'); await shot(p, '11-browse-hentai', false);
  await p.goto(env.url + '#/album/2'); await p.waitForSelector('#read'); await shot(p, '12-album', false);
  await p.goto(env.url + '#/refs'); await p.waitForSelector('.refh'); await shot(p, '13-find', false);
  await p.goto(env.url + '#/feed'); await p.waitForSelector('.f-card', { timeout: 20000 }); await shot(p, '14-discover', false);
  await p.goto(env.url + '#/observe'); await p.waitForSelector('.ocard'); await shot(p, '15-observe', false);
  await p.click('[data-go=memory]'); await p.waitForSelector('.o-title'); await shot(p, '16-memory-look', false);
  await p.click('[data-c=next]'); await shot(p, '17-memory-draw', false);
  await p.click('[data-c=reveal]'); await p.click('[data-star="3"]'); await shot(p, '18-memory-compare', false);
  await p.click('[data-c=end]'); await p.waitForSelector('.refl'); await shot(p, '19-session-done', false);
  await p.click('[data-done]'); await p.waitForSelector('#refl'); await shot(p, '20-journal-entry');
  await p.goto(env.url + '#/journal'); await p.waitForSelector('.jitem'); await shot(p, '21-journal', false);
  await p.goto(env.url + '#/settings'); await p.waitForSelector('.checkbtn'); await shot(p, '22-settings');
} finally { await env.close(); }
