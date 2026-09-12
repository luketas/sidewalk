import XCTest
@testable import Sidewalk
final class ThreadSwitchTests: XCTestCase {
    @MainActor
    func testUpdatingConnectionAcceptsTheNewDevicesFocusEpoch() {
        let model = AppModel()
        var prior = BridgeState.empty
        prior.focus = Focus(threadID: "old", epoch: 20)
        model.applyState(prior)
        model.captions = [Caption(isUser: true, text: "Old connection")]
        model.resetConversation()
        var next = BridgeState.empty
        next.focus = Focus(threadID: "new", epoch: 1)
        model.applyState(next)
        XCTAssertEqual(model.state.focus.threadID, "new")
        XCTAssertTrue(model.captions.isEmpty)
    }
    @MainActor
    func testChangingThreadsClearsHomeAndIgnoresStalePoll() {
        let model = AppModel()
        var first = BridgeState.empty
        first.focus = Focus(threadID: "first", epoch: 1)
        model.applyState(first)
        model.captions = [Caption(isUser: true, text: "Old conversation")]
        model.error = "Old error"
        var second = first
        second.focus = Focus(threadID: "second", epoch: 2)
        model.applyState(second)
        XCTAssertTrue(model.captions.isEmpty)
        XCTAssertNil(model.error)
        model.applyState(first)
        XCTAssertEqual(model.state.focus.threadID, "second")
    }
    @MainActor
    func testRefreshingTheSameThreadKeepsCurrentConversation() {
        let model = AppModel()
        var state = BridgeState.empty
        state.focus = Focus(threadID: "same", epoch: 1)
        model.applyState(state)
        model.captions = [Caption(isUser: true, text: "Current thought")]
        model.applyState(state)
        XCTAssertEqual(model.captions.first?.text, "Current thought")
    }
}
