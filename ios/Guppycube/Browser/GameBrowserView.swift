import SwiftUI
import UIKit

struct GameBrowserView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: GameBrowserModel

    init(configuration: AppConfiguration) {
        _model = StateObject(wrappedValue: GameBrowserModel(configuration: configuration))
    }

    var body: some View {
        ZStack {
            Color.gamePaper.ignoresSafeArea()

            GameWebView(model: model)
                .opacity(model.hasVisiblePage ? 1 : 0)

            if !model.hasVisiblePage && model.failure == nil {
                LoadingView()
                    .transition(.opacity)
            }

            if let failure = model.failure {
                FailureView(
                    failure: failure,
                    retry: model.retry,
                    openInSafari: openInSafari
                )
                .transition(.opacity)
            }

            if scenePhase != .active {
                PrivacyCover()
                    .transition(.opacity)
                    .zIndex(10)
            }
        }
        .animation(.easeOut(duration: 0.18), value: model.hasVisiblePage)
        .animation(.easeOut(duration: 0.18), value: model.failure)
        .overlay(alignment: .top) {
            if model.isLoading && model.hasVisiblePage && model.failure == nil {
                ProgressView()
                    .controlSize(.small)
                    .tint(.gameCoral)
                    .padding(8)
                    .background(.ultraThinMaterial, in: Circle())
                    .padding(.top, 8)
                    .accessibilityLabel("Loading game")
            }
        }
        .onOpenURL { url in
            _ = model.openIncomingURL(url)
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL else { return }
            _ = model.openIncomingURL(url)
        }
    }

    private func openInSafari() {
        UIApplication.shared.open(model.currentURL ?? model.configuration.gameURL)
    }
}

private struct LoadingView: View {
    var body: some View {
        VStack(spacing: 18) {
            Image("CatMark")
                .resizable()
                .scaledToFit()
                .foregroundStyle(Color.gameInk)
                .frame(width: 94, height: 84)
                .accessibilityHidden(true)

            Text("guppycube")
                .font(.system(size: 32, weight: .bold, design: .rounded))
                .foregroundStyle(Color.gameInk)

            ProgressView()
                .tint(.gameCoral)
                .padding(.top, 2)
        }
        .padding(36)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Loading guppycube")
    }
}

private struct FailureView: View {
    let failure: BrowserFailure
    let retry: () -> Void
    let openInSafari: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image("CatMark")
                .resizable()
                .scaledToFit()
                .foregroundStyle(Color.gameCoral)
                .frame(width: 84, height: 74)
                .accessibilityHidden(true)

            VStack(spacing: 8) {
                Text(failure.title)
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                Text(failure.message)
                    .font(.body)
                    .foregroundStyle(Color.gameMuted)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 10) {
                Button(action: retry) {
                    Label("Try again", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.gameCoral)

                Button(action: openInSafari) {
                    Label("Open in Safari", systemImage: "safari")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.gameInk)
            }
            .frame(maxWidth: 300)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.gamePaper)
        .accessibilityElement(children: .contain)
    }
}

private struct PrivacyCover: View {
    var body: some View {
        ZStack {
            Color.gameCoral.ignoresSafeArea()
            VStack(spacing: 14) {
                Image("CatMark")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(Color.white.opacity(0.96))
                    .frame(width: 88, height: 78)
                Text("guppycube")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            }
        }
        .accessibilityHidden(true)
    }
}

private extension Color {
    static let gameCoral = Color(red: 0.929, green: 0.357, blue: 0.227)
    static let gamePaper = Color(red: 0.969, green: 0.941, blue: 0.898)
    static let gameInk = Color(red: 0.129, green: 0.114, blue: 0.098)
    static let gameMuted = Color(red: 0.459, green: 0.431, blue: 0.396)
}
