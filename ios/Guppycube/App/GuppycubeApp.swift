import SwiftUI

@main
struct GuppycubeApp: App {
    private let configuration = AppConfiguration.current()

    var body: some Scene {
        WindowGroup {
            GameBrowserView(configuration: configuration)
                .preferredColorScheme(.light)
        }
    }
}
