import Foundation
import WebKit

struct BrowserFailure: Equatable {
    let title: String
    let message: String
}

@MainActor
final class GameBrowserModel: ObservableObject {
    @Published private(set) var isLoading = true
    @Published private(set) var hasVisiblePage = false
    @Published private(set) var failure: BrowserFailure?
    @Published private(set) var currentURL: URL?

    let configuration: AppConfiguration
    let navigationPolicy: BrowserNavigationPolicy
    let urlRouter: AppURLRouter

    private weak var webView: WKWebView?
    private var pendingURL: URL?

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        navigationPolicy = BrowserNavigationPolicy(gameBaseURL: configuration.gameURL)
        urlRouter = AppURLRouter(gameBaseURL: configuration.gameURL)
        pendingURL = configuration.gameURL
    }

    func attach(_ webView: WKWebView) {
        guard self.webView !== webView else { return }
        self.webView = webView
        let destination = pendingURL ?? currentURL ?? configuration.gameURL
        pendingURL = nil
        load(destination)
    }

    func detach(_ webView: WKWebView) {
        if self.webView === webView {
            self.webView = nil
        }
    }

    @discardableResult
    func openIncomingURL(_ incomingURL: URL) -> Bool {
        guard let destination = urlRouter.destination(for: incomingURL) else { return false }
        load(destination)
        return true
    }

    func load(_ url: URL) {
        guard navigationPolicy.isGameURL(url) else { return }
        failure = nil
        isLoading = true
        currentURL = url

        guard let webView else {
            pendingURL = url
            return
        }

        var request = URLRequest(
            url: url,
            cachePolicy: .useProtocolCachePolicy,
            timeoutInterval: 30
        )
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        webView.load(request)
    }

    func retry() {
        load(currentURL ?? configuration.gameURL)
    }

    func navigationStarted() {
        failure = nil
        isLoading = true
    }

    func contentBecameVisible(at url: URL?) {
        hasVisiblePage = true
        if let url, navigationPolicy.isGameURL(url) {
            currentURL = url
        }
    }

    func navigationFinished(at url: URL?) {
        isLoading = false
        contentBecameVisible(at: url)
    }

    func routeChanged(to url: URL) {
        guard navigationPolicy.isGameURL(url) else { return }
        currentURL = url
    }

    func navigationFailed(with error: Error) {
        let nsError = error as NSError
        guard nsError.code != NSURLErrorCancelled else { return }

        isLoading = false
        switch nsError.code {
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
            failure = BrowserFailure(
                title: "You’re offline",
                message: "Reconnect to the internet, then try loading the table again."
            )
        case NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost:
            failure = BrowserFailure(
                title: "The table isn’t answering",
                message: "The game service may be taking a breather. Try again in a moment."
            )
        case NSURLErrorSecureConnectionFailed,
             NSURLErrorServerCertificateHasBadDate,
             NSURLErrorServerCertificateUntrusted,
             NSURLErrorServerCertificateHasUnknownRoot:
            failure = BrowserFailure(
                title: "Secure connection failed",
                message: "guppycube couldn’t verify the game server. Check your connection and try again."
            )
        default:
            failure = BrowserFailure(
                title: "Couldn’t set the table",
                message: "guppycube couldn’t load right now. Try again when you’re ready."
            )
        }
    }

    func navigationFailed(statusCode: Int) {
        isLoading = false
        if statusCode == 401 || statusCode == 403 || statusCode == 404 {
            failure = BrowserFailure(
                title: "That table link didn’t work",
                message: "Check the invite link or return to guppycube and join with the table name."
            )
        } else {
            failure = BrowserFailure(
                title: "The table isn’t answering",
                message: "The game service returned an error. Try again in a moment."
            )
        }
    }

    func navigationWasBlocked() {
        guard isLoading && !hasVisiblePage else { return }
        isLoading = false
        failure = BrowserFailure(
            title: "Couldn’t open the game",
            message: "The game sent the app somewhere unexpected. Open guppycube in Safari or try again."
        )
    }

    func webContentProcessTerminated() {
        isLoading = false
        failure = BrowserFailure(
            title: "The table needs a refresh",
            message: "Your seat is saved. Reload the game to keep playing."
        )
    }
}
