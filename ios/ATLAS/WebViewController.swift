import UIKit
import WebKit

/**
 * The page in a WKWebView, inside the safe area (clear of the notch and the home bar). The native side
 * does what a page cannot by itself: files the page hands out (a backup, an export) go to the share
 * sheet, links to other sites open in Safari, the bars around the page take its colour.
 *
 * The page knows it runs here by window.AtlasIOS; it talks to this side with
 * window.webkit.messageHandlers.atlas.postMessage({ type, … }).
 */
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var lightPage = false

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let marker = "window.AtlasIOS = Object.freeze({ platform: 'ios', version: '\(version)' });"
        config.userContentController.addUserScript(WKUserScript(source: marker, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "atlas")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = .clear
        if #available(iOS 16.4, *) {
            // the page can be looked into from Safari on a Mac (Develop menu)
            web.isInspectable = true
        }
        webView = web

        let container = UIView()
        container.backgroundColor = UIColor(red: 0.075, green: 0.075, blue: 0.08, alpha: 1)
        container.addSubview(web)
        web.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: container.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.trailingAnchor),
        ])
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let start = URL(string: "\(AppSchemeHandler.scheme)://localhost/index.html") {
            webView.load(URLRequest(url: start))
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        lightPage ? .darkContent : .lightContent
    }

    // ---------- the page's messages ----------

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "bars" {
            // the page's background around it, and status bar icons that read on it
            if let color = UIColor(css: body["color"] as? String ?? "") { view.backgroundColor = color }
            lightPage = body["light"] as? Bool ?? false
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    // ---------- where links go ----------

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel)
            return
        }
        if [AppSchemeHandler.scheme, "blob", "data", "about"].contains(scheme) {
            decisionHandler(.allow)
            return
        }
        // the page itself never leaves the app: another site opens in Safari
        if navigationAction.targetFrame?.isMainFrame ?? true {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /** window.open (a link for another site): Safari. */
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" || scheme == "mailto" {
            UIApplication.shared.open(url)
        }
        return nil
    }

    /** The camera (the document scanner): the page asked, the system asks the person. */
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    /** The page went blank (the system took its process back): it comes back. */
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // ---------- files the page hands out: to the share sheet (Files, AirDrop, mail…) ----------

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            completionHandler(nil)
            return
        }
        let name = suggestedFilename.isEmpty ? "ATLAS" : suggestedFilename
        let file = folder.appendingPathComponent(name)
        downloads[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        if let popover = share.popoverPresentationController {
            // on an iPad the sheet points at the foot of the page
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 60, width: 1, height: 1)
        }
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }
}

private extension UIColor {
    /** "#rrggbb", "#rgb" or "rgb(r, g, b)" as the page gives its colours; nil for anything else. */
    convenience init?(css: String) {
        let text = css.trimmingCharacters(in: .whitespaces).lowercased()
        var r = 0.0, g = 0.0, b = 0.0
        if text.hasPrefix("#") {
            var hex = String(text.dropFirst())
            if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
            guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
            r = Double((value >> 16) & 0xff)
            g = Double((value >> 8) & 0xff)
            b = Double(value & 0xff)
        } else if text.hasPrefix("rgb") {
            let parts = text.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }.split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) ?? -1 }
            guard parts.count >= 3, parts[0...2].allSatisfy({ $0 >= 0 && $0 <= 255 }) else { return nil }
            r = parts[0]
            g = parts[1]
            b = parts[2]
        } else {
            return nil
        }
        self.init(red: r / 255, green: g / 255, blue: b / 255, alpha: 1)
    }
}
