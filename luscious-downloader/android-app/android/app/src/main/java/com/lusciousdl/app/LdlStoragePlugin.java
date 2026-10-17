package com.lusciousdl.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.provider.DocumentsContract;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Native storage + device helpers for Luscious DL:
 * - save albums to the phone or SD card (app folder) or to a folder the user picks
 * - keep downloads out of the Gallery (.nomedia)
 * - full-screen reading mode, volume-key page turns, screen insets
 */
@CapacitorPlugin(name = "LdlStorage")
public class LdlStoragePlugin extends Plugin {

    static volatile LdlStoragePlugin instance;
    static volatile boolean captureVolume = false;

    private static final String UA =
        "Mozilla/5.0 (Linux; Android 14; SM-A256B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

    private final ExecutorService jobs = Executors.newCachedThreadPool();
    private final Map<String, AtomicBoolean> cancels = new ConcurrentHashMap<>();

    @Override
    public void load() {
        instance = this;
    }

    static void volumeKey(int dir) {
        LdlStoragePlugin p = instance;
        if (p == null) return;
        JSObject d = new JSObject();
        d.put("dir", dir);
        p.notifyListeners("volumeKey", d);
    }

    // ---------------------------------------------------------------- folders

    /** A folder we can list and write into: either a real path or a SAF document. */
    private interface Dir {
        Map<String, String> list() throws IOException; // name -> uri
        Dir sub(String name, boolean create) throws IOException;
        OutputStream create(String name) throws IOException;
        void rename(String from, String to) throws IOException;
        void delete(String name);
        boolean deleteSelf();
    }

    private static class FileDir implements Dir {
        final File dir;
        FileDir(File dir) { this.dir = dir; }

        public Map<String, String> list() {
            Map<String, String> out = new HashMap<>();
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) out.put(f.getName(), Uri.fromFile(f).toString());
            return out;
        }
        public Dir sub(String name, boolean create) throws IOException {
            File d = new File(dir, name);
            if (!d.isDirectory()) {
                if (!create) return null;
                if (!d.mkdirs() && !d.isDirectory()) throw new IOException("Can't create folder " + d);
            }
            return new FileDir(d);
        }
        public OutputStream create(String name) throws IOException { return new FileOutputStream(new File(dir, name)); }
        public void rename(String from, String to) throws IOException {
            File t = new File(dir, to);
            if (t.exists()) t.delete();
            if (!new File(dir, from).renameTo(t)) throw new IOException("rename failed");
        }
        public void delete(String name) { new File(dir, name).delete(); }
        public boolean deleteSelf() { return deleteRecursive(dir); }
        private static boolean deleteRecursive(File f) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
            return f.delete();
        }
    }

    private static class TreeDir implements Dir {
        final ContentResolver cr;
        final Uri tree;
        final Uri doc;
        TreeDir(ContentResolver cr, Uri tree, Uri doc) { this.cr = cr; this.tree = tree; this.doc = doc; }

        static TreeDir root(ContentResolver cr, Uri tree) {
            return new TreeDir(cr, tree, DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)));
        }
        public Map<String, String> list() throws IOException {
            Map<String, String> out = new HashMap<>();
            Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(doc));
            String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
            try (Cursor c = cr.query(kids, cols, null, null, null)) {
                if (c == null) throw new IOException("Can't read folder (permission lost?)");
                while (c.moveToNext()) {
                    out.put(c.getString(1), DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0)).toString());
                }
            } catch (SecurityException e) {
                throw new IOException("No permission for this folder anymore. Choose it again in Settings.");
            }
            return out;
        }
        public Dir sub(String name, boolean create) throws IOException {
            String found = list().get(name);
            if (found != null) return new TreeDir(cr, tree, Uri.parse(found));
            if (!create) return null;
            Uri made = DocumentsContract.createDocument(cr, doc, DocumentsContract.Document.MIME_TYPE_DIR, name);
            if (made == null) throw new IOException("Can't create folder " + name);
            return new TreeDir(cr, tree, made);
        }
        private Uri createDoc(String name) throws IOException {
            Uri u = DocumentsContract.createDocument(cr, doc, "application/octet-stream", name);
            if (u == null) throw new IOException("Can't create " + name);
            return u;
        }
        public OutputStream create(String name) throws IOException {
            String existing = list().get(name);
            Uri u = existing != null ? Uri.parse(existing) : createDoc(name);
            OutputStream os = cr.openOutputStream(u, "wt");
            if (os == null) throw new IOException("Can't write " + name);
            return os;
        }
        public void rename(String from, String to) throws IOException {
            Map<String, String> all = list();
            if (all.containsKey(to)) DocumentsContract.deleteDocument(cr, Uri.parse(all.get(to)));
            String src = all.get(from);
            if (src == null || DocumentsContract.renameDocument(cr, Uri.parse(src), to) == null) throw new IOException("rename failed");
        }
        public void delete(String name) {
            try {
                String u = list().get(name);
                if (u != null) DocumentsContract.deleteDocument(cr, Uri.parse(u));
            } catch (Exception ignored) {}
        }
        public boolean deleteSelf() {
            try { return DocumentsContract.deleteDocument(cr, doc); } catch (Exception e) { return false; }
        }
    }

    /** target: { type: 'app', index: n } or { type: 'tree', uri: '...' }. Returns the Luscious root folder. */
    private Dir rootDir(JSONObject target) throws IOException {
        if (target == null) throw new IOException("No download location set");
        if ("tree".equals(target.optString("type"))) {
            Uri tree = Uri.parse(target.optString("uri"));
            return TreeDir.root(getContext().getContentResolver(), tree);
        }
        File[] dirs = getContext().getExternalFilesDirs(null);
        int i = target.optInt("index", 0);
        File base = (i >= 0 && i < dirs.length && dirs[i] != null) ? dirs[i] : getContext().getExternalFilesDir(null);
        if (base == null) base = getContext().getFilesDir();
        return new FileDir(base).sub("Luscious", true);
    }

    /** Gallery apps skip folders that contain a .nomedia file. */
    private static void ensureNoMedia(Dir dir) {
        try {
            if (!dir.list().containsKey(".nomedia")) dir.create(".nomedia").close();
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void getVolumes(PluginCall call) {
        JSArray arr = new JSArray();
        File[] dirs = getContext().getExternalFilesDirs(null);
        for (int i = 0; i < dirs.length; i++) {
            File d = dirs[i];
            if (d == null) continue;
            boolean removable;
            try { removable = Environment.isExternalStorageRemovable(d); } catch (Exception e) { removable = i > 0; }
            JSObject v = new JSObject();
            v.put("index", i);
            v.put("removable", removable);
            v.put("label", removable ? "SD card" : "Phone storage");
            v.put("path", d.getAbsolutePath());
            try {
                StatFs st = new StatFs(d.getAbsolutePath());
                v.put("free", st.getAvailableBytes());
                v.put("total", st.getTotalBytes());
            } catch (Exception ignored) {}
            arr.put(v);
        }
        JSObject ret = new JSObject();
        ret.put("volumes", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, i, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri tree = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Couldn't get permission for that folder");
            return;
        }
        String name = tree.getLastPathSegment();
        if (name != null && name.contains(":")) {
            String vol = name.substring(0, name.indexOf(':'));
            String path = name.substring(name.indexOf(':') + 1);
            name = ("primary".equals(vol) ? "Phone" : "SD card") + (path.isEmpty() ? "" : " › " + path);
        }
        JSObject ret = new JSObject();
        ret.put("uri", tree.toString());
        ret.put("name", name);
        call.resolve(ret);
    }

    // ---------------------------------------------------------------- downloads

    private static String mimeFor(String name) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(name.toLowerCase(Locale.ROOT));
        String m = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m == null ? "application/octet-stream" : m;
    }

    /** How to shrink images while saving. maxWidth 0 = keep size. lossless = pixel-identical output. */
    private static class Compress {
        final int quality;
        final int maxWidth;
        final boolean lossless;
        Compress(int quality, int maxWidth, boolean lossless) { this.quality = quality; this.maxWidth = maxWidth; this.lossless = lossless; }
    }

    private static String stem(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private static boolean compressible(String name, Compress c) {
        String n = name.toLowerCase(Locale.ROOT);
        boolean jpeg = n.endsWith(".jpg") || n.endsWith(".jpeg");
        // A JPEG can't be re-saved smaller without losing quality, so lossless mode keeps it as-is.
        if (jpeg) return !c.lossless;
        return n.endsWith(".png") || n.endsWith(".bmp");
    }

    /** Thrown for 403/404 so we can switch to the fallback image right away. */
    private static class RefusedException extends IOException {
        RefusedException(String m) { super(m); }
    }

    private static byte[] download(String url, String ua, AtomicBoolean cancel) throws IOException {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        try {
            con.setConnectTimeout(20000);
            con.setReadTimeout(60000);
            con.setInstanceFollowRedirects(true);
            con.setRequestProperty("User-Agent", ua == null || ua.isEmpty() ? UA : ua);
            con.setRequestProperty("Referer", "https://www.luscious.net/");
            con.setRequestProperty("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8");
            int code = con.getResponseCode();
            if (code == 403 || code == 404 || code == 410) throw new RefusedException("HTTP " + code);
            if (code >= 400) throw new IOException("HTTP " + code);
            int len = con.getContentLength();
            ByteArrayOutputStream out = new ByteArrayOutputStream(len > 0 ? len : 1 << 20);
            try (InputStream in = con.getInputStream()) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancel.get()) throw new IOException("cancelled");
                    out.write(buf, 0, n);
                }
            }
            return out.toByteArray();
        } finally {
            con.disconnect();
        }
    }

    /** Re-encodes an image as WebP (JPEG for very tall strips), scaled down to maxWidth. Returns null to keep the original. */
    @SuppressWarnings("deprecation")
    private static byte[] shrink(byte[] data, Compress c, String[] extOut) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        int w = bounds.outWidth, h = bounds.outHeight;
        if (w <= 0 || h <= 0) return null;
        // Only ever scales evenly (never crops); lossless mode keeps the original size.
        int targetW = (!c.lossless && c.maxWidth > 0 && w > c.maxWidth) ? c.maxWidth : w;
        int targetH = (int) Math.max(1, Math.round((double) h * targetW / w));

        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = 1;
        while (w / (opts.inSampleSize * 2) >= targetW) opts.inSampleSize *= 2; // cheap pre-shrink while decoding
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bmp = null, scaled = null;
        try {
            bmp = BitmapFactory.decodeByteArray(data, 0, data.length, opts);
            if (bmp == null) return null;
            scaled = (bmp.getWidth() != targetW) ? Bitmap.createScaledBitmap(bmp, targetW, targetH, true) : bmp;
            ByteArrayOutputStream out = new ByteArrayOutputStream(data.length / 3 + 1024);
            boolean ok;
            // WebP can't go past 16383px; very tall webtoon strips use JPEG instead.
            if (targetH <= 16383 && targetW <= 16383) {
                Bitmap.CompressFormat fmt;
                int q = c.quality;
                if (c.lossless) {
                    // Older Android: WEBP at quality 100 is lossless.
                    fmt = Build.VERSION.SDK_INT >= 30 ? Bitmap.CompressFormat.WEBP_LOSSLESS : Bitmap.CompressFormat.WEBP;
                    q = 100;
                } else {
                    fmt = Build.VERSION.SDK_INT >= 30 ? Bitmap.CompressFormat.WEBP_LOSSY : Bitmap.CompressFormat.WEBP;
                }
                ok = scaled.compress(fmt, q, out);
                extOut[0] = ".webp";
            } else if (c.lossless) {
                return null; // too tall for WebP; keep the original rather than lose quality
            } else {
                ok = scaled.compress(Bitmap.CompressFormat.JPEG, Math.min(95, c.quality + 5), out);
                extOut[0] = ".jpg";
            }
            if (!ok || out.size() == 0 || out.size() >= data.length) return null; // not worth it
            return out.toByteArray();
        } catch (OutOfMemoryError oom) {
            return null;
        } finally {
            if (scaled != null && scaled != bmp) scaled.recycle();
            if (bmp != null) bmp.recycle();
        }
    }

    private static void writeAtomically(Dir dir, String name, byte[] data) throws IOException {
        String part = name + ".part";
        try (OutputStream out = dir.create(part)) {
            out.write(data);
        } catch (IOException e) {
            dir.delete(part);
            throw e;
        }
        dir.rename(part, name);
    }

    /** Per-download settings shared by all files of an album. */
    private static class Job {
        final String ua;
        final AtomicBoolean cancel;
        // After a few refused originals, go straight to the fallback image.
        final AtomicInteger refusedOriginals = new AtomicInteger();
        Job(String ua, AtomicBoolean cancel) { this.ua = ua; this.cancel = cancel; }
    }

    /** Downloads one file (with retries, falling back to the preview image if refused), optionally compressing it. Returns { originalBytes, savedBytes }. */
    private static long[] fetchTo(Dir dir, String url, String fallback, String name, Compress c, Job job) throws IOException {
        AtomicBoolean cancel = job.cancel;
        boolean hasFallback = fallback != null && !fallback.isEmpty() && !fallback.equals(url);
        boolean useFallback = hasFallback && job.refusedOriginals.get() >= 3;
        IOException last = null;
        for (int attempt = 0; attempt < 4; attempt++) {
            if (cancel.get()) return new long[] { 0, 0 };
            try {
                byte[] data;
                try {
                    data = download(useFallback ? fallback : url, job.ua, cancel);
                } catch (RefusedException refused) {
                    if (useFallback || !hasFallback) throw refused;
                    job.refusedOriginals.incrementAndGet();
                    useFallback = true;
                    data = download(fallback, job.ua, cancel);
                }
                // The fallback is a JPEG/WebP preview; keep the page's extension consistent with what was saved.
                if (useFallback) {
                    String fext = fallback.toLowerCase(Locale.ROOT).replaceAll("[?#].*$", "");
                    int dot = fext.lastIndexOf('.');
                    if (dot > fext.lastIndexOf('/')) name = stem(name) + fext.substring(dot);
                }
                byte[] out = data;
                String outName = name;
                if (c != null && compressible(name, c)) {
                    String[] ext = { ".webp" };
                    byte[] small = shrink(data, c, ext);
                    if (small != null) {
                        out = small;
                        outName = stem(name) + ext[0];
                    }
                }
                writeAtomically(dir, outName, out);
                return new long[] { data.length, out.length };
            } catch (IOException e) {
                if (e instanceof RefusedException) throw e; // retrying won't help
                last = e;
                if (cancel.get()) return new long[] { 0, 0 };
                try { Thread.sleep(700L << attempt); } catch (InterruptedException ie) { return new long[] { 0, 0 }; }
            }
        }
        throw last;
    }

    /** Keeps the app alive (with a notification) while downloads run in the background. */
    @PluginMethod
    public void setBackgroundMode(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        if (active) {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED && getActivity() != null) {
                ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4711);
            }
            try { DownloadService.start(getContext()); } catch (Exception ignored) {}
        } else {
            DownloadService.stop(getContext());
        }
        call.resolve();
    }

    /** files: [{ url, name }]. Skips files that already exist. Emits "downloadProgress". */
    @PluginMethod
    public void downloadAlbum(PluginCall call) {
        final JSObject target = call.getObject("target");
        final String folder = call.getString("folder");
        final String title = call.getString("title", folder);
        final JSArray files = call.getArray("files");
        final String jobId = call.getString("jobId", String.valueOf(System.nanoTime()));
        final int conc = Math.max(1, Math.min(8, call.getInt("concurrency", 4)));
        final JSObject comp = call.getObject("compress");
        final Compress compress = (comp != null && (comp.optInt("quality", 0) > 0 || comp.optBoolean("lossless", false)))
            ? new Compress(Math.max(30, Math.min(100, comp.optInt("quality", 100))), Math.max(0, comp.optInt("maxWidth", 0)), comp.optBoolean("lossless", false))
            : null;
        if (folder == null || files == null) {
            call.reject("missing folder or files");
            return;
        }
        final AtomicBoolean cancel = new AtomicBoolean(false);
        cancels.put(jobId, cancel);
        final Job job = new Job(call.getString("userAgent", UA), cancel);
        jobs.execute(() -> {
            try {
                Dir root = rootDir(target);
                ensureNoMedia(root);
                Dir album = root.sub(folder, true);
                ensureNoMedia(album);
                // Skip pages already saved, whatever format they were saved in.
                java.util.Set<String> existing = new java.util.HashSet<>();
                for (String n : album.list().keySet()) if (!n.endsWith(".part")) existing.add(stem(n));
                java.util.concurrent.atomic.AtomicLong origBytes = new java.util.concurrent.atomic.AtomicLong();
                java.util.concurrent.atomic.AtomicLong savedBytes = new java.util.concurrent.atomic.AtomicLong();
                int total = files.length();
                AtomicInteger done = new AtomicInteger();
                AtomicInteger failed = new AtomicInteger();
                ExecutorService pool = Executors.newFixedThreadPool(conc);
                for (int i = 0; i < total; i++) {
                    final JSONObject f = files.getJSONObject(i);
                    pool.execute(() -> {
                        String name = f.optString("name");
                        try {
                            if (!cancel.get() && !existing.contains(stem(name))) {
                                long[] sz = fetchTo(album, f.optString("url"), f.optString("fallback", ""), name, compress, job);
                                origBytes.addAndGet(sz[0]);
                                savedBytes.addAndGet(sz[1]);
                            }
                        } catch (Exception e) {
                            failed.incrementAndGet();
                        }
                        int d = done.incrementAndGet();
                        JSObject p = new JSObject();
                        p.put("jobId", jobId);
                        p.put("done", d);
                        p.put("failed", failed.get());
                        p.put("total", total);
                        notifyListeners("downloadProgress", p);
                        DownloadService.update(getContext(), title, d, total);
                    });
                }
                pool.shutdown();
                pool.awaitTermination(7, TimeUnit.DAYS);
                JSObject ret = new JSObject();
                ret.put("total", total);
                ret.put("failed", failed.get());
                ret.put("cancelled", cancel.get());
                ret.put("originalBytes", origBytes.get());
                ret.put("savedBytes", savedBytes.get());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                cancels.remove(jobId);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        AtomicBoolean c = cancels.get(call.getString("jobId", ""));
        if (c != null) c.set(true);
        if (Boolean.TRUE.equals(call.getBoolean("all", false))) for (AtomicBoolean x : cancels.values()) x.set(true);
        call.resolve();
    }

    /** Lists a saved album's files: { files: [{ name, uri }] }, or exists: false. */
    @PluginMethod
    public void listAlbum(PluginCall call) {
        final JSObject target = call.getObject("target");
        final String folder = call.getString("folder");
        jobs.execute(() -> {
            try {
                Dir album = rootDir(target).sub(folder, false);
                JSObject ret = new JSObject();
                JSArray arr = new JSArray();
                if (album != null) {
                    for (Map.Entry<String, String> e : album.list().entrySet()) {
                        if (e.getKey().startsWith(".") || e.getKey().endsWith(".part")) continue;
                        JSObject o = new JSObject();
                        o.put("name", e.getKey());
                        o.put("uri", e.getValue());
                        arr.put(o);
                    }
                }
                ret.put("exists", album != null);
                ret.put("files", arr);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void deleteAlbum(PluginCall call) {
        final JSObject target = call.getObject("target");
        final String folder = call.getString("folder");
        jobs.execute(() -> {
            try {
                Dir album = rootDir(target).sub(folder, false);
                JSObject ret = new JSObject();
                ret.put("deleted", album != null && album.deleteSelf());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    /** Opens luscious.net in a browser screen so the user can pass its bot check. */
    @PluginMethod
    public void openVerify(PluginCall call) {
        Intent i = new Intent(getContext(), VerifyActivity.class);
        i.putExtra("url", call.getString("url", "https://www.luscious.net/"));
        startActivityForResult(call, i, "verifyResult");
    }

    @ActivityCallback
    private void verifyResult(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve();
    }

    // ---------------------------------------------------------------- reading mode & screen

    /** on: full screen (hide status/nav bars), keep screen on, volume keys turn pages. */
    @PluginMethod
    public void setReading(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        final boolean keepAwake = Boolean.TRUE.equals(call.getBoolean("keepAwake", true));
        final boolean volumeKeys = Boolean.TRUE.equals(call.getBoolean("volumeKeys", true));
        final boolean fullscreen = Boolean.TRUE.equals(call.getBoolean("fullscreen", true));
        captureVolume = on && volumeKeys;
        Activity act = getActivity();
        if (act == null) {
            call.resolve();
            return;
        }
        act.runOnUiThread(() -> {
            Window w = act.getWindow();
            View decor = w.getDecorView();
            WindowInsetsControllerCompat ctl = WindowCompat.getInsetsController(w, decor);
            if (on && fullscreen) {
                ctl.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                ctl.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                ctl.show(WindowInsetsCompat.Type.systemBars());
            }
            if (on && keepAwake) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    /** How much of the web view is covered by the status bar / navigation bar / notch, in CSS px. */
    @PluginMethod
    public void getInsets(PluginCall call) {
        Activity act = getActivity();
        if (act == null || getBridge() == null || getBridge().getWebView() == null) {
            call.resolve(new JSObject());
            return;
        }
        act.runOnUiThread(() -> {
            View wv = getBridge().getWebView();
            JSObject ret = new JSObject();
            WindowInsetsCompat ins = ViewCompat.getRootWindowInsets(wv);
            if (ins != null) {
                Insets s = ins.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                int[] loc = new int[2];
                wv.getLocationInWindow(loc);
                int rootH = wv.getRootView().getHeight();
                int rootW = wv.getRootView().getWidth();
                float dp = act.getResources().getDisplayMetrics().density;
                ret.put("top", Math.max(0, s.top - loc[1]) / dp);
                ret.put("bottom", Math.max(0, (loc[1] + wv.getHeight()) - (rootH - s.bottom)) / dp);
                ret.put("left", Math.max(0, s.left - loc[0]) / dp);
                ret.put("right", Math.max(0, (loc[0] + wv.getWidth()) - (rootW - s.right)) / dp);
            }
            call.resolve(ret);
        });
    }
}
