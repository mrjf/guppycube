import Foundation

enum BrowserNavigationDecision: Equatable {
    case allowInGame
    case openExternally
    case cancel
}

struct BrowserNavigationPolicy: Sendable {
    let gameBaseURL: URL

    func decision(for url: URL) -> BrowserNavigationDecision {
        guard let scheme = url.scheme?.lowercased() else { return .cancel }

        if scheme == "about" {
            return url.absoluteString == "about:blank" ? .allowInGame : .cancel
        }

        if scheme == "http" || scheme == "https" {
            return isGameURL(url) ? .allowInGame : .openExternally
        }

        if ["mailto", "sms", "tel"].contains(scheme) {
            return .openExternally
        }

        return .cancel
    }

    func isGameURL(_ url: URL) -> Bool {
        guard
            url.scheme?.lowercased() == gameBaseURL.scheme?.lowercased(),
            url.host?.lowercased() == gameBaseURL.host?.lowercased(),
            effectivePort(of: url) == effectivePort(of: gameBaseURL)
        else {
            return false
        }

        guard let candidatePath = safeDecodedPath(of: url),
              let decodedBasePath = safeDecodedPath(of: gameBaseURL)
        else {
            return false
        }

        let basePath = decodedBasePath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !basePath.isEmpty else { return true }

        let allowedRoot = "/\(basePath)"
        return candidatePath == allowedRoot || candidatePath.hasPrefix("\(allowedRoot)/")
    }

    private func safeDecodedPath(of url: URL) -> String? {
        guard let encodedPath = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        )?.percentEncodedPath else {
            return nil
        }

        let lowercasePath = encodedPath.lowercased()
        guard !lowercasePath.contains("%2f"),
              !lowercasePath.contains("%5c"),
              let decodedPath = encodedPath.removingPercentEncoding,
              !decodedPath.contains("\\")
        else {
            return nil
        }

        let pathSegments = decodedPath.split(separator: "/", omittingEmptySubsequences: false)
        guard !pathSegments.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return decodedPath
    }

    private func effectivePort(of url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}

struct AppURLRouter: Sendable {
    let gameBaseURL: URL

    func destination(for incomingURL: URL) -> URL? {
        let policy = BrowserNavigationPolicy(gameBaseURL: gameBaseURL)
        if policy.isGameURL(incomingURL) {
            return incomingURL
        }

        guard incomingURL.scheme?.lowercased() == "guppycube" else { return nil }

        // Custom URL schemes are not owned exclusively by an app. Never accept
        // portable player credentials through this hijackable channel; those
        // may only arrive on the verified HTTPS origin via Universal Links.
        guard URLComponents(url: incomingURL, resolvingAgainstBaseURL: false)?.queryItems?.isEmpty != false else {
            return nil
        }

        let host = incomingURL.host?.lowercased()
        let pathParts = incomingURL.pathComponents.filter { $0 != "/" }
        let routeParts: [String]

        switch host {
        case nil, "":
            routeParts = pathParts
        case "home":
            guard pathParts.isEmpty else { return nil }
            routeParts = []
        case "room":
            routeParts = ["room"] + pathParts
        default:
            return nil
        }

        let relativePath: String
        if routeParts.isEmpty {
            relativePath = ""
        } else {
            guard routeParts.count == 2, routeParts[0].lowercased() == "room" else { return nil }
            let room = routeParts[1].lowercased()
            guard room.count <= 40,
                  room.range(of: #"^[a-z]+-[a-z]+-[a-z]+$"#, options: .regularExpression) != nil
            else {
                return nil
            }
            relativePath = "room/\(room)"
        }

        guard var destination = URLComponents(url: gameBaseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        let basePath = gameBaseURL.path.hasSuffix("/")
            ? gameBaseURL.path
            : "\(gameBaseURL.path)/"
        destination.path = relativePath.isEmpty ? basePath : "\(basePath)\(relativePath)"
        destination.query = nil
        destination.fragment = nil
        return destination.url
    }
}
