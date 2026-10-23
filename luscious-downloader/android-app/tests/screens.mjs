// Takes screenshots of the main observe screens (for design review): node tests/screens.mjs <outdir>
import { startAll, newPage } from './harness.mjs';
const out = process.argv[2] || '.';
const env = await startAll();
try {
  const p = await newPage(env, { storage: { ldl_observe: { source: 'discover', slowMins: 10, memLook: 60, memCount: 3, gesSecs: 60, gesCount: 10, valSecs: 120, valCount: 3 } } });
  await p.goto(env.url + '#/observe');
  await p.waitForSelector('.ocard');
  await p.screenshot({ path: `${out}/observe.png`, fullPage: true });
  await p.click('[data-go=slow]');
  await p.waitForSelector('.o-title');
  await p.click('[data-c=next]'); await p.click('[data-c=next]');
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/slowlook.png` });
} finally { await env.close(); }
