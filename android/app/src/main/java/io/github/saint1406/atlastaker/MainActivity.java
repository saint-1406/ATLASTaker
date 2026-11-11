package io.github.saint1406.atlastaker;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;
import android.view.ActionMode;
import android.view.Display;
import android.view.Menu;
import android.view.MenuInflater;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.PopupMenu;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * ATLAS on Android: the same page as the desktop app, its notes in the WebView's IndexedDB, served
 * from the app's own assets at https://appassets.androidplatform.net. The native side does what a
 * page cannot do by itself: take files other apps hand over ("Open with", "Share"), save files,
 * use the clipboard, follow the back button, colour the system bars, and sign in with Google for
 * sync: access to the app's own folder on the user's Drive (src/sync/android.js runs the rounds).
 */
public class MainActivity extends ComponentActivity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/assets/www/index.html";
    private static final long MAX_INCOMING = 300L * 1024 * 1024;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService translating = Executors.newSingleThreadExecutor();
    private final Map<String, Translator> translators = new HashMap<>(); // "ru-en" → ML Kit's translator
    private final List<JSONObject> incoming = new ArrayList<>();
    private final AtomicInteger counter = new AtomicInteger();
    private WebView web;
    private WebView printing; // a note being printed (printHtml): kept while the print job reads it
    private File incomingDir;
    private ValueCallback<Uri[]> chooserCallback;
    private byte[] pendingSave;
    private ActivityResultLauncher<Intent> chooser;
    private ActivityResultLauncher<Intent> saver;
    private ActivityResultLauncher<String> microphone;
    private SpeechRecognizer recognizer;
    private boolean dictating;
    private String dictationLanguage = "ru-RU";
    private int silentRounds; // listening rounds in a row that heard nothing: after a few, dictation ends
    // Google sign-in for sync. Google knows this app by its package and signing key (the release key's
    // SHA-1 is registered with the app's Android OAuth client), so a debug-signed build cannot sign in.
    private static final List<Scope> SYNC_SCOPES = Arrays.asList(
            new Scope("https://www.googleapis.com/auth/drive.appdata"), new Scope("email"), new Scope("openid"));
    // Apocrypha: sync's access and the files this app makes on the Drive (drive.file), to share them.
    // Asked for only when the person shares a file, so sync keeps working without a second consent.
    private static final List<Scope> SHARE_SCOPES = Arrays.asList(
            new Scope("https://www.googleapis.com/auth/drive.appdata"), new Scope("https://www.googleapis.com/auth/drive.file"),
            new Scope("email"), new Scope("openid"));
    private ActivityResultLauncher<IntentSenderRequest> authorizer;
    private String authorizeId; // the page's request waiting for the Google sheet
    // A book is open in the page: the page then runs under the status and navigation bars, and they hide
    // until the reading chrome comes up (a tap in the middle of the book). --sys-insets tells the page
    // where they appear, so showing them moves no text (applyReading).
    private boolean reading;
    // In a book the page has its own bar for a selection (copy, mark, quote, translate) at the foot of the
    // screen. The phone's own menu by the selection (Copy, Share, Google's suggestions) would cover it
    // there, so while the page says so (quietSelection) WebView gets a menu that shows nothing (SilentActionMode).
    // A field being typed in keeps it: Paste lives there.
    private volatile boolean quietSelection;
    private boolean barsShown = true;
    private String sysInsets = "";
    private String keyboardInset = "";
    private Updater updater;
    // the document scanner (Scanner.java, src/scanner in the page): its camera view asks for the camera
    // through WebView (getUserMedia); Android's permission is asked for then, once
    private Scanner scanner;
    private ActivityResultLauncher<String> camera;
    private PermissionRequest pendingCamera;

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

        authorizer = registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            String id = authorizeId;
            authorizeId = null;
            if (result.getResultCode() != RESULT_OK || result.getData() == null) {
                sendToken(id, null, "cancelled");
                return;
            }
            try {
                AuthorizationResult granted = Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(result.getData());
                sendToken(id, granted.getAccessToken(), null);
            } catch (ApiException e) {
                sendToken(id, null, "Google " + e.getStatusCode());
            }
        });

        microphone = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (granted) listen();
            else stopDictation("error", "not-allowed");
        });

        camera = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            PermissionRequest request = pendingCamera;
            pendingCamera = null;
            if (request == null) return;
            if (granted) request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else request.deny();
        });

        // pages the scanner made are shown to the page from the cache (/scan/…)
        scanner = new Scanner(this, event -> runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.__atlas && window.__atlas.scan && window.__atlas.scan(" + event + ")", null);
        }));

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/incoming/", new WebViewAssetLoader.InternalStoragePathHandler(this, incomingDir))
                .addPathHandler("/scan/", new WebViewAssetLoader.InternalStoragePathHandler(this, scanner.dir()))
                .build();

        web = new WebView(this) {
            @Override
            public ActionMode startActionMode(ActionMode.Callback callback, int type) {
                if (!quietSelection) return super.startActionMode(callback, type);
                selectionToPage();
                return new SilentActionMode();
            }
        };
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
            /** The scanner's camera view: the page's own camera, only for the app's own page. */
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean ours = HOST.equals(request.getOrigin().getHost());
                    boolean video = Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
                    if (!ours || !video) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        return;
                    }
                    if (pendingCamera != null) pendingCamera.deny();
                    pendingCamera = request;
                    camera.launch(Manifest.permission.CAMERA);
                });
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingCamera == request) pendingCamera = null;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (chooserCallback != null) chooserCallback.onReceiveValue(null);
                chooserCallback = callback;
                boolean many = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                Intent pick;
                if (onlyPictures(params.getAcceptTypes())) {
                    // a picture for a note: straight to the photos (the system's photo picker, or the gallery
                    // before Android 13), not the file manager with every file on the phone
                    if (Build.VERSION.SDK_INT >= 33) {
                        pick = new Intent(MediaStore.ACTION_PICK_IMAGES);
                        if (many) pick.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit());
                    } else {
                        pick = new Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
                        pick.setType("image/*");
                        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, many);
                    }
                } else {
                    // a book or a document (the library, the reader): the file manager, where files are
                    pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("*/*");
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, many);
                }
                try {
                    chooser.launch(pick);
                    return true;
                } catch (ActivityNotFoundException e) {
                    chooserCallback = null;
                    return false;
                }
            }
        });

        // updating from inside the app: answers come to the page as window.__atlas.updateEvent(…)
        updater = new Updater(this, event -> runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.__atlas && window.__atlas.updateEvent && window.__atlas.updateEvent(" + event + ")", null);
        }));
        web.addJavascriptInterface(new Bridge(), "AtlasAndroid");
        setContentView(web);
        ViewCompat.setOnApplyWindowInsetsListener(web, (view, insets) -> {
            tellInsets(insets);
            return ViewCompat.onApplyWindowInsets(view, insets);
        });

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
    protected void onResume() {
        super.onResume();
        // another app may have brought the bars back
        if (reading) applyReading();
    }

    /**
     * While a book is open the window runs under the system bars (and into a camera cutout), so the page
     * keeps one size whether they show or not; outside a book everything is as it always was.
     */
    private void applyReading() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, !reading);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.layoutInDisplayCutoutMode = reading
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            window.setAttributes(attrs);
        }
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (reading && !barsShown) bars.hide(WindowInsetsCompat.Type.systemBars());
        else bars.show(WindowInsetsCompat.Type.systemBars());
        ViewCompat.requestApplyInsets(web);
    }

    /** Where the bars (and the keyboard) sit, in CSS pixels, as top right bottom left; zero outside a book. */
    private void tellInsets(WindowInsetsCompat insets) {
        Insets bars = reading
                ? insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout())
                : Insets.NONE;
        int keyboard = reading ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
        float px = getResources().getDisplayMetrics().density;
        String css = Math.round(bars.top / px) + "px " + Math.round(bars.right / px) + "px "
                + Math.round(bars.bottom / px) + "px " + Math.round(bars.left / px) + "px";
        if (!css.equals(sysInsets)) {
            sysInsets = css;
            web.evaluateJavascript("document.documentElement.style.setProperty('--sys-insets','" + css + "')", null);
            // the bottom one on its own: the book's bars at the foot (fixed to the screen) rise above it
            web.evaluateJavascript("document.documentElement.style.setProperty('--sys-bottom','" + Math.round(bars.bottom / px) + "px')", null);
        }
        // The keyboard is told apart: edge to edge, the window no longer shrinks for it, so what is typed
        // into (a comment on a mark) rises by --kb above it; the book's pages stay as they are.
        String kb = Math.round(keyboard / px) + "px";
        if (!kb.equals(keyboardInset)) {
            keyboardInset = kb;
            web.evaluateJavascript("document.documentElement.style.setProperty('--kb','" + kb + "')", null);
        }
    }

    @Override
    protected void onPause() {
        // Android may stop the app in the background at any time: everything goes to storage now
        if (web != null) web.evaluateJavascript("window.__atlas && window.__atlas.flush && window.__atlas.flush()", null);
        // and the microphone is not left listening behind the reader's back
        if (dictating) stopDictation("end", null);
        super.onPause();
    }

    /** Android is short of memory: the scanner lets its models go (they load again when needed). */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (scanner != null) scanner.trim(level);
    }

    @Override
    protected void onDestroy() {
        if (scanner != null) scanner.shutdown();
        io.shutdown();
        translating.shutdownNow();
        synchronized (translators) {
            for (Translator translator : translators.values()) translator.close();
            translators.clear();
        }
        if (recognizer != null) recognizer.destroy();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ---------- sync: an access token for the app's folder on Google Drive ----------

    /** interactive: may show Google's sheet (account, consent); otherwise answers "needs-login" instead. */
    private void authorize(String id, boolean interactive) {
        authorize(id, interactive, SYNC_SCOPES);
    }

    private void authorize(String id, boolean interactive, List<Scope> scopes) {
        AuthorizationRequest request = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        Identity.getAuthorizationClient(this).authorize(request)
                .addOnSuccessListener(result -> {
                    if (!result.hasResolution()) {
                        sendToken(id, result.getAccessToken(), null);
                    } else if (!interactive) {
                        sendToken(id, null, "needs-login");
                    } else if (authorizeId != null || result.getPendingIntent() == null) {
                        sendToken(id, null, "busy");
                    } else {
                        authorizeId = id;
                        try {
                            authorizer.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                        } catch (RuntimeException e) {
                            authorizeId = null;
                            sendToken(id, null, "failed");
                        }
                    }
                })
                .addOnFailureListener(e -> sendToken(id, null, e instanceof ApiException ? "Google " + ((ApiException) e).getStatusCode() : "failed"));
    }

    /** Play services keeps the tokens it handed out: one Drive refused must go, or the same one comes back. */
    private void forgetToken(String token) {
        try {
            GoogleAuthUtil.clearToken(this, token);
        } catch (Exception ignored) {
            // nothing to forget, or play services is away: the next request asks Google itself
        }
    }

    private void sendToken(String id, String token, String error) {
        if (id == null || web == null) return;
        try {
            JSONObject answer = new JSONObject();
            answer.put("id", id);
            if (token != null) answer.put("token", token);
            else answer.put("error", error == null ? "failed" : error);
            web.evaluateJavascript("window.__atlasSync && window.__atlasSync.token(" + answer + ")", null);
        } catch (JSONException ignored) {
            // nothing to say to the page
        }
    }

    // ---------- dictation: the phone's speech recognition, one phrase at a time, again and again ----------

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {}

        @Override
        public void onBeginningOfSpeech() {}

        @Override
        public void onRmsChanged(float rmsdB) {}

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {}

        @Override
        public void onEvent(int eventType, Bundle params) {}

        @Override
        public void onPartialResults(Bundle partial) {
            String text = firstResult(partial);
            if (text != null) sendDictation("partial", text, null);
        }

        @Override
        public void onResults(Bundle results) {
            String text = firstResult(results);
            if (text != null && !text.isEmpty()) {
                silentRounds = 0;
                sendDictation("final", text, null);
            }
            // the recognizer stops after each phrase; while dictation is on, it listens again
            if (dictating) listen();
        }

        @Override
        public void onError(int error) {
            if (!dictating) return;
            boolean quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
            if (quiet && ++silentRounds < 3) {
                listen();
                return;
            }
            if (quiet) stopDictation("end", null);
            else stopDictation("error", errorCode(error));
        }
    };

    private static String firstResult(Bundle bundle) {
        ArrayList<String> found = bundle == null ? null : bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return found == null || found.isEmpty() ? null : found.get(0);
    }

    private static String errorCode(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
                return "network";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "language";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            default:
                return "failed";
        }
    }

    private void startDictation(String language) {
        dictationLanguage = language == null || language.isEmpty() ? "ru-RU" : language;
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            stopDictation("error", "no-service");
            return;
        }
        dictating = true;
        silentRounds = 0;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) listen();
        else microphone.launch(Manifest.permission.RECORD_AUDIO);
    }

    private void listen() {
        if (!dictating) return;
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(listener);
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, dictationLanguage);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        // Android 13+: punctuation and capitals from the recognizer itself
        if (Build.VERSION.SDK_INT >= 33) intent.putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY);
        try {
            recognizer.startListening(intent);
        } catch (RuntimeException e) {
            stopDictation("error", "failed");
        }
    }

    /** Dictation ends: the recognizer stops, the page hears why ("end", or "error" with a code). */
    private void stopDictation(String type, String code) {
        dictating = false;
        if (recognizer != null) recognizer.cancel();
        sendDictation(type, "", code);
    }

    private void sendDictation(String type, String text, String code) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", type);
            event.put("text", text == null ? "" : text);
            if (code != null) event.put("code", code);
            web.evaluateJavascript("window.__atlas && window.__atlas.dictation && window.__atlas.dictation(" + event + ")", null);
        } catch (JSONException ignored) {
            // nothing to say to the page
        }
    }

    /** True when the page asks for pictures only (accept="image/*", "image/png"…). */
    private static boolean onlyPictures(String[] accept) {
        if (accept == null || accept.length == 0) return false;
        boolean any = false;
        for (String type : accept) {
            if (type == null || type.trim().isEmpty()) continue;
            for (String one : type.split(",")) {
                String t = one.trim().toLowerCase();
                if (t.isEmpty()) continue;
                if (!t.startsWith("image/")) return false;
                any = true;
            }
        }
        return any;
    }

    // ---------- translation: ML Kit, on the phone (src/translate.js asks, window.__atlas.translate hears) ----------

    /** "ru", "en" → ML Kit's language, or null for one it does not know. */
    private static String mlkitLanguage(String tag) {
        return tag == null ? null : TranslateLanguage.fromLanguageTag(tag);
    }

    private Translator translatorFor(String from, String to) {
        String key = from + "-" + to;
        synchronized (translators) {
            Translator translator = translators.get(key);
            if (translator == null) {
                TranslatorOptions options = new TranslatorOptions.Builder().setSourceLanguage(from).setTargetLanguage(to).build();
                translator = Translation.getClient(options);
                translators.put(key, translator);
            }
            return translator;
        }
    }

    /** "ready" when both languages' models are on the phone, "download" when one is missing. Off the main thread. */
    private String translateState(String fromTag, String toTag) {
        String from = mlkitLanguage(fromTag);
        String to = mlkitLanguage(toTag);
        if (from == null || to == null) return "unavailable";
        try {
            Set<TranslateRemoteModel> have = Tasks.await(RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel.class));
            List<String> languages = new ArrayList<>();
            for (TranslateRemoteModel model : have) languages.add(model.getLanguage());
            return languages.contains(from) && languages.contains(to) ? "ready" : "download";
        } catch (Exception e) {
            return "unavailable";
        }
    }

    /** Downloads the models a direction needs (once; the person agreed in the page). */
    private void translatePrepare(String id, String fromTag, String toTag) {
        String from = mlkitLanguage(fromTag);
        String to = mlkitLanguage(toTag);
        if (from == null || to == null) {
            sendTranslation(id, null, "failed");
            return;
        }
        translating.execute(() -> {
            try {
                Tasks.await(translatorFor(from, to).downloadModelIfNeeded(new DownloadConditions.Builder().build()));
                sendTranslation(id, new JSONArray(), null);
            } catch (Exception e) {
                sendTranslation(id, null, "download");
            }
        });
    }

    /** Translates the pieces (a JSON array of strings) one by one; the answer is an array of the same length. */
    private void translate(String id, String fromTag, String toTag, String piecesJson) {
        String from = mlkitLanguage(fromTag);
        String to = mlkitLanguage(toTag);
        if (from == null || to == null) {
            sendTranslation(id, null, "failed");
            return;
        }
        translating.execute(() -> {
            try {
                if (!"ready".equals(translateState(fromTag, toTag))) {
                    sendTranslation(id, null, "no-model");
                    return;
                }
                Translator translator = translatorFor(from, to);
                JSONArray pieces = new JSONArray(piecesJson == null ? "[]" : piecesJson);
                JSONArray out = new JSONArray();
                for (int i = 0; i < pieces.length(); i++) out.put(Tasks.await(translator.translate(pieces.optString(i, ""))));
                sendTranslation(id, out, null);
            } catch (Exception e) {
                sendTranslation(id, null, "failed");
            }
        });
    }

    // ---------- translation: Yandex Translate with the person's own API key (src/translate.js) ----------

    private static final String YANDEX_TRANSLATE = "https://translate.api.cloud.yandex.net/translate/v2/translate";

    /**
     * The pieces (a JSON array of strings) through Yandex Cloud's API v2; the page cannot ask it itself.
     * Codes as the desktop's (server/translate.js): yandex-key, yandex-quota, network, failed.
     */
    private void yandexTranslate(String id, String key, String from, String to, String piecesJson) {
        translating.execute(() -> {
            HttpURLConnection connection = null;
            try {
                String apiKey = key == null ? "" : key.trim();
                if (apiKey.isEmpty() || apiKey.length() > 400 || apiKey.contains("\n") || apiKey.contains("\r")
                        || !("ru".equals(from) || "en".equals(from)) || !("ru".equals(to) || "en".equals(to))) {
                    sendTranslation(id, null, "failed");
                    return;
                }
                JSONArray pieces = new JSONArray(piecesJson);
                JSONObject request = new JSONObject();
                request.put("sourceLanguageCode", from);
                request.put("targetLanguageCode", to);
                request.put("format", "PLAIN_TEXT");
                request.put("texts", pieces);
                byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
                connection = (HttpURLConnection) new URL(YANDEX_TRANSLATE).openConnection();
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(20_000);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Authorization", "Api-Key " + apiKey);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(body);
                }
                int status = connection.getResponseCode();
                if (status == 401 || status == 403) {
                    sendTranslation(id, null, "yandex-key");
                    return;
                }
                if (status == 429) {
                    sendTranslation(id, null, "yandex-quota");
                    return;
                }
                if (status / 100 != 2) {
                    sendTranslation(id, null, "failed");
                    return;
                }
                java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                try (InputStream in = connection.getInputStream()) {
                    byte[] chunk = new byte[16 * 1024];
                    for (int n; (n = in.read(chunk)) > 0; ) buffer.write(chunk, 0, n);
                }
                JSONArray translations = new JSONObject(buffer.toString(StandardCharsets.UTF_8.name())).optJSONArray("translations");
                if (translations == null || translations.length() != pieces.length()) {
                    sendTranslation(id, null, "failed");
                    return;
                }
                JSONArray texts = new JSONArray();
                for (int i = 0; i < translations.length(); i++) texts.put(translations.getJSONObject(i).optString("text", ""));
                sendTranslation(id, texts, null);
            } catch (IOException e) {
                sendTranslation(id, null, "network");
            } catch (JSONException | RuntimeException e) {
                sendTranslation(id, null, "failed");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void sendTranslation(String id, JSONArray texts, String code) {
        try {
            JSONObject event = new JSONObject();
            event.put("id", id == null ? "" : id);
            event.put("ok", code == null);
            if (texts != null) event.put("texts", texts);
            if (code != null) event.put("code", code);
            String script = "window.__atlas && window.__atlas.translate && window.__atlas.translate(" + event + ")";
            runOnUiThread(() -> {
                if (web != null) web.evaluateJavascript(script, null);
            });
        } catch (JSONException ignored) {
            // nothing to say to the page
        }
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

    /**
     * A selection was made or moved (WebView asks for its menu): the page looks at it again and puts up
     * its own bar, whatever events this phone's WebView did or did not send it.
     */
    private void selectionToPage() {
        if (web == null) return;
        web.post(() -> web.evaluateJavascript("document.dispatchEvent(new Event('selectionchange'))", null));
    }

    /** A selection handle is being dragged (or the page scrolled), or that has ended: see SilentActionMode. */
    private void selectionMoving(boolean moving) {
        if (web == null) return;
        String script = "document.dispatchEvent(new CustomEvent('atlas-selection-moving',{detail:" + moving + "}))";
        web.post(() -> web.evaluateJavascript(script, null));
    }

    /**
     * The selection's menu while quietSelection is on (see there): one that shows nothing and never ends by
     * itself. An emptied real menu was no good: some phones (Xiaomi) close an empty menu at once, and
     * WebView drops the selection whenever its menu is closed by anyone but itself. WebView lets go of this
     * one on its own (finish), and the page puts up its own bar.
     */
    private final class SilentActionMode extends ActionMode {
        private Menu menu;
        private CharSequence title;
        private CharSequence subtitle;
        private View custom;

        @Override public void setTitle(CharSequence text) { title = text; }
        @Override public void setTitle(int resId) { title = MainActivity.this.getString(resId); }
        @Override public void setSubtitle(CharSequence text) { subtitle = text; }
        @Override public void setSubtitle(int resId) { subtitle = MainActivity.this.getString(resId); }
        @Override public void setCustomView(View view) { custom = view; }
        @Override public void invalidate() { selectionToPage(); } // the selection moved
        @Override public void finish() { }

        // WebView hides its menu for a long while (and again every few seconds) while a selection handle is
        // dragged or the page scrolls, and for a moment when that ends: the page waits for the end before
        // it puts up its card.
        @Override
        public void hide(long duration) {
            selectionMoving(duration >= 1000);
        }
        @Override public CharSequence getTitle() { return title; }
        @Override public CharSequence getSubtitle() { return subtitle; }
        @Override public View getCustomView() { return custom; }
        @Override public MenuInflater getMenuInflater() { return new MenuInflater(MainActivity.this); }

        @Override
        public Menu getMenu() {
            if (menu == null) menu = new PopupMenu(MainActivity.this, web).getMenu();
            return menu;
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

        /**
         * Prints a page of HTML (a note exported as PDF): Android's own printing, whose "Save as PDF"
         * printer makes the file. The page is laid out in a WebView of its own, with no scripts.
         */
        @JavascriptInterface
        public void printHtml(String html, String title) {
            final String name = title == null || title.trim().isEmpty() ? "ATLAS" : title.trim();
            runOnUiThread(() -> {
                WebView page = new WebView(MainActivity.this);
                page.getSettings().setJavaScriptEnabled(false);
                page.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        PrintManager printer = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                        if (printer == null) return;
                        printer.print(name, view.createPrintDocumentAdapter(name), new PrintAttributes.Builder().build());
                    }
                });
                printing = page; // held until the next print: the print job reads from it
                page.loadDataWithBaseURL(null, html == null ? "" : html, "text/html", "UTF-8", null);
            });
        }

        /** An access token for sync; the answer comes through window.__atlasSync.token({ id, token | error }). */
        @JavascriptInterface
        public void syncAuthorize(String id, boolean interactive) {
            runOnUiThread(() -> authorize(id, interactive));
        }

        /** The same, with access to the files this app makes on the Drive: Apocrypha shares them. */
        @JavascriptInterface
        public void shareAuthorize(String id, boolean interactive) {
            runOnUiThread(() -> authorize(id, interactive, SHARE_SCOPES));
        }

        /** The newest release on GitHub; the answer comes as window.__atlas.updateEvent({ type: 'check', … }). */
        @JavascriptInterface
        public void checkUpdate() {
            updater.check();
        }

        /** Downloads the new version, checks it and hands it to Android's installer (Updater). */
        @JavascriptInterface
        public void installUpdate(boolean askPermission) {
            updater.install(askPermission);
        }

        @JavascriptInterface
        public String appVersion() {
            return updater.currentVersion();
        }

        /** Drive refused this token: the phone forgets it, so the next authorize gets a fresh one, not the same. */
        @JavascriptInterface
        public void syncClearToken(String token) {
            if (token == null || token.isEmpty()) return;
            io.execute(() -> forgetToken(token));
        }

        /** Signing out: Google forgets the app's access (the next sign-in asks for an account again) and the phone its token. */
        @JavascriptInterface
        public void syncSignOut(String token) {
            if (token == null || token.isEmpty()) return;
            io.execute(() -> {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL("https://oauth2.googleapis.com/revoke").openConnection();
                    connection.setRequestMethod("POST");
                    connection.setDoOutput(true);
                    connection.setConnectTimeout(15_000);
                    connection.setReadTimeout(15_000);
                    connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                    try (OutputStream out = connection.getOutputStream()) {
                        out.write(("token=" + URLEncoder.encode(token, "UTF-8")).getBytes(StandardCharsets.UTF_8));
                    }
                    connection.getResponseCode();
                } catch (IOException ignored) {
                    // offline: the token runs out within the hour anyway, and it is forgotten here below
                } finally {
                    if (connection != null) connection.disconnect();
                }
                forgetToken(token);
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> openOutside(url));
        }

        /** Whether the phone has a speech recognition service at all (usually the Google app). */
        @JavascriptInterface
        public boolean canDictate() {
            return SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
        }

        /** language: "ru-RU", "en-US"… Results come back through window.__atlas.dictation(event). */
        @JavascriptInterface
        public void startDictation(String language) {
            runOnUiThread(() -> MainActivity.this.startDictation(language));
        }

        @JavascriptInterface
        public void stopDictation() {
            runOnUiThread(() -> {
                if (dictating) MainActivity.this.stopDictation("end", null);
            });
        }

        /** "ready", "download" or "unavailable" for a direction ("ru", "en"). */
        @JavascriptInterface
        public String translateState(String from, String to) {
            return MainActivity.this.translateState(from, to);
        }

        /** Downloads a direction's language models; the answer comes through window.__atlas.translate({ id, ok }). */
        @JavascriptInterface
        public void translatePrepare(String id, String from, String to) {
            MainActivity.this.translatePrepare(id, from, to);
        }

        /** pieces: a JSON array of strings; the answer: window.__atlas.translate({ id, ok, texts } or { id, ok: false, code }). */
        @JavascriptInterface
        public void translate(String id, String from, String to, String pieces) {
            MainActivity.this.translate(id, from, to, pieces);
        }

        /** Yandex Translate with the key the person gave (kept in the page); the answer comes as translate(event). */
        @JavascriptInterface
        public void yandexTranslate(String id, String key, String from, String to, String pieces) {
            MainActivity.this.yandexTranslate(id, key, from, to, pieces);
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

        /** A book is open and nothing is being typed: the phone's menu by a selection stays away (quieted). */
        @JavascriptInterface
        public void quietSelection(boolean on) {
            quietSelection = on;
        }

        /** A book is open (or not), and its chrome is up (or not): the system bars follow (applyReading). */
        @JavascriptInterface
        public void setReading(boolean on, boolean shown) {
            runOnUiThread(() -> {
                if (reading == on && barsShown == shown) return;
                reading = on;
                barsShown = shown;
                applyReading();
            });
        }

        /**
         * How often the screen redraws while ATLAS is in front: high is the fastest the screen can (90, 120,
         * 144 Hz), else 60 Hz. Some phones hold an app at 60 Hz unless it asks. Returns the fastest rate.
         */
        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public float setFrameRate(boolean high) {
            float fastest = 60f;
            Display display = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? getDisplay() : getWindowManager().getDefaultDisplay();
            if (display == null) return fastest;
            Display.Mode current = display.getMode();
            Display.Mode best = null;
            for (Display.Mode mode : display.getSupportedModes()) {
                // only the modes at this resolution: a refresh rate must not change how sharp the screen is
                if (mode.getPhysicalWidth() != current.getPhysicalWidth() || mode.getPhysicalHeight() != current.getPhysicalHeight()) continue;
                fastest = Math.max(fastest, mode.getRefreshRate());
                if (best == null) best = mode;
                else if (high ? mode.getRefreshRate() > best.getRefreshRate() : Math.abs(mode.getRefreshRate() - 60f) < Math.abs(best.getRefreshRate() - 60f)) best = mode;
            }
            Display.Mode chosen = best;
            runOnUiThread(() -> {
                Window window = getWindow();
                WindowManager.LayoutParams attrs = window.getAttributes();
                attrs.preferredDisplayModeId = chosen == null ? 0 : chosen.getModeId();
                attrs.preferredRefreshRate = chosen == null ? 0f : chosen.getRefreshRate();
                window.setAttributes(attrs);
            });
            return fastest;
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

        // ---------- the document scanner (Scanner.java); answers come as window.__atlas.scan(event) ----------

        /** JSON: { ok, engine, abi, … }; ok is false on a phone the recognizer is not built for. */
        @JavascriptInterface
        public String scanInfo() {
            return scanner.info();
        }

        /** A photo begins (id: [a-z0-9-]); its bytes follow in base64 pieces through scanAppend. */
        @JavascriptInterface
        public boolean scanBegin(String id) {
            return scanner.begin(id);
        }

        @JavascriptInterface
        public boolean scanAppend(String id, String base64) {
            return scanner.append(id, base64);
        }

        /** options (JSON): quad [[x, y] × 4] as fractions of the photo, rotate, maxSide, recognize, autoRotate. */
        @JavascriptInterface
        public void scanProcess(String id, String options) {
            scanner.process(id, options);
        }

        @JavascriptInterface
        public void scanCancel(String id) {
            scanner.cancel(id);
        }

        @JavascriptInterface
        public void scanDrop(String id) {
            scanner.drop(id);
        }

        /** The scanner closed: models out of memory, pages out of the cache. */
        @JavascriptInterface
        public void scanClose() {
            scanner.close();
        }
    }
}
