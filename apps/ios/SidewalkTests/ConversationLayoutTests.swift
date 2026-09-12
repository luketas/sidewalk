import XCTest
import SwiftUI
@testable import Sidewalk

@MainActor final class ConversationLayoutTests: XCTestCase {
    func testConversationHistoryRemainsReadable() async throws {
        let model = AppModel(); model.credential = nil
        var state = BridgeState.empty
        state.threads = [WorkThread(id: "preview", name: "Voice research", projectID: "p", sessionID: "s", epoch: 1, status: "ready", detail: "Claude is ready", createdAt: 0)]
        state.focus = Focus(threadID: "preview", epoch: 1)
        model.applyState(state); model.online = true; model.phase = .listening
        model.messages = [
            ConversationMessage(seq: 1, id: "1", threadID: "preview", role: "user", kind: "input", text: "How can we make this feel like a real conversation?", at: 0, sessionID: "s", startMS: 0, endMS: 1000, taskID: nil),
            ConversationMessage(seq: 2, id: "2", threadID: "preview", role: "voice", kind: "spoken", text: "Sure, I’ll look into that.", at: 1, sessionID: "s", startMS: 1200, endMS: 2000, taskID: nil),
            ConversationMessage(seq: 3, id: "3", threadID: "preview", role: "claude", kind: "task.result", text: "Start with two things: **short replies** and **natural interruption**.\n\nKeep the full answer in chat, so you can read the details later and continue where you left off.", at: 2, sessionID: nil, startMS: nil, endMS: nil, taskID: nil)]
        let host = UIHostingController(rootView: ConversationView(model: model))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 440, height: 956)
        window.rootViewController = host; window.makeKeyAndVisible(); host.view.frame = window.bounds
        try await Task.sleep(for: .milliseconds(500)); host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sidewalk-conversation10-ui.png")
        try XCTUnwrap(image.pngData()).write(to: url)
        print("UI_EVIDENCE_PATH=\(url.path)")
        XCTAssertGreaterThan(try XCTUnwrap(image.pngData()).count, 10000)
        window.isHidden = true
    }
}
