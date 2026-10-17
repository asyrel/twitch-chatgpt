// First-run setup: 18+ confirmation, what's hidden, where downloads go, then a quick tour.
import * as N from './native.js';
import { $, app, esc, store } from './util.js';

export const needsOnboarding = () => !store.get('ldl_onboarded', false);

export async function renderOnboarding(ctx, step = 0) {
  document.body.classList.add('onboarding');
  const done = () => {
    store.set('ldl_onboarded', true);
    document.body.classList.remove('onboarding');
    location.hash = '#/feed';
    if (location.hash === '#/feed') ctx.route();
  };
  const dots = (n) => `<div class="ob-dots">${[0, 1, 2, 3].map((i) => `<i class="${i === n ? 'on' : ''}"></i>`).join('')}</div>`;

  if (step === 0) {
    app.innerHTML = `<div class="ob">
      <div class="ob-logo"><img src="icon.png" alt=""></div>
      <h1>Welcome to Miwaku</h1>
      <p class="muted">A reference and inspiration app for NSFW artists: hentai, manga and anime art, with drawing study tools.</p>
      <div class="box ob-age"><b>18+ only</b><p class="small muted">Miwaku shows sexually explicit drawn content. Real-life photos are never shown, and anything involving minors is always blocked.</p></div>
      <button class="primary" id="ageYes">I'm 18 or older</button>
      <button id="ageNo">I'm under 18</button>
      ${dots(0)}</div>`;
    $('#ageYes').onclick = () => renderOnboarding(ctx, 1);
    $('#ageNo').onclick = () => { app.innerHTML = '<div class="ob"><h1>Sorry</h1><p class="muted">Miwaku is only for adults. Please uninstall the app.</p></div>'; };
    return;
  }
  if (step === 1) {
    const p = ctx.prefs();
    app.innerHTML = `<div class="ob">
      <h1>What you see</h1>
      <p class="muted">These are hidden to start with. Turn on anything you want to see. You can change this anytime in Settings.</p>
      <div class="box">
        ${Object.entries(ctx.HIDE_RULES).map(([k, r]) => `<label class="switch"><input type="checkbox" data-show="${k}" ${p.show[k] ? 'checked' : ''}><span>Show ${esc(r.label)}</span></label>`).join('')}
      </div>
      <button class="primary" id="next">Next</button>
      ${dots(1)}</div>`;
    app.querySelectorAll('[data-show]').forEach((c) => (c.onchange = () => { const x = ctx.prefs(); x.show[c.dataset.show] = c.checked; ctx.setPrefs(x); }));
    $('#next').onclick = () => renderOnboarding(ctx, 2);
    return;
  }
  if (step === 2) {
    const vols = N.hasNative ? await N.getVolumes().catch(() => []) : [];
    const sd = vols.find((v) => v.removable);
    app.innerHTML = `<div class="ob">
      <h1>Where to save</h1>
      <p class="muted">Liked images and downloads are saved on your phone, hidden from your Gallery.</p>
      <div class="box">
        ${vols.map((v) => `<label class="switch"><input type="radio" name="loc" value="${v.index}" ${v === (sd || vols[0]) ? 'checked' : ''}><span>${esc(v.label)}${v.removable ? ' (recommended)' : ''}</span></label>`).join('') || '<p class="muted small">Available in the Android app.</p>'}
        ${N.hasNative ? '<button id="pick">Choose a folder instead…</button><p class="muted small">A folder you choose is kept even if you uninstall the app.</p>' : ''}
      </div>
      <button class="primary" id="next">Next</button>
      ${dots(2)}</div>`;
    const setVol = (i) => { const v = vols.find((x) => x.index === +i); if (v) store.set('ldl_storage', { type: 'app', index: v.index, label: `${v.label} (app folder)` }); };
    if (vols.length) setVol((sd || vols[0]).index);
    app.querySelectorAll('input[name=loc]').forEach((r) => (r.onchange = () => setVol(r.value)));
    $('#pick')?.addEventListener('click', async () => {
      try {
        const r = await N.pickFolder();
        if (r?.uri) { store.set('ldl_storage', { type: 'tree', uri: r.uri, label: r.name || 'Chosen folder' }); renderOnboarding(ctx, 3); }
      } catch {}
    });
    $('#next').onclick = () => renderOnboarding(ctx, 3);
    return;
  }
  app.innerHTML = `<div class="ob">
    <h1>How it works</h1>
    <div class="ob-tips">
      <div><i>✨</i><div><b>For You</b><p>Swipe up through images. Tap ♥ or double-tap for more like it; 👎 for less. It learns your taste.</p></div></div>
      <div><i>🔍</i><div><b>Browse</b><p>Hentai and manga from luscious.net, and art from Danbooru, Gelbooru, Yande.re and Konachan.</p></div></div>
      <div><i>📚</i><div><b>Library</b><p>Refs by body part, clothing and pose; your boards, artists, favorites and downloads.</p></div></div>
      <div><i>🖌</i><div><b>Study tools</b><p>Tap the middle of any image: mirror, grayscale, values, grid, palette and color picker.</p></div></div>
    </div>
    <button class="primary" id="start">Start</button>
    ${dots(3)}</div>`;
  $('#start').onclick = done;
}

export function renderHelp() {
  const tip = (t, d) => `<details class="help"><summary>${t}</summary><p>${d}</p></details>`;
  app.innerHTML = `<div class="page-head"><a class="back" href="#/settings">‹</a><h2>Help & tips</h2></div>
    ${tip('How does For You learn?', 'Every image has tags (artist, body type, clothing, pose…). ♥ raises those tags, 👎 lowers them, and looking at an image for a while counts a little. It mixes in new things so it doesn\'t get repetitive. See or change what it learned under “Your taste”.')}
    ${tip('Where are my liked images?', 'Library → Boards → ♥ Liked. They\'re also saved on your phone (Settings → Save downloads to), hidden from the Gallery.')}
    ${tip('How do I use the study tools?', 'Open any image and tap its middle. Flip mirrors it, Gray and Values show light and shadow, Grid helps with proportions (tap again for 4×4 and 6×6), Palette pulls the main colors and Picker reads any spot.')}
    ${tip('Searching the art sites', 'They use exact tags with underscores, e.g. thighhighs, from_behind, long_hair. Danbooru allows 2 tags at a time unless you add your free API key in Settings → Art sites.')}
    ${tip('Gesture practice', 'Library → Boards → Gesture practice. Pick a board or random art, a time per image and a count. Volume keys skip.')}
    ${tip('Something isn\'t loading', 'Run Settings → Connection check and share the report. If luscious.net shows a bot check, use the “Verify on luscious.net” button on the error.')}
    ${tip('Hiding things', 'Settings → Show these: gay, futa and furry are hidden unless you turn them on, and you can add tags to hide. In For You, ⋯ → tap a tag → “Never show this”.')}
    ${tip('Privacy', 'Everything (your taste, boards, notes) stays on your phone. It isn\'t backed up to Google. Downloads are hidden from the Gallery.')}
    <p class="muted small center">Miwaku · 18+ only</p>`;
}
