package io.github.saint1406.atlastaker;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Updating ATLAS from inside the app. The newest release on GitHub is asked for, its APK downloaded
 * here and checked: the size and the SHA-256 GitHub lists for it, the same package, a newer version,
 * and the same signing key as this install. Only a file that passes all of that goes to Android's
 * installer, which puts the new version over the old one: the notes, books and marks stay. A file
 * broken on the way never reaches the installer, so nobody is led to remove the app to "fix" it.
 *
 * Events go to the page as window.__atlas.updateEvent({ type, … }):
 *   check     { current, version, newer, size, notes, page }
 *   progress  { done, total }
 *   verified  { version }                 the file passed; the installer opens next
 *   permission                            Android needs "install unknown apps" allowed for ATLAS first
 *   error     { step, message }           step: check | download | verify | install
 */
final class Updater {
    private static final String LATEST = "https://api.github.com/repos/saint-1406/ATLASTaker/releases/latest";
    private static final String APK_TYPE = "application/vnd.android.package-archive";

    interface Events {
        void send(JSONObject event);
    }

    private final Activity activity;
    private final Events events;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private JSONObject latest; // the last check's APK: version, url, size, sha256
    private File verified; // a downloaded file that passed every check, kept until it is installed
    private String verifiedVersion = "";

    Updater(Activity activity, Events events) {
        this.activity = activity;
        this.events = events;
    }

    void check() {
        work.execute(this::checkNow);
    }

    /** askPermission: the person tapped "Update", so Android's settings page may open; a retry never reopens it. */
    void install(boolean askPermission) {
        work.execute(() -> installNow(askPermission));
    }

    String currentVersion() {
        PackageInfo info = ownInfo(0);
        return info == null || info.versionName == null ? "" : info.versionName;
    }

    // ---------- asking GitHub ----------

    private void checkNow() {
        try {
            JSONObject release = new JSONObject(readText(LATEST));
            String version = release.optString("tag_name", "").replaceFirst("^v", "");
            JSONObject apk = null;
            JSONArray assets = release.optJSONArray("assets");
            for (int i = 0; assets != null && i < assets.length(); i++) {
                JSONObject asset = assets.getJSONObject(i);
                if (asset.optString("name", "").endsWith("-android.apk")) apk = asset;
            }
            if (apk == null) throw new IOException("no APK in release " + version);
            String digest = apk.optString("digest", "");
            JSONObject found = new JSONObject();
            found.put("version", version);
            found.put("url", apk.getString("browser_download_url"));
            found.put("size", apk.getLong("size"));
            found.put("sha256", digest.startsWith("sha256:") ? digest.substring(7).toLowerCase(Locale.ROOT) : "");
            latest = found;
            JSONObject event = event("check");
            event.put("current", currentVersion());
            event.put("version", version);
            event.put("newer", newer(version, currentVersion()));
            event.put("size", apk.getLong("size"));
            event.put("notes", release.optString("body", ""));
            event.put("page", release.optString("html_url", ""));
            events.send(event);
        } catch (IOException | JSONException e) {
            error("check", e);
        }
    }

    /** "0.16.0" newer than "0.15.0"; a part that is not a number counts as 0. */
    static boolean newer(String candidate, String current) {
        String[] a = candidate.split("\\.");
        String[] b = current.split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int x = i < a.length ? number(a[i]) : 0;
            int y = i < b.length ? number(b[i]) : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static int number(String part) {
        try {
            return Integer.parseInt(part.replaceAll("[^0-9].*$", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // ---------- downloading, checking, installing ----------

    private void installNow(boolean askPermission) {
        try {
            if (latest == null) checkNow();
            if (latest == null) return; // the check said why
            String version = latest.getString("version");
            if (!newer(version, currentVersion())) {
                error("check", new IOException("already " + currentVersion()));
                return;
            }
            if (verified == null || !verified.isFile() || !version.equals(verifiedVersion)) {
                File file = download(latest);
                if (file == null) return;
                if (!verify(file, latest)) {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                    return;
                }
                verified = file;
                verifiedVersion = version;
            }
            JSONObject ok = event("verified");
            ok.put("version", version);
            events.send(ok);
            // Android 8+: ATLAS may hand a file to the installer only once the person allowed it in the settings
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                events.send(event("permission"));
                if (!askPermission) return;
                activity.runOnUiThread(() -> {
                    try {
                        activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
                    } catch (RuntimeException ignored) {
                        // no such settings page here: the installer will ask itself
                    }
                });
                return;
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", verified);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, APK_TYPE)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.runOnUiThread(() -> {
                try {
                    activity.startActivity(intent);
                } catch (RuntimeException e) {
                    error("install", e);
                }
            });
        } catch (JSONException | RuntimeException e) {
            error("install", e);
        }
    }

    /** The APK into the app's cache (updates/), with its SHA-256 worked out on the way. */
    private File download(JSONObject apk) {
        File dir = new File(activity.getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        HttpURLConnection connection = null;
        try {
            String version = apk.getString("version");
            long total = apk.getLong("size");
            File file = new File(dir, "ATLASTaker-" + version.replaceAll("[^0-9A-Za-z.]", "") + ".apk");
            connection = open(apk.getString("url"), false);
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            long done = 0;
            int lastPercent = -3;
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) > 0; ) {
                    out.write(buffer, 0, n);
                    sha.update(buffer, 0, n);
                    done += n;
                    int percent = total > 0 ? (int) (done * 100 / total) : 0;
                    if (percent >= lastPercent + 3) {
                        lastPercent = percent;
                        JSONObject progress = event("progress");
                        progress.put("done", done);
                        progress.put("total", total);
                        events.send(progress);
                    }
                }
            }
            apk.put("downloaded", hex(sha.digest()));
            apk.put("downloadedSize", done);
            return file;
        } catch (IOException | JSONException | NoSuchAlgorithmException e) {
            error("download", e);
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Every check a broken or foreign file would fail; false after telling the page which. */
    private boolean verify(File file, JSONObject apk) {
        try {
            long size = apk.getLong("size");
            if (apk.optLong("downloadedSize", -1) != size || file.length() != size) {
                return fail("size " + file.length() + " / " + size);
            }
            String expected = apk.optString("sha256", "");
            if (!expected.isEmpty() && !expected.equals(apk.optString("downloaded"))) return fail("sha256");
            PackageManager pm = activity.getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            PackageInfo theirs = pm.getPackageArchiveInfo(file.getAbsolutePath(), flags);
            if (theirs == null) return fail("not an Android app");
            if (!activity.getPackageName().equals(theirs.packageName)) return fail("package " + theirs.packageName);
            PackageInfo mine = ownInfo(flags);
            if (mine != null && versionCode(theirs) <= versionCode(mine)) return fail("version " + versionCode(theirs));
            // the same key as this install, or Android would refuse the update; where the phone cannot read the
            // key from a file (Android 8 reads only old-style signatures), the installer checks it itself
            byte[][] theirKeys = keys(theirs);
            byte[][] myKeys = mine == null ? null : keys(mine);
            if (theirKeys != null && myKeys != null && !sameKeys(theirKeys, myKeys)) return fail("signing key");
            return true;
        } catch (JSONException | RuntimeException e) {
            error("verify", e);
            return false;
        }
    }

    private boolean fail(String what) {
        error("verify", new IOException(what));
        return false;
    }

    // ---------- small helpers ----------

    @SuppressWarnings("deprecation")
    private PackageInfo ownInfo(int flags) {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), flags);
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    /** SHA-256 of each signing certificate, or null where the phone does not say. */
    @SuppressWarnings("deprecation")
    private static byte[][] keys(PackageInfo info) {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= 28) {
            SigningInfo signing = info.signingInfo;
            if (signing == null) return null;
            signatures = signing.hasMultipleSigners() ? signing.getApkContentsSigners() : signing.getSigningCertificateHistory();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) return null;
        byte[][] out = new byte[signatures.length][];
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            for (int i = 0; i < signatures.length; i++) out[i] = sha.digest(signatures[i].toByteArray());
        } catch (NoSuchAlgorithmException e) {
            return null;
        }
        return out;
    }

    /** At least one certificate in common (a rotated key keeps the old one in its history). */
    private static boolean sameKeys(byte[][] a, byte[][] b) {
        for (byte[] x : a) {
            for (byte[] y : b) {
                if (Arrays.equals(x, y)) return true;
            }
        }
        return false;
    }

    /** api: GitHub's API wants its own Accept header; the file itself comes over from another address. */
    private static HttpURLConnection open(String url, boolean api) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "ATLAS-Notetaker");
        if (api) connection.setRequestProperty("Accept", "application/vnd.github+json");
        int status = connection.getResponseCode();
        if (status / 100 != 2) {
            connection.disconnect();
            throw new IOException("HTTP " + status);
        }
        return connection;
    }

    private static String readText(String url) throws IOException {
        HttpURLConnection connection = open(url, true);
        try (InputStream in = connection.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } finally {
            connection.disconnect();
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }

    private static JSONObject event(String type) {
        JSONObject event = new JSONObject();
        try {
            event.put("type", type);
        } catch (JSONException ignored) {
            // a constant key and value: cannot fail
        }
        return event;
    }

    private void error(String step, Exception e) {
        JSONObject event = event("error");
        try {
            event.put("step", step);
            event.put("message", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        } catch (JSONException ignored) {
            // plain strings: cannot fail
        }
        events.send(event);
    }
}
