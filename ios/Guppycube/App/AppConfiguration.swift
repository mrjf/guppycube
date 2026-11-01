import Foundation

struct AppConfiguration: Sendable {
    static let fallbackGameURL = URL(string: "https://snagsby.com/guppycube/")!

    let gameURL: URL

    static func current(
        bundle: Bundle = .main,
        processInfo: ProcessInfo = .processInfo
    ) -> AppConfiguration {
        let configuredURL = (bundle.object(forInfoDictionaryKey: "GuppycubeGameURL") as? String)
            .flatMap(URL.init(string:))
            ?? fallbackGameURL

#if DEBUG
        let arguments = processInfo.arguments
        if let flagIndex = arguments.firstIndex(of: "--game-url"),
           arguments.indices.contains(flagIndex + 1),
           let overrideURL = URL(string: arguments[flagIndex + 1]),
           isValidGameURL(overrideURL) {
            return AppConfiguration(gameURL: overrideURL)
        }

        if let override = processInfo.environment["GUPPYCUBE_GAME_URL"],
           let overrideURL = URL(string: override),
           isValidGameURL(overrideURL) {
            return AppConfiguration(gameURL: overrideURL)
        }
#endif

        return AppConfiguration(
            gameURL: isValidGameURL(configuredURL) ? configuredURL : fallbackGameURL
        )
    }

    private static func isValidGameURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), url.host != nil else { return false }
        if scheme == "https" { return true }
#if DEBUG
        let host = url.host?.lowercased()
        return scheme == "http" && ["127.0.0.1", "::1", "localhost"].contains(host)
#else
        return false
#endif
    }
}
