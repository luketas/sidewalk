import XCTest
import SwiftUI
@testable import Sidewalk
final class ConnectionTests: XCTestCase {
    func testRejectsUnencryptedRemoteConnection() {
        XCTAssertThrowsError(try BridgeClient.validateURL("http://192.168.1.9:17841"))
        XCTAssertThrowsError(try BridgeClient.validateURL("https://user:secret@example.com"))
        XCTAssertThrowsError(try BridgeClient.validateURL("https://example.com?token=secret"))
        XCTAssertNoThrow(try BridgeClient.validateURL("https://mac.example.ts.net"))
    }
    func testResultKeepsItsThreadIdentity() throws {
        let json = #"{"id":"r1","threadID":"login","text":"Check login","status":"completed","result":"Found an expired token","questionID":null}"#
        let task = try JSONDecoder().decode(WorkTask.self, from: Data(json.utf8))
        XCTAssertEqual(task.threadID, "login")
        XCTAssertEqual(task.statusLabel, "Result received")
    }
    func testUncertainMutationReusesIdentityUntilResolved() throws {
        let outbox = RequestOutbox()
        let device = UUID().uuidString
        let first = try outbox.prepare(deviceID: device, path: "v1/threads", body: ["commandID": "first", "name": "Login"])
        let retry = try outbox.prepare(deviceID: device, path: "v1/threads", body: ["commandID": "retry", "name": "Login"])
        XCTAssertEqual(first.body["commandID"] as? String, retry.body["commandID"] as? String)
        try outbox.resolve(first.key)
        let newRequest = try outbox.prepare(deviceID: device, path: "v1/threads", body: ["commandID": "new", "name": "Login"])
        XCTAssertEqual(newRequest.body["commandID"] as? String, "new")
        try outbox.resolve(newRequest.key)
    }
    @MainActor
    func testQuestionCardRendersAtAccessibleSizes() async throws {
        let task = WorkTask(id: "question-render", threadID: "login", text: "Inspect login",
                            status: "question", result: "Should I check the iPhone login flow or the Mac session?",
                            questionID: "question-1")
        var heights: [CGFloat] = []
        for (name, size) in [("standard", DynamicTypeSize.large), ("accessible", .accessibility3)] {
            let card = TaskCard(task: task, threadName: "Login investigation", cancel: {}, answer: { _ in true }, check: {})
                .padding(20).frame(width: 393).fixedSize(horizontal: false, vertical: true)
                .background(Palette.background).environment(\.dynamicTypeSize, size)
                .environment(\.colorScheme, .light)
            let host = UIHostingController(rootView: card)
            host.safeAreaRegions = []
            let size = host.sizeThatFits(in: CGSize(width: 393, height: 10000))
            let window = UIWindow(frame: CGRect(origin: .zero, size: size))
            window.rootViewController = host
            window.isHidden = false
            await Task.yield()
            host.view.frame = window.bounds
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(size: size).image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }
            window.isHidden = true
            await Task.yield()
            heights.append(image.size.height)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("sidewalk-question-\(name).png")
            try XCTUnwrap(image.pngData()).write(to: url)
            print("QUESTION_RENDER: \(url.path)")
        }
        XCTAssertGreaterThan(heights[1], heights[0], "The card must expand to fit accessible text sizes")
    }
}

