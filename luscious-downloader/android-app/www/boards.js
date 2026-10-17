// Reference boards: single pages saved into named collections (e.g. "Poses", "Lighting").
// Each saved page keeps a link to its source album/uploader and is stored on the phone for offline use.
import * as L from './api.js';
import * as N from './native.js';
import { $, app, esc, store, imgTag, uid, sheet, toast } from './util.js';

const KEY = 'ldl_boards';
const BOARD_FOLDER = '_Reference boards';
export const loadBoards = () => ({ boards: [], items: [], ...store.get(KEY, {}) });
const saveBoardsData = (d) => store.set(KEY, d);
export const boardItems = (id, d = loadBoards()) => d.items.filter((i) => i.boardId === id).sort((a, b) => b.addedAt - a.addedAt);

function createBoard(name) {
  const d = loadBoards();
  const b = { id: uid(), name: name.trim() || 'Untitled', created: Date.now() };
  d.boards.push(b);
  saveBoardsData(d);
  return b;
}

// Bottom sheet to choose (or create) a board. Resolves with the board or null.
export function pickBoard(title = 'Save to board') {
  const d = loadBoards();
  const last = store.get('ldl_last_board', null);
  const boards = [...d.boards].sort((a, b) => (b.id === last) - (a.id === last) || a.name.localeCompare(b.name));
  return sheet(`<h3>${esc(title)}</h3>
    ${boards.map((b) => `<button class="opt" data-b="${b.id}"><span>${esc(b.name)}</span><span class="muted small">${boardItems(b.id, d).length}</span></button>`).join('')}
    <form class="newb row" style="margin-top:8px"><input name="n" placeholder="New board name (e.g. Poses)" autocomplete="off" style="flex:1"><button class="primary">Create</button></form>`,
  (el, close) => {
    el.querySelectorAll('[data-b]').forEach((btn) => (btn.onclick = () => close(d.boards.find((b) => b.id === btn.dataset.b))));
    el.querySelector('.newb').onsubmit = (e) => {
      e.preventDefault();
      const n = new FormData(e.target).get('n');
      if (String(n).trim()) close(createBoard(String(n)));
    };
  }).then((b) => { if (b) store.set('ldl_last_board', b.id); return b; });
}

const fileStem = (it) => `${it.albumId}_${it.pictureId}`;
function fileNameFor(it) {
  let ext = '.jpg';
  try { ext = (new URL(it.original).pathname.match(/\.[a-z0-9]{2,5}$/i) || ['.jpg'])[0].toLowerCase(); } catch {}
  return fileStem(it) + ext;
}

// Saves a board picture to the phone in the background (so boards work offline).
async function storeOffline(item, ctx) {
  if (!N.hasNative) return;
  try {
    const target = await ctx.getTarget();
    if (!target) return;
    const r = await N.downloadAlbum({
      target, folder: BOARD_FOLDER, title: 'Reference boards', jobId: `board-${item.id}`,
      files: [{ url: item.original, fallback: item.large || '', name: fileNameFor(item) }],
      compress: L.COMPRESSION[ctx.compression()]?.compress || null, userAgent: L.UA,
    });
    if (!r.failed) {
      const d = loadBoards();
      const it = d.items.find((x) => x.id === item.id);
      if (it) { it.target = target; saveBoardsData(d); }
    }
  } catch {}
}

// Adds one picture of an album to a board the user picks. Returns the board name, or null.
export async function addToBoard(album, picture, index, ctx) {
  const board = await pickBoard();
  if (!board) return null;
  const d = loadBoards();
  if (d.items.some((i) => i.boardId === board.id && i.pictureId === picture.id && i.albumId === album.id)) return board.name;
  const item = {
    id: uid(), boardId: board.id, addedAt: Date.now(),
    albumId: album.id, albumTitle: album.title, author: album.author, authorId: album.authorId,
    page: index, pictureId: picture.id, original: picture.original, large: picture.large || null, thumb: picture.thumb,
  };
  d.items.push(item);
  saveBoardsData(d);
  storeOffline(item, ctx);
  return board.name;
}

// Files saved for boards, by name stem -> local URL.
async function localMap() {
  const d = loadBoards();
  const t = d.items.find((i) => i.target)?.target;
  if (!t || !N.hasNative) return new Map();
  try {
    const r = await N.listAlbum(t, BOARD_FOLDER);
    return new Map((r?.files || []).map((f) => [f.name.replace(/\.[a-z0-9]{2,5}$/i, ''), N.fileSrc(f.uri)]));
  } catch { return new Map(); }
}

// Reader pages for a list of board items (offline copy first, then the site).
export async function pagesFor(items) {
  const local = await localMap();
  return items.map((it) => {
    const l = local.get(fileStem(it));
    return l ? { src: l, fallback: it.original, fallback2: it.large } : { src: it.original, fallback: it.large };
  });
}

// ---------- screens ----------
export function renderBoards(ctx) {
  const d = loadBoards();
  app.innerHTML = `${ctx.libraryNav('boards')}
    <div class="row" style="margin-top:0"><button class="primary" id="newBoard">＋ New board</button><a class="btn" href="#/practice">✏️ Gesture practice</a></div>
    ${d.boards.length ? `<div class="grid boards">${d.boards.map((b) => {
      const items = boardItems(b.id, d);
      const covers = items.slice(0, 4).map((i) => imgTag(i.thumb)).join('');
      return `<a class="card" href="#/board/${b.id}"><div class="bcover n${Math.min(items.length, 4)}">${covers || '<div class="bempty">🎨</div>'}</div>
        <div class="t">${esc(b.name)}</div><div class="n">${items.length} image${items.length === 1 ? '' : 's'}</div></a>`;
    }).join('')}</div>`
    : `<div class="box"><h3>No boards yet</h3><p class="muted small">Open any album, tap the middle of a page for the menu, then tap <b>＋ Board</b> to save that page. Make boards like “Poses”, “Hands”, “Lighting” or “Color”.</p></div>`}`;
  $('#newBoard').onclick = async () => {
    const name = prompt('Board name (e.g. Poses, Hands, Lighting)');
    if (name && name.trim()) { createBoard(name); renderBoards(ctx); }
  };
}

export async function renderBoard(id, ctx) {
  const d = loadBoards();
  const b = d.boards.find((x) => x.id === id);
  if (!b) { location.hash = '#/boards'; return; }
  const items = boardItems(id, d);
  let editing = false;
  const draw = () => {
    app.innerHTML = `${ctx.libraryNav('boards')}
      <div class="row" style="margin-top:0;justify-content:space-between">
        <h2 style="margin:0">${esc(b.name)} <span class="muted">(${items.length})</span></h2>
        <button id="editB">${editing ? 'Done' : 'Edit'}</button>
      </div>
      <div class="row">
        ${items.length ? `<a class="btn primary" href="#/practice/board/${b.id}">✏️ Practice with this board</a>` : ''}
        ${editing ? '<button id="renameB">Rename</button><button id="deleteB">Delete board</button>' : ''}
      </div>
      ${editing ? '<p class="muted small">Tap an image for options.</p>' : ''}
      ${items.length ? `<div class="grid thumbs">${items.map((it, i) => `<div class="thumb ${editing ? 'editing' : ''}" data-i="${i}">${imgTag(it.thumb)}${editing ? '<span>⋯</span>' : ''}</div>`).join('')}</div>`
        : '<p class="muted">Nothing here yet. Save pages from the reader with ＋ Board.</p>'}`;
    $('#editB').onclick = () => { editing = !editing; draw(); };
    $('#renameB')?.addEventListener('click', () => {
      const n = prompt('Rename board', b.name);
      if (n && n.trim()) { const dd = loadBoards(); dd.boards.find((x) => x.id === id).name = n.trim(); saveBoardsData(dd); b.name = n.trim(); draw(); }
    });
    $('#deleteB')?.addEventListener('click', () => {
      if (!confirm(`Delete the board “${b.name}” and its ${items.length} saved images?`)) return;
      const dd = loadBoards();
      dd.boards = dd.boards.filter((x) => x.id !== id);
      dd.items = dd.items.filter((x) => x.boardId !== id);
      saveBoardsData(dd);
      location.hash = '#/boards';
    });
    app.querySelectorAll('.thumb').forEach((t) => (t.onclick = async () => {
      const i = +t.dataset.i;
      if (!editing) return openBoardReader(b, items, i, ctx);
      const it = items[i];
      await sheet(`<h3>${esc(it.albumTitle || 'Image')}</h3>
        <p class="muted small">Page ${it.page + 1}${it.author ? ` · by ${esc(it.author)}` : ''}</p>
        <button class="opt" data-a="open">Open source album</button>
        ${it.authorId ? '<button class="opt" data-a="artist">Open uploader</button>' : ''}
        <button class="opt" data-a="move">Move to another board</button>
        <button class="opt" data-a="remove" style="color:#ff7b9c">Remove from board</button>`, (el, close) => {
        el.querySelectorAll('[data-a]').forEach((btn) => (btn.onclick = async () => {
          const a = btn.dataset.a;
          close();
          const dd = loadBoards();
          if (a === 'open') location.hash = `#/album/${it.albumId}`;
          if (a === 'artist') location.hash = `#/artist/user/${it.authorId}/${encodeURIComponent(it.author || '')}`;
          if (a === 'remove') { dd.items = dd.items.filter((x) => x.id !== it.id); saveBoardsData(dd); items.splice(i, 1); draw(); }
          if (a === 'move') {
            const nb = await pickBoard('Move to board');
            if (nb && nb.id !== id) { dd.items.find((x) => x.id === it.id).boardId = nb.id; saveBoardsData(dd); items.splice(i, 1); draw(); toast(`Moved to ${nb.name}`); }
          }
        }));
      });
    }));
  };
  draw();
}

async function openBoardReader(board, items, start, ctx) {
  const pages = await pagesFor(items);
  ctx.openReader({
    title: board.name, pages, start, mode: 'ltr',
    onAddToBoard: async (i) => {
      const it = items[i];
      const nb = await pickBoard('Also save to board');
      if (!nb) return null;
      const d = loadBoards();
      if (!d.items.some((x) => x.boardId === nb.id && x.pictureId === it.pictureId)) {
        d.items.push({ ...it, id: uid(), boardId: nb.id, addedAt: Date.now() });
        saveBoardsData(d);
      }
      return nb.name;
    },
  });
}
