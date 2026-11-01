import XCTest

final class GuppycubeLaunchTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testLiveGameLoadsAndKeepsFormStateThroughRotation() throws {
        let app = XCUIApplication()
        app.launch()
        XCUIDevice.shared.orientation = .portrait

        let webView = app.webViews["gameWebView"]
        XCTAssertTrue(webView.waitForExistence(timeout: 15), "The native game web view should launch")

        let nameField = app.textFields["YOUR NAME"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 20), "The production game should become interactive")
        nameField.tap()
        nameField.typeText("Rotate")
        guard let enteredName = nameField.value as? String,
              !enteredName.isEmpty,
              enteredName != "Ada"
        else {
            XCTFail("The live name field should accept text")
            return
        }

        let fourSeats = app.buttons["4"]
        XCTAssertTrue(fourSeats.waitForExistence(timeout: 3))
        fourSeats.tap()
        _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 3)

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(waitUntil(timeout: 5) { webView.frame.width > webView.frame.height })
        XCTAssertEqual(nameField.value as? String, enteredName, "Rotation must not recreate the web view")
        pauseForRotationAnimation()
        attachScreenshot(named: "iPhone landscape")

        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(waitUntil(timeout: 5) { webView.frame.height > webView.frame.width })
        XCTAssertEqual(nameField.value as? String, enteredName)
        pauseForRotationAnimation()
        attachScreenshot(named: "iPhone portrait")
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }

    @MainActor
    private func pauseForRotationAnimation() {
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
    }

    @MainActor
    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
