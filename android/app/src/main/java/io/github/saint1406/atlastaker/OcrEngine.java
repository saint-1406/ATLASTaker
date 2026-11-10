package io.github.saint1406.atlastaker;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;

/**
 * The scanner's text recognizer (libatlasocr.so: PaddleOCR v5 on ncnn, see cpp/atlas_ocr.cpp). The
 * models ship in the APK (assets/ocr) and are copied once to the app's files, where ncnn reads them;
 * nothing is ever downloaded. Used from Scanner's single thread only.
 */
final class OcrEngine {
    static final String[] MODEL_FILES = {
            "PP_OCRv5_mobile_det.ncnn.param", "PP_OCRv5_mobile_det.ncnn.bin",
            "eslav_ppocrv5_rec.ncnn.param", "eslav_ppocrv5_rec.ncnn.bin",
            "ppocrv5_eslav_dict.txt",
    };

    private static Boolean libraryLoaded;
    private boolean modelsLoaded;

    private static native int nativeLoad(String dir, int threads);
    private static native void nativeRelease();
    private static native void nativeCancel(boolean on);
    private static native String nativeRun(ByteBuffer rgba, int width, int height, boolean autoRotate);

    /** Whether this phone can run the recognizer at all (the library is built for ARM phones). */
    static synchronized boolean libraryAvailable() {
        if (libraryLoaded == null) {
            try {
                System.loadLibrary("atlasocr");
                libraryLoaded = true;
            } catch (UnsatisfiedLinkError e) {
                libraryLoaded = false;
            }
        }
        return libraryLoaded;
    }

    /** Loads the models (copied out of the APK the first time). null when ready, else an error code. */
    String ensureLoaded(Context context, String version) {
        if (modelsLoaded) return null;
        if (!libraryAvailable()) return "unsupported";
        File dir = new File(context.getFilesDir(), "ocr-" + version);
        try {
            copyModels(context.getAssets(), dir);
        } catch (IOException e) {
            return "storage";
        }
        // big cores do the work; the small ones would only slow the lines down
        int threads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() / 2));
        int result = nativeLoad(dir.getAbsolutePath(), threads);
        if (result == -100) return "memory";
        if (result != 0) return "model";
        modelsLoaded = true;
        // models of older versions of the app are not needed any more
        File[] all = context.getFilesDir().listFiles();
        if (all != null) {
            for (File old : all) {
                if (old.isDirectory() && old.getName().startsWith("ocr-") && !old.equals(dir)) deleteTree(old);
            }
        }
        return null;
    }

    boolean loaded() {
        return modelsLoaded;
    }

    /** The models leave memory (a low-memory warning, or the scanner closed); loaded again when needed. */
    void release() {
        if (!modelsLoaded) return;
        nativeRelease();
        modelsLoaded = false;
    }

    static void cancel(boolean on) {
        if (libraryAvailable()) nativeCancel(on);
    }

    String run(ByteBuffer rgba, int width, int height, boolean autoRotate) {
        return nativeRun(rgba, width, height, autoRotate);
    }

    private static void copyModels(AssetManager assets, File dir) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no folder for the models");
        byte[] buffer = new byte[64 * 1024];
        for (String name : MODEL_FILES) {
            File target = new File(dir, name);
            long size;
            try (AssetFileDescriptor fd = assets.openFd("ocr/" + name)) {
                size = fd.getLength();
            } catch (IOException compressed) {
                size = -1; // stored compressed in the APK: its size is not known without reading it
            }
            if (target.isFile() && (size < 0 ? target.length() > 0 : target.length() == size)) continue;
            File part = new File(dir, name + ".part");
            try (InputStream in = assets.open("ocr/" + name); OutputStream out = new FileOutputStream(part)) {
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            }
            if (!part.renameTo(target)) throw new IOException("could not keep " + name);
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
