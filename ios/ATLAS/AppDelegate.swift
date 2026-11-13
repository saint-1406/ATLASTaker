// The iPhone and iPad app: the same page as the Windows and Android apps (index.html and dist/, copied
// into www/ by scripts/ios-assets.mjs), shown in a WKWebView. Its notes and books live in the web
// view's storage (IndexedDB), kept by the app like Android's.

import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
