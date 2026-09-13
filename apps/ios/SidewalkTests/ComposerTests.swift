import XCTest
@testable import Sidewalk

final class ComposerTests: XCTestCase {
    func testAcceptanceClearsSentText() {
        var draft = ComposerDraft()
        draft.edit("Investigate login")
        XCTAssertTrue(draft.accept(draft.submission))
        XCTAssertEqual(draft.text, "")
    }
    func testLateReceiptPreservesNewTypingEvenWhenTextMatches() {
        var draft = ComposerDraft()
        draft.edit("Hello")
        let sent = draft.submission
        draft.edit("")
        draft.edit("Hello")
        XCTAssertFalse(draft.accept(sent))
        XCTAssertEqual(draft.text, "Hello")
    }
    func testRedundantTextBindingUpdateDoesNotKeepSentText() {
        var draft = ComposerDraft()
        draft.edit("Hello")
        let sent = draft.submission
        draft.edit("Hello")
        XCTAssertTrue(draft.accept(sent))
        XCTAssertEqual(draft.text, "")
    }
    func testSwitchingThreadsInvalidatesOldSendAndClearsDraft() {
        var draft = ComposerDraft()
        draft.edit("Old thread")
        let sent = draft.submission
        draft.reset()
        XCTAssertEqual(draft.text, "")
        draft.edit("New thread")
        XCTAssertFalse(draft.accept(sent))
        XCTAssertEqual(draft.text, "New thread")
    }
    func testFailureWithoutReceiptKeepsTextForRetry() {
        var draft = ComposerDraft()
        draft.edit("Try again")
        _ = draft.submission
        XCTAssertEqual(draft.text, "Try again")
    }
}
