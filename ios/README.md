# guppycube for iOS

This target is a native SwiftUI shell for the production guppycube game. It intentionally loads
`https://snagsby.com/guppycube/` in a persistent `WKWebView`: the game API, WebSocket, cookies,
portable player links, and static assets all share that origin.

The shell adds native loading and recovery UI, safe rotation, external-link routing, a private app
switcher cover, haptic feedback, JavaScript dialog support, and a native clipboard fallback. Browser
back gestures stay disabled because the current React router does not consume `popstate` events.

## Open and run

Open `Guppycube.xcodeproj`, choose an iPhone or iPad simulator, and run the `Guppycube` scheme.
The project supports iOS 17 and later on iPhone and iPad, including portrait and landscape.

To regenerate the Xcode project after changing `project.yml`:

```sh
xcodegen generate --spec ios/project.yml
```

Run the native unit tests with:

```sh
xcodebuild -project ios/Guppycube.xcodeproj -scheme Guppycube \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

The live-production WKWebView rotation test is intentionally opt-in because it needs internet access:

```sh
xcodebuild -project ios/Guppycube.xcodeproj -scheme GuppycubeUITests \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

To regenerate the app icon after changing `Design/AppIcon.svg`:

```sh
node ios/Scripts/generate-app-icons.mjs
```

Debug builds can point at an alternate HTTPS deployment without changing source:

```sh
xcrun simctl launch booted com.snagsby.guppycube --game-url https://example.com/guppycube/
```

The alternate deployment must use the same path/origin contract as production.

## Deep links

The app accepts its private URL scheme for non-sensitive navigation:

```text
guppycube://room/dorky-puppet-spam
guppycube://home
```

HTTPS invite links can also be routed by the app once `snagsby.com` serves an Apple App Site
Association file and the target receives the matching Associated Domains entitlement. Those server
and signing changes are deliberately not enabled in this repository yet. Portable `?player=`
credentials are rejected on the custom scheme because another app could claim that scheme; they may
only enter the app through a verified HTTPS Universal Link.

## Release notes

- Select your Apple developer team in Xcode before installing on a physical device or archiving.
- The web game still uses browser notifications. Reliable alerts while the app is suspended require
  APNs plus backend subscription support.
- Before App Store submission, review the current Apple minimum-functionality guideline and add any
  product-specific native experience required for the intended release.
