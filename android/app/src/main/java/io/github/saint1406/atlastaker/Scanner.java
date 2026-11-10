package io.github.saint1406.atlastaker;

import android.app.ActivityManager;
import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.media.ExifInterface;
import android.os.Build;
import android.os.Debug;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * The document scanner's work on the phone (src/scanner in the page drives it). The page hands over a
 * photo (from its camera view or the gallery) in pieces, then asks for a page: the photo is decoded
 * (turned as its EXIF says, at most ~16 megapixels), the sheet cut out along the four corners the page
 * found or the person moved and flattened, turned by hand if asked, and read by OcrEngine. The
 * flattened page is kept in the cache as a JPEG the page shows from /scan/. Nothing leaves the phone.
 * Answers go to the page as window.__atlas.scan(event). One page at a time, on one thread.
 */
final class Scanner {
    private static final Pattern ID = Pattern.compile("[a-z0-9-]{1,48}");
    private static final long MAX_SOURCE = 40L * 1024 * 1024; // a photo larger than this is not a photo
    private static final int DECODE_PIXELS = 16_800_000; // a 16-megapixel photo decodes whole, larger ones halved
    private static final int MB = 1024 * 1024;

    private final Context context;
    private final Consumer<String> send;
    private final File dir;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final OcrEngine engine = new OcrEngine();
    private final AtomicBoolean busy = new AtomicBoolean();
    private volatile String current; // the id being worked on
    private volatile String cancelled; // the id the page no longer wants
    private int version; // makes each saved page's address new, so the WebView shows the new one

    Scanner(Context context, Consumer<String> send) {
        this.context = context.getApplicationContext();
        this.send = send;
        this.dir = new File(this.context.getCacheDir(), "scan");
        // pages of an earlier run are not wanted any more
        deleteChildren(dir);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
    }

    File dir() {
        return dir;
    }

    /** What the page may offer: whether the recognizer runs here, and what it is. */
    String info() {
        JSONObject answer = new JSONObject();
        try {
            boolean ok = OcrEngine.libraryAvailable();
            answer.put("ok", ok);
            if (!ok) answer.put("reason", "unsupported");
            answer.put("engine", "PaddleOCR v5 mobile (eslav) · ncnn");
            answer.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
            answer.put("cores", Runtime.getRuntime().availableProcessors());
            ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null) answer.put("memoryClass", am.getMemoryClass());
        } catch (JSONException ignored) {
            // the keys above are plain
        }
        return answer.toString();
    }

    /** A new photo begins: its file is made empty. */
    boolean begin(String id) {
        if (!valid(id)) return false;
        try {
            new FileOutputStream(source(id), false).close();
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** The next piece of the photo (base64). False when it could not be kept, or the photo is too large. */
    boolean append(String id, String base64) {
        if (!valid(id) || base64 == null) return false;
        File file = source(id);
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            if (file.length() + bytes.length > MAX_SOURCE) return false;
            try (OutputStream out = new FileOutputStream(file, true)) {
                out.write(bytes);
            }
            return true;
        } catch (IllegalArgumentException | IOException e) {
            return false;
        }
    }

    /** The page wants this photo as a page: options as JSON (quad, rotate, maxSide, recognize, autoRotate). */
    void process(String id, String optionsJson) {
        if (!valid(id)) return;
        JSONObject options;
        try {
            options = new JSONObject(optionsJson == null ? "{}" : optionsJson);
        } catch (JSONException e) {
            fail(id, "input", null);
            return;
        }
        work.execute(() -> run(id, options));
    }

    void cancel(String id) {
        if (!valid(id)) return;
        cancelled = id;
        if (id.equals(current)) OcrEngine.cancel(true);
    }

    /** The photo and its pages are thrown away. */
    void drop(String id) {
        if (!valid(id)) return;
        work.execute(() -> {
            File[] files = dir.listFiles((d, name) -> name.startsWith(id + "."));
            if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
                f.delete();
            File[] pages = dir.listFiles((d, name) -> name.startsWith(id + "-"));
            if (pages != null) for (File f : pages) //noinspection ResultOfMethodCallIgnored
                f.delete();
        });
    }

    /** The scanner closed: its models leave memory and its files the cache. */
    void close() {
        work.execute(() -> {
            engine.release();
            deleteChildren(dir);
        });
    }

    /** Android is short of memory: the models go, unless a page is being read right now. */
    void trim(int level) {
        if (level < ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) return;
        work.execute(() -> {
            if (!busy.get()) engine.release();
        });
    }

    void shutdown() {
        OcrEngine.cancel(true);
        work.shutdownNow();
    }

    // ---------- one page ----------

    private void run(String id, JSONObject options) {
        if (id.equals(cancelled)) {
            fail(id, "cancelled", null);
            return;
        }
        busy.set(true);
        current = id;
        OcrEngine.cancel(false);
        MemoryWatch memory = new MemoryWatch();
        memory.start();
        long t0 = System.nanoTime();
        JSONObject timings = new JSONObject();
        Bitmap page = null;
        try {
            // a phone short of memory gets a smaller page rather than a crash
            boolean tight = lowMemory();
            int maxSide = clamp(options.optInt("maxSide", 2400), 800, 3200);
            if (tight) maxSide = Math.min(maxSide, 1800);

            progress(id, "decode");
            long t = System.nanoTime();
            Decoded photo = decode(source(id), tight ? DECODE_PIXELS / 2 : DECODE_PIXELS);
            if (photo == null) {
                fail(id, "decode", null);
                return;
            }
            timings.put("decode", ms(t));

            progress(id, "flatten");
            t = System.nanoTime();
            page = flatten(photo, options.optJSONArray("quad"), options.optInt("rotate", 0), maxSide);
            photo.bitmap.recycle();
            timings.put("flatten", ms(t));
            if (id.equals(cancelled)) {
                fail(id, "cancelled", null);
                return;
            }

            JSONObject answer = new JSONObject();
            if (options.optBoolean("recognize", true)) {
                progress(id, "load");
                t = System.nanoTime();
                String problem = engine.ensureLoaded(context, appVersion());
                if (problem != null) {
                    // the flattened page is still worth keeping: the person may save it without text
                    saveAndAnswer(id, page, answer, timings, t0, memory, problem);
                    return;
                }
                timings.put("load", ms(t));

                progress(id, "recognize");
                t = System.nanoTime();
                ByteBuffer pixels = ByteBuffer.allocateDirect(page.getByteCount());
                page.copyPixelsToBuffer(pixels);
                pixels.rewind();
                String read = engine.run(pixels, page.getWidth(), page.getHeight(), options.optBoolean("autoRotate", true));
                timings.put("recognize", ms(t));
                JSONObject result = new JSONObject(read);
                if (!result.optBoolean("ok")) {
                    String code = result.optString("code", "internal");
                    if ("cancelled".equals(code)) {
                        fail(id, "cancelled", null);
                        return;
                    }
                    if ("memory".equals(code)) engine.release();
                    saveAndAnswer(id, page, answer, timings, t0, memory, code);
                    return;
                }
                // the page as it was read: perhaps turned upright and brightened
                int w = result.getInt("width");
                int h = result.getInt("height");
                if (w != page.getWidth() || h != page.getHeight() || result.optBoolean("enhanced") || result.optInt("rotation") != 0) {
                    Bitmap read2 = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                    pixels.rewind();
                    read2.copyPixelsFromBuffer(pixels);
                    page.recycle();
                    page = read2;
                }
                answer.put("items", result.getJSONArray("items"));
                answer.put("rotation", result.optInt("rotation"));
                answer.put("enhanced", result.optBoolean("enhanced"));
                answer.put("native", result.optJSONObject("timings"));
            }
            saveAndAnswer(id, page, answer, timings, t0, memory, null);
        } catch (OutOfMemoryError e) {
            engine.release();
            fail(id, "memory", null);
        } catch (Exception e) {
            fail(id, "internal", e.getClass().getSimpleName());
        } finally {
            memory.stop();
            if (page != null && !page.isRecycled()) page.recycle();
            current = null;
            busy.set(false);
            if (id.equals(cancelled)) cancelled = null;
        }
    }

    private void saveAndAnswer(String id, Bitmap page, JSONObject answer, JSONObject timings, long t0, MemoryWatch memory, String problem) throws JSONException, IOException {
        long t = System.nanoTime();
        File[] old = dir.listFiles((d, name) -> name.startsWith(id + "-"));
        if (old != null) for (File f : old) //noinspection ResultOfMethodCallIgnored
            f.delete();
        String name = id + "-" + (++version) + ".jpg";
        try (OutputStream out = new FileOutputStream(new File(dir, name))) {
            page.compress(Bitmap.CompressFormat.JPEG, 90, out);
        }
        timings.put("save", ms(t));
        timings.put("total", ms(t0));
        answer.put("id", id);
        answer.put("done", true);
        answer.put("ok", problem == null);
        if (problem != null) answer.put("code", problem);
        answer.put("image", "/scan/" + name);
        answer.put("width", page.getWidth());
        answer.put("height", page.getHeight());
        answer.put("timings", timings);
        answer.put("memory", memory.report());
        send.accept(answer.toString());
    }

    // ---------- decoding and flattening ----------

    private static final class Decoded {
        final Bitmap bitmap;
        final Matrix orient; // decoded pixels → the photo as it is meant to be seen
        final int width; // the photo as seen
        final int height;

        Decoded(Bitmap bitmap, Matrix orient, int width, int height) {
            this.bitmap = bitmap;
            this.orient = orient;
            this.width = width;
            this.height = height;
        }
    }

    private static Decoded decode(File file, int maxPixels) throws IOException {
        if (!file.isFile() || file.length() == 0) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        int sample = 1;
        while ((long) (bounds.outWidth / sample) * (bounds.outHeight / sample) > maxPixels) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap = BitmapFactory.decodeFile(file.getPath(), opts);
        if (bitmap == null) return null;

        int w = bitmap.getWidth();
        int h = bitmap.getHeight();
        int orientation = ExifInterface.ORIENTATION_NORMAL;
        try {
            orientation = new ExifInterface(file.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (IOException | RuntimeException ignored) {
            // a PNG or a picture without EXIF: as it is
        }
        Matrix m = new Matrix();
        boolean swap = false;
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); m.postTranslate(h, 0); swap = true; break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); m.postTranslate(w, h); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(270); m.postTranslate(0, w); swap = true; break;
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.postScale(-1, 1); m.postTranslate(w, 0); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.postScale(1, -1); m.postTranslate(0, h); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: m.postRotate(90); m.postScale(-1, 1); swap = true; break;
            case ExifInterface.ORIENTATION_TRANSVERSE: m.postRotate(270); m.postScale(-1, 1); m.postTranslate(h, w); swap = true; break;
            default: break;
        }
        return new Decoded(bitmap, m, swap ? h : w, swap ? w : h);
    }

    /**
     * The sheet inside quad (four corners tl, tr, br, bl as fractions of the photo as seen; the whole
     * photo when absent) drawn flat, turned clockwise by `rotate` degrees, its longer side ≤ maxSide.
     */
    private static Bitmap flatten(Decoded photo, JSONArray quad, int rotate, int maxSide) throws JSONException {
        float[] src = new float[8];
        if (quad != null && quad.length() == 4) {
            for (int i = 0; i < 4; i++) {
                JSONArray p = quad.getJSONArray(i);
                src[2 * i] = (float) (clamp01(p.getDouble(0)) * photo.width);
                src[2 * i + 1] = (float) (clamp01(p.getDouble(1)) * photo.height);
            }
        } else {
            src = new float[] {0, 0, photo.width, 0, photo.width, photo.height, 0, photo.height};
        }
        double w = Math.max(dist(src, 0, 1), dist(src, 3, 2));
        double h = Math.max(dist(src, 0, 3), dist(src, 1, 2));
        double k = Math.min(1, maxSide / Math.max(1, Math.max(w, h)));
        int fw = Math.max(16, (int) Math.round(w * k));
        int fh = Math.max(16, (int) Math.round(h * k));

        int turn = ((rotate % 360) + 360) % 360;
        boolean swap = turn == 90 || turn == 270;
        int ow = swap ? fh : fw;
        int oh = swap ? fw : fh;
        float[] dst;
        switch (turn) {
            case 90: dst = new float[] {ow, 0, ow, oh, 0, oh, 0, 0}; break;
            case 180: dst = new float[] {ow, oh, 0, oh, 0, 0, ow, 0}; break;
            case 270: dst = new float[] {0, oh, 0, 0, ow, 0, ow, oh}; break;
            default: dst = new float[] {0, 0, ow, 0, ow, oh, 0, oh}; break;
        }
        Matrix perspective = new Matrix();
        if (!perspective.setPolyToPoly(src, 0, dst, 0, 4)) {
            // the corners make no shape (three in a line): the photo as it is
            float[] whole = {0, 0, photo.width, 0, photo.width, photo.height, 0, photo.height};
            perspective.setPolyToPoly(whole, 0, dst, 0, 4);
        }
        Matrix m = new Matrix(photo.orient);
        m.postConcat(perspective);

        Bitmap out = Bitmap.createBitmap(ow, oh, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        canvas.drawColor(Color.WHITE);
        canvas.drawBitmap(photo.bitmap, m, new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG));
        return out;
    }

    // ---------- the rest ----------

    /** The app's versionCode: the models are copied out of the APK again after each update. */
    private String appVersion() {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return String.valueOf(Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode);
        } catch (PackageManager.NameNotFoundException e) {
            return "0";
        }
    }

    private boolean lowMemory() {
        ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return false;
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(info);
        return info.lowMemory || info.availMem < 300L * MB;
    }

    private void progress(String id, String stage) {
        try {
            send.accept(new JSONObject().put("id", id).put("stage", stage).toString());
        } catch (JSONException ignored) {
            // plain keys
        }
    }

    private void fail(String id, String code, String detail) {
        try {
            JSONObject answer = new JSONObject().put("id", id).put("done", true).put("ok", false).put("code", code);
            if (detail != null) answer.put("detail", detail);
            send.accept(answer.toString());
        } catch (JSONException ignored) {
            // plain keys
        }
    }

    private File source(String id) {
        return new File(dir, id + ".src");
    }

    private static boolean valid(String id) {
        return id != null && ID.matcher(id).matches();
    }

    private static long ms(long since) {
        return Math.round((System.nanoTime() - since) / 1e6);
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private static double clamp01(double v) {
        return Double.isNaN(v) ? 0 : Math.max(0, Math.min(1, v));
    }

    private static double dist(float[] p, int a, int b) {
        return Math.hypot(p[2 * a] - p[2 * b], p[2 * a + 1] - p[2 * b + 1]);
    }

    private static void deleteChildren(File folder) {
        File[] files = folder.listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    /** The highest the app's memory went while a page was made: what the benchmark reports. */
    private static final class MemoryWatch {
        private final long nativeBefore = Debug.getNativeHeapAllocatedSize();
        private final long javaBefore = usedJava();
        private volatile long nativePeak = nativeBefore;
        private volatile long javaPeak = javaBefore;
        private volatile boolean running;
        private Thread thread;

        private static long usedJava() {
            Runtime r = Runtime.getRuntime();
            return r.totalMemory() - r.freeMemory();
        }

        private void sample() {
            nativePeak = Math.max(nativePeak, Debug.getNativeHeapAllocatedSize());
            javaPeak = Math.max(javaPeak, usedJava());
        }

        void start() {
            running = true;
            thread = new Thread(() -> {
                while (running) {
                    sample();
                    try {
                        Thread.sleep(40);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }, "scan-memory");
            thread.setDaemon(true);
            thread.start();
        }

        void stop() {
            running = false;
            if (thread != null) thread.interrupt();
        }

        JSONObject report() throws JSONException {
            sample();
            return new JSONObject()
                    .put("nativeBeforeMB", round1(nativeBefore))
                    .put("nativePeakMB", round1(nativePeak))
                    .put("javaPeakMB", round1(javaPeak))
                    .put("javaBeforeMB", round1(javaBefore));
        }

        private static double round1(long bytes) {
            return Math.round(bytes * 10.0 / MB) / 10.0;
        }
    }
}
