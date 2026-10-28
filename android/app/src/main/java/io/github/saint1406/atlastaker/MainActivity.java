package io.github.saint1406.atlastaker;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * ATLAS on Android: the same page as the desktop app, its notes in the WebView's IndexedDB, served
 * from the app's own assets at https://appassets.androidplatform.net. The native side does what a
 * page cannot do by itself: take files other apps hand over ("Open with", "Share"), save files,
 * use the clipboard, follow the back button, colour the system bars.
 */
public class MainActivity extends ComponentActivity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/assets/www/index.html";
    private static final long MAX_INCOMING = 300L * 1024 * 1024;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final List<JSONObject> incoming = new ArrayList<>();
    private final AtomicInteger counter = new AtomicInteger();
    private WebView web;
    private File incomingDir;
    private ValueCallback<Uri[]> chooserCallback;
    private byte[] pendingSave;
    private ActivityResultLauncher<Intent> chooser;
    private ActivityResultLauncher<Intent> saver;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // files handed over earlier and never taken (the app was closed first) are not wanted any more
        incomingDir = new File(getFilesDir(), "incoming");
        File[] leftovers = incomingDir.listFiles();
        if (leftovers != null) for (File f : leftovers) f.delete();
        incomingDir.mkdirs();

        chooser = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            Uri[] picked = null;
            Intent data = result.getData();
            if (result.getResultCode() == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    picked = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) picked[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    picked = new Uri[] { data.getData() };
                }
            }
            if (chooserCallback != null) chooserCallback.onReceiveValue(picked);
            chooserCallback = null;
        });

        saver = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            byte[] bytes = pendingSave;
            pendingSave = null;
            Intent data = result.getData();
            if (result.getResultCode() != RESULT_OK || data == null || data.getData() == null || bytes == null) return;
            Uri target = data.getData();
            io.execute(() -> {
                boolean ok = false;
                try (OutputStream out = getContentResolver().openOutputStream(target)) {
                    if (out != null) {
                        out.write(bytes);
                        ok = true;
                    }
                } catch (Exception e) {
                    ok = false;
                }
                final boolean saved = ok;
                runOnUiThread(() -> Toast.makeText(this, saved ? R.string.saved : R.string.not_saved, Toast.LENGTH_SHORT).show());
            });
        });

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/incoming/", new WebViewAssetLoader.InternalStoragePathHandler(this, incomingDir))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#09090b"));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setTextZoom(100); // the page has its own text size setting
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                openOutside(url.toString()); // links in notes and books open in the browser, never in here
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooserCallback != null) chooserCallback.onReceiveValue(null);
                chooserCallback = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    chooser.launch(pick);
                    return true;
                } catch (ActivityNotFoundException e) {
                    chooserCallback = null;
                    return false;
                }
            }
        });

        web.addJavascriptInterface(new Bridge(), "AtlasAndroid");
        setContentView(web);

        // Back closes what is open in the page (a dialog, the reader, the shelf, the notes list);
        // with nothing left to close, ATLAS goes to the background and keeps its place
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                web.evaluateJavascript("window.__atlas && window.__atlas.back ? window.__atlas.back() : false", value -> {
                    if (!"true".equals(value)) moveTaskToBack(true);
                });
            }
        });

        if (savedInstanceState == null) receive(getIntent());
        web.loadUrl(START);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        receive(intent);
    }

    @Override
    protected void onPause() {
        // Android may stop the app in the background at any time: everything goes to storage now
        if (web != null) web.evaluateJavascript("window.__atlas && window.__atlas.flush && window.__atlas.flush()", null);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** Copies the files of a "view" or "share" intent where the page can fetch them: /incoming/<file>. */
    @SuppressWarnings("deprecation")
    private void receive(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream != null) uris.add(stream);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (streams != null) uris.addAll(streams);
        }
        if (uris.isEmpty()) return;
        io.execute(() -> {
            int taken = 0;
            for (Uri uri : uris) if (copyIn(uri)) taken++;
            final boolean any = taken > 0;
            final boolean all = taken == uris.size();
            runOnUiThread(() -> {
                if (!all) Toast.makeText(this, R.string.not_received, Toast.LENGTH_LONG).show();
                if (any) web.evaluateJavascript("window.__atlas && window.__atlas.incoming && window.__atlas.incoming()", null);
            });
        });
    }

    private boolean copyIn(Uri uri) {
        String name = displayName(uri);
        // the file on disk gets a plain name; the page learns the real one from takeIncoming()
        String file = System.currentTimeMillis() + "-" + counter.incrementAndGet() + extension(name);
        File target = new File(incomingDir, file);
        long size = 0;
        try (InputStream in = getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new IllegalStateException("no stream");
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) {
                size += n;
                if (size > MAX_INCOMING) throw new IllegalStateException("too big");
                out.write(buffer, 0, n);
            }
        } catch (Exception e) {
            target.delete();
            return false;
        }
        try {
            JSONObject entry = new JSONObject();
            entry.put("file", file);
            entry.put("name", name);
            String type = getContentResolver().getType(uri);
            entry.put("type", type == null ? "" : type);
            synchronized (incoming) {
                incoming.add(entry);
            }
            return true;
        } catch (JSONException e) {
            target.delete();
            return false;
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
                // no name: the last part of the address will do
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        return name == null || name.isEmpty() ? "document" : name;
    }

    private static String extension(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".fb2.zip")) return ".fb2.zip";
        int dot = lower.lastIndexOf('.');
        String ext = dot < 0 ? "" : lower.substring(dot);
        return ext.matches("\\.[a-z0-9]{1,8}") ? ext : "";
    }

    private void openOutside(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme) && !"mailto".equals(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // nothing on the phone opens it
        }
    }

    /** window.AtlasAndroid in the page (src/bridge.js). Called on a background thread. */
    private class Bridge {
        /** The files waiting for the page, as JSON [{ file, name, type }]; each is handed out once. */
        @JavascriptInterface
        public String takeIncoming() {
            synchronized (incoming) {
                JSONArray list = new JSONArray(incoming);
                incoming.clear();
                return list.toString();
            }
        }

        /** The page has the file now: the copy goes. */
        @JavascriptInterface
        public void release(String file) {
            if (file == null || file.isEmpty() || file.contains("/") || file.contains("\\") || file.startsWith(".")) return;
            new File(incomingDir, file).delete();
        }

        /** Asks where to save a file (Android's own dialog), then writes it there. */
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            final byte[] bytes;
            try {
                bytes = Base64.decode(base64, Base64.DEFAULT);
            } catch (IllegalArgumentException e) {
                return;
            }
            runOnUiThread(() -> {
                pendingSave = bytes;
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                save.addCategory(Intent.CATEGORY_OPENABLE);
                save.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                save.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    saver.launch(save);
                } catch (ActivityNotFoundException e) {
                    pendingSave = null;
                    Toast.makeText(MainActivity.this, R.string.not_saved, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> openOutside(url));
        }

        @JavascriptInterface
        public boolean copy(String text) {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null || text == null) return false;
            clipboard.setPrimaryClip(ClipData.newPlainText("ATLAS", text));
            return true;
        }

        @JavascriptInterface
        public String paste() {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null || !clipboard.hasPrimaryClip()) return "";
            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(MainActivity.this);
            return text == null ? "" : text.toString();
        }

        /** The status and navigation bars take the page's background; light icons on dark, dark on light. */
        @JavascriptInterface
        public void setBars(String color, boolean light) {
            runOnUiThread(() -> {
                int parsed;
                try {
                    parsed = Color.parseColor(color == null ? "" : color.trim());
                } catch (IllegalArgumentException e) {
                    return;
                }
                Window window = getWindow();
                window.setStatusBarColor(parsed);
                window.setNavigationBarColor(parsed);
                web.setBackgroundColor(parsed);
                WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
                bars.setAppearanceLightStatusBars(light);
                bars.setAppearanceLightNavigationBars(light);
            });
        }
    }
}
