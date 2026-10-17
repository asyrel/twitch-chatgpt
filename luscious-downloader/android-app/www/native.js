// Thin wrapper around the app's native LdlStorage plugin (see LdlStoragePlugin.java).
const Cap = window.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
const P = isNative ? (Cap.Plugins?.LdlStorage || Cap.registerPlugin?.('LdlStorage')) : null;
export const hasNative = !!P;

const call = async (method, args) => (P ? P[method](args || {}) : null);

export const getVolumes = async () => (await call('getVolumes'))?.volumes || [];
export const pickFolder = () => call('pickFolder');
export const listAlbum = (target, folder) => call('listAlbum', { target, folder });
export const deleteAlbum = (target, folder) => call('deleteAlbum', { target, folder });
export const cancelDownloads = () => call('cancel', { all: true });
export const setBackgroundMode = (active) => call('setBackgroundMode', { active }).catch(() => {});
export const openVerify = (url) => call('openVerify', { url });
export const setReading = (on, opts = {}) => call('setReading', { on, ...opts }).catch(() => {});

export async function downloadAlbum({ target, folder, title, files, jobId, compress = null, userAgent, concurrency = 4, onProgress }) {
  let handle = null;
  if (P && onProgress) {
    handle = await P.addListener('downloadProgress', (p) => { if (p.jobId === jobId) onProgress(p); });
  }
  try {
    return await call('downloadAlbum', { target, folder, title, files, jobId, compress, userAgent, concurrency });
  } finally {
    handle?.remove?.();
  }
}

let volumeHandler = null;
export function onVolumeKey(fn) { volumeHandler = fn; }
if (P) P.addListener('volumeKey', (e) => volumeHandler?.(e.dir));

// Pads the UI around the status bar, notch and navigation bar.
async function applyInsets() {
  if (!P) return;
  try {
    const i = await P.getInsets();
    const root = document.documentElement.style;
    root.setProperty('--sat', `${i.top || 0}px`);
    root.setProperty('--sab', `${i.bottom || 0}px`);
  } catch {}
}
if (P) {
  applyInsets();
  window.addEventListener('resize', () => setTimeout(applyInsets, 150));
}

export const fileSrc = (uri) => (Cap?.convertFileSrc ? Cap.convertFileSrc(uri) : uri);
