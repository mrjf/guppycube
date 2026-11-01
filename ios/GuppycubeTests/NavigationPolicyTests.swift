import XCTest
@testable import Guppycube

final class NavigationPolicyTests: XCTestCase {
    private let baseURL = URL(string: "https://snagsby.com/guppycube/")!

    func testAllowsOnlyTheGameOriginAndPath() {
        let policy = BrowserNavigationPolicy(gameBaseURL: baseURL)

        XCTAssertEqual(policy.decision(for: baseURL), .allowInGame)
        XCTAssertEqual(
            policy.decision(for: URL(string: "https://snagsby.com/guppycube/room/dorky-puppet-spam?player=secret")!),
            .allowInGame
        )
        XCTAssertEqual(
            policy.decision(for: URL(string: "https://snagsby.com/elsewhere")!),
            .openExternally
        )
        XCTAssertEqual(
            policy.decision(for: URL(string: "https://guppycube.snagsby.com/guppycube/")!),
            .openExternally
        )
        XCTAssertEqual(
            policy.decision(for: URL(string: "javascript:alert(1)")!),
            .cancel
        )
    }

    func testRoutesSystemLinksOutsideTheGame() {
        let policy = BrowserNavigationPolicy(gameBaseURL: baseURL)

        XCTAssertEqual(policy.decision(for: URL(string: "mailto:hello@example.com")!), .openExternally)
        XCTAssertEqual(policy.decision(for: URL(string: "sms:+15555550123")!), .openExternally)
        XCTAssertEqual(policy.decision(for: URL(string: "tel:+15555550123")!), .openExternally)
    }

    func testRejectsPathTraversalVariants() {
        let policy = BrowserNavigationPolicy(gameBaseURL: baseURL)
        let attempts = [
            "https://snagsby.com/guppycube/../elsewhere",
            "https://snagsby.com/guppycube/%2e%2e/elsewhere",
            "https://snagsby.com/guppycube/%2F..%2Felsewhere",
            "https://snagsby.com/guppycube/%5C..%5Celsewhere",
        ]

        for attempt in attempts {
            XCTAssertFalse(policy.isGameURL(URL(string: attempt)!), attempt)
        }
    }

    func testMapsRoomDeepLinkWithoutCredentials() {
        let router = AppURLRouter(gameBaseURL: baseURL)
        let incoming = URL(string: "guppycube://room/dorky-puppet-spam")!

        XCTAssertEqual(
            router.destination(for: incoming)?.absoluteString,
            "https://snagsby.com/guppycube/room/dorky-puppet-spam"
        )
    }

    func testPreservesCredentialOnlyOnVerifiedHTTPSLink() {
        let router = AppURLRouter(gameBaseURL: baseURL)
        let incoming = URL(string: "https://snagsby.com/guppycube/room/dorky-puppet-spam?player=player.token")!

        XCTAssertEqual(router.destination(for: incoming), incoming)
        XCTAssertNil(
            router.destination(for: URL(string: "guppycube://room/dorky-puppet-spam?player=player.token")!)
        )
    }

    func testMapsAlternateAndHomeDeepLinkForms() {
        let router = AppURLRouter(gameBaseURL: baseURL)

        XCTAssertEqual(
            router.destination(for: URL(string: "guppycube:///room/Dorky-Puppet-Spam")!)?.absoluteString,
            "https://snagsby.com/guppycube/room/dorky-puppet-spam"
        )
        XCTAssertEqual(
            router.destination(for: URL(string: "guppycube://home")!)?.absoluteString,
            "https://snagsby.com/guppycube/"
        )
    }

    func testRejectsMalformedOrUnrelatedDeepLinks() {
        let router = AppURLRouter(gameBaseURL: baseURL)

        XCTAssertNil(router.destination(for: URL(string: "guppycube://room/not-a-valid-room-name")!))
        XCTAssertNil(router.destination(for: URL(string: "guppycube://settings")!))
        XCTAssertNil(router.destination(for: URL(string: "https://example.com/guppycube/")!))
    }
}
