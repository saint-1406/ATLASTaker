import Foundation
import WebKit

/**
 * Serves the page from the app itself at atlas://localhost/… (the www folder in the bundle). A page
 * of its own scheme has an origin of its own, so it keeps IndexedDB and localStorage like a site, and
 * the page's CSP ('self') holds as it does on Android and Windows.
 */
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "atlas"

    private let root: URL

    override init() {
        root = (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("www", isDirectory: true).standardizedFileURL
        super.init()
    }

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "md": "text/markdown; charset=utf-8",
        "png": "image/png",
        "jpg": "image/jpeg",
        "webp": "image/webp",
        "svg": "image/svg+xml",
        "ico": "image/x-icon",
        "woff2": "font/woff2",
        "woff": "font/woff",
        "ttf": "font/ttf",
        "wasm": "application/wasm",
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        // only what is inside www/, and only files
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            respond(urlSchemeTask, url: url, status: 404, type: "text/plain; charset=utf-8", data: Data("not found".utf8))
            return
        }
        let type = AppSchemeHandler.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        respond(urlSchemeTask, url: url, status: 200, type: type, data: data)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // every answer is given at once: nothing to stop
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, data: Data) {
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}
