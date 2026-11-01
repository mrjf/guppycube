import SwiftUI
import UIKit
@preconcurrency import WebKit

struct GameWebView: UIViewRepresentable {
    @ObservedObject var model: GameBrowserModel

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.applicationNameForUserAgent = "guppycube-ios/1.0"
        configuration.userContentController.add(context.coordinator, name: Coordinator.bridgeName)
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: Self.nativeBridgeScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = true
        webView.isOpaque = true
        webView.backgroundColor = UIColor(red: 0.969, green: 0.941, blue: 0.898, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.accessibilityIdentifier = "gameWebView"

#if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
#endif

        Task { @MainActor [weak webView, weak model] in
            guard let webView, let model else { return }
            model.attach(webView)
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // The model owns navigation. Keeping this method empty prevents SwiftUI
        // updates and rotations from reloading a staged turn.
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: Coordinator.bridgeName
        )
        coordinator.model.detach(webView)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    private static let nativeBridgeScript = #"""
        (() => {
          if (window.__guppycubeNativeBridgeInstalled) return;
          window.__guppycubeNativeBridgeInstalled = true;

          const post = (body) => {
            try { window.webkit.messageHandlers.guppycube.postMessage(body); } catch (_) {}
          };

          const notifyRoute = () => post({ type: "route", href: window.location.href });
          for (const method of ["pushState", "replaceState"]) {
            const original = history[method];
            history[method] = function (...args) {
              const result = original.apply(this, args);
              queueMicrotask(notifyRoute);
              return result;
            };
          }
          addEventListener("popstate", notifyRoute);
          addEventListener("pageshow", notifyRoute);

          document.addEventListener("click", (event) => {
            if (!(event.target instanceof Element)) return;
            const control = event.target.closest(
              ".tile, .primary-button, .rack-action-tools button, " +
              ".selection-actions button, .player-count button, .entry-tabs button"
            );
            if (!control || control.matches(":disabled")) return;
            const style = control.matches(".tile") ? "selection" :
              control.matches(".primary-button, .rack-action-tools button") ? "medium" : "light";
            post({ type: "haptic", style });
          }, true);

          const nativeCopy = (value) => {
            post({ type: "copy", text: String(value) });
            return Promise.resolve();
          };

          try {
            const clipboard = navigator.clipboard;
            if (clipboard && typeof clipboard.writeText === "function") {
              const originalWriteText = clipboard.writeText.bind(clipboard);
              clipboard.writeText = (value) => originalWriteText(value).catch(() => nativeCopy(value));
            } else if (!clipboard) {
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: { writeText: nativeCopy }
              });
            }
          } catch (_) {
            // WebKit can expose a non-configurable Clipboard object. The web UI
            // already reports the link as text if both clipboard paths fail.
          }
        })();
        """#

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        static let bridgeName = "guppycube"

        let model: GameBrowserModel

        init(model: GameBrowserModel) {
            self.model = model
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            switch model.navigationPolicy.decision(for: url) {
            case .allowInGame:
                decisionHandler(.allow)
            case .openExternally:
                decisionHandler(.cancel)
                if navigationAction.navigationType == .linkActivated
                    || navigationAction.targetFrame == nil {
                    UIApplication.shared.open(url)
                } else if navigationAction.targetFrame?.isMainFrame == true {
                    model.navigationWasBlocked()
                }
            case .cancel:
                decisionHandler(.cancel)
                if navigationAction.targetFrame?.isMainFrame == true,
                   navigationAction.navigationType == .other {
                    model.navigationWasBlocked()
                }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
        ) {
            guard navigationResponse.isForMainFrame,
                  let response = navigationResponse.response as? HTTPURLResponse
            else {
                decisionHandler(.allow)
                return
            }

            guard (200..<400).contains(response.statusCode) else {
                model.navigationFailed(statusCode: response.statusCode)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
            model.navigationStarted()
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation?) {
            model.contentBecameVisible(at: webView.url)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
            model.navigationFinished(at: webView.url)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation?,
            withError error: Error
        ) {
            model.navigationFailed(with: error)
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation?,
            withError error: Error
        ) {
            model.navigationFailed(with: error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            model.webContentProcessTerminated()
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            guard navigationAction.targetFrame == nil,
                  let url = navigationAction.request.url
            else {
                return nil
            }

            switch model.navigationPolicy.decision(for: url) {
            case .allowInGame:
                webView.load(navigationAction.request)
            case .openExternally:
                UIApplication.shared.open(url)
            case .cancel:
                break
            }
            return nil
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable () -> Void
        ) {
            let alert = UIAlertController(title: "guppycube", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            guard present(alert, from: webView) else { completionHandler(); return }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
        ) {
            let alert = UIAlertController(title: "guppycube", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "Continue", style: .default) { _ in completionHandler(true) })
            guard present(alert, from: webView) else { completionHandler(false); return }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable (String?) -> Void
        ) {
            let alert = UIAlertController(title: "guppycube", message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text)
            })
            guard present(alert, from: webView) else { completionHandler(nil); return }
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == Self.bridgeName,
                  message.frameInfo.isMainFrame,
                  let frameURL = message.frameInfo.request.url,
                  model.navigationPolicy.isGameURL(frameURL),
                  let payload = message.body as? [String: Any],
                  let type = payload["type"] as? String
            else {
                return
            }

            switch type {
            case "route":
                guard let href = payload["href"] as? String, let url = URL(string: href) else { return }
                model.routeChanged(to: url)
            case "copy":
                guard let value = payload["text"] as? String, value.utf8.count <= 4_096 else { return }
                UIPasteboard.general.string = value
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "haptic":
                playHaptic(style: payload["style"] as? String)
            default:
                break
            }
        }

        private func playHaptic(style: String?) {
            switch style {
            case "selection":
                UISelectionFeedbackGenerator().selectionChanged()
            case "medium":
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            default:
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }

        private func present(_ alert: UIAlertController, from webView: WKWebView) -> Bool {
            guard var presenter = webView.window?.rootViewController else { return false }
            while let presented = presenter.presentedViewController {
                presenter = presented
            }
            presenter.present(alert, animated: true)
            return true
        }
    }
}
