package io.github.saint1406.atlastaker;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The offline translator's files (Firefox's Bergamot, src/bergamot.js): downloaded once, when the
 * person agrees in the page, from Mozilla's CDN into files/translate, each checked against its
 * SHA-256, and served back to the page at /translate-files/ (MainActivity's asset loader). Only the
 * files below can be asked for; the table is the same as src/bergamotFiles.js (a test compares them).
 *
 * Events go to the page as window.__atlas.translate({ id, done, total }) while a file comes, then
 * { id, ok } or { id, ok: false, code: "download" }.
 */
final class TranslateFiles {
    interface Events {
        void send(JSONObject event);
    }

    private static final String CDN = "https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/";

    /** path → { where on the CDN, size, sha256 } */
    private static final Map<String, String[]> FILES;

    static {
        Map<String, String[]> files = new HashMap<>();
        files.put("bergamot/2.0/bergamot-translator.wasm", new String[] {
                "translations-wasm/ec4aab08-4e7c-4a62-a7a5-ee6874a5d1a2.wasm", "4956176",
                "e67e2f8be1a3fc0d9b00adce8b641cdf767bf3de90f1b3ccf732c2d711304fa3"});
        files.put("bergamot/ru-en/2.1/model.ruen.intgemm.alphas.bin", new String[] {
                "translations-models/20260901210056--9781ee2a-d15e-4fe8-893d-687193373fff--37b65106-c6cd-4ed2-a28e-3acd72725429.bin", "31561787",
                "aa0efa194b3dbd2da129ba0b8db8ef139126cb0914e57072f62061294746f1e2"});
        files.put("bergamot/ru-en/2.1/lex.50.50.ruen.s2t.bin", new String[] {
                "translations-models/20260901210100--fd808a7b-0081-427d-83a5-7043bdd97a87--215ca362-0436-495d-b89d-542187b696cb.bin", "4397908",
                "c944e753f298bbdf6506388de7257fb48cbd12c83e2807e2c284fc323771895b"});
        files.put("bergamot/ru-en/2.1/vocab.ruen.spm", new String[] {
                "translations-models/20260901210058--222363ca-4a98-48a9-9162-65acdffc2572--ba370dc8-709d-42cd-b68c-83b912bd3e38.spm", "952371",
                "de8af5f87e231ee4016cec4bb482e6b584cb1ca34dcb624fc7b8398f25bb35df"});
        files.put("bergamot/en-ru/2.1/model.enru.intgemm.alphas.bin", new String[] {
                "translations-models/db6b48bb-b563-4ea1-bbf4-b033fa9cc482.bin", "31561787",
                "184cb5cda528eeefc0f75f5d0035d787b71d74af135e3c5608d01ae02ecfb920"});
        files.put("bergamot/en-ru/2.1/lex.50.50.enru.s2t.bin", new String[] {
                "translations-models/e88cc45c-0e0b-45d3-a957-8d1ba3a9b5aa.bin", "2774540",
                "4d91839726b960e70b6d05c53d0cffd16262832b1c0e1ea99d66f412dcc6a239"});
        files.put("bergamot/en-ru/2.1/vocab.enru.spm", new String[] {
                "translations-models/568807dd-9620-4c4d-a0b5-d651d64c0ab0.spm", "904455",
                "56ee63e14e8cb926c394242adc3ed7cc602644c3d33058cff2ce2959d52a6258"});
        FILES = Collections.unmodifiableMap(files);
    }

    private final File root;
    private final Events events;
    private final ExecutorService work = Executors.newSingleThreadExecutor();

    TranslateFiles(Context context, Events events) {
        this.root = new File(context.getFilesDir(), "translate");
        this.events = events;
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
    }

    /** The folder the page's /translate-files/ comes from. */
    File dir() {
        return root;
    }

    private File fileFor(String rel) {
        return new File(root, rel.replace('/', File.separatorChar));
    }

    private boolean have(String rel) {
        String[] info = FILES.get(rel);
        File file = fileFor(rel);
        return info != null && file.isFile() && file.length() == Long.parseLong(info[1]);
    }

    /** JSON in: an array of paths; out: { missing: [paths not here yet] } (unknown paths count as missing). */
    String status(String pathsJson) {
        JSONArray missing = new JSONArray();
        try {
            JSONArray paths = new JSONArray(pathsJson == null ? "[]" : pathsJson);
            for (int i = 0; i < paths.length() && i < 20; i++) {
                String rel = paths.optString(i, "");
                if (!have(rel)) missing.put(rel);
            }
            return new JSONObject().put("missing", missing).toString();
        } catch (JSONException e) {
            return "{\"missing\":[]}";
        }
    }

    /** Downloads one allowed file (once), saying how far it got; checked before it is kept. */
    void download(String id, String rel) {
        work.execute(() -> {
            String[] info = FILES.get(rel);
            if (info == null) {
                finish(id, "download");
                return;
            }
            if (have(rel)) {
                finish(id, null);
                return;
            }
            File file = fileFor(rel);
            File part = new File(file.getPath() + ".part");
            HttpURLConnection connection = null;
            try {
                //noinspection ResultOfMethodCallIgnored
                file.getParentFile().mkdirs();
                long total = Long.parseLong(info[1]);
                connection = (HttpURLConnection) new URL(CDN + info[0]).openConnection();
                connection.setConnectTimeout(20_000);
                connection.setReadTimeout(30_000);
                connection.setInstanceFollowRedirects(true);
                if (connection.getResponseCode() / 100 != 2) throw new IOException("HTTP " + connection.getResponseCode());
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                long done = 0;
                int lastPercent = -3;
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buffer = new byte[64 * 1024];
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        out.write(buffer, 0, n);
                        sha.update(buffer, 0, n);
                        done += n;
                        int percent = (int) (done * 100 / total);
                        if (percent >= lastPercent + 3) {
                            lastPercent = percent;
                            events.send(new JSONObject().put("id", id).put("done", done).put("total", total));
                        }
                    }
                }
                // only the very file Firefox gets is kept
                if (done != total || !hex(sha.digest()).equals(info[2])) throw new IOException("checksum");
                if (!part.renameTo(file)) throw new IOException("rename");
                finish(id, null);
            } catch (IOException | JSONException | NoSuchAlgorithmException | RuntimeException e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                finish(id, "download");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void finish(String id, String code) {
        try {
            JSONObject event = new JSONObject().put("id", id).put("ok", code == null);
            if (code != null) event.put("code", code);
            events.send(event);
        } catch (JSONException ignored) {
            // a constant shape: cannot fail
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }
}
