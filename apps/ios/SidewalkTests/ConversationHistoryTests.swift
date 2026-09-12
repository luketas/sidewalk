import XCTest
@testable import Sidewalk

final class ConversationHistoryTests: XCTestCase {
    private func message(_ id: String, role: String, text: String, start: Double, end: Double, session: String? = "s") -> ConversationMessage {
        ConversationMessage(seq: Int(id) ?? 0, id: id, threadID: "t", role: role, kind: role == "claude" ? "task.result" : "input", text: text, at: start, sessionID: session, startMS: start, endMS: end, taskID: nil)
    }
    func testFragmentsPreserveWhitespaceAndAnInterruptionStartsANewRow() {
        let messages = [message("1", role: "voice", text: "Here are", start: 0, end: 500),
                        message("2", role: "voice", text: " three options.", start: 500, end: 1000),
                        message("3", role: "user", text: "Wait", start: 850, end: 1200),
                        message("4", role: "voice", text: "Go ahead.", start: 1300, end: 1800)]
        let rows = ConversationRow.group(messages)
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0].text, "Here are three options.")
        XCTAssertEqual(rows[1].text, "Wait")
        XCTAssertEqual(rows[0].id, "1")
    }
    func testHistoryKeepsFullAnswerAndDistinctSpokenVersion() {
        let full = String(repeating: "Detailed finding. ", count: 100) + "https://example.com"
        let messages = [message("1", role: "claude", text: full, start: 0, end: 1, session: nil), message("2", role: "voice", text: "Three useful findings.", start: 1000, end: 2000)]
        let rows = ConversationRow.group(messages)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].text, full)
        let cache = ConversationCache(), device = UUID().uuidString, thread = UUID().uuidString
        XCTAssertNoThrow(try cache.save(messages, deviceID: device, threadID: thread))
        XCTAssertEqual(cache.load(deviceID: device, threadID: thread).map(\.text), messages.map(\.text))
        XCTAssertTrue(cache.load(deviceID: device, threadID: "other").isEmpty)
    }
    func testPausesAndNewCallsDoNotMergeUnrelatedUtterances() {
        let messages = [message("1", role: "user", text: "First", start: 0, end: 100), message("2", role: "user", text: "Second", start: 3000, end: 4000), message("3", role: "user", text: "Third", start: 4000, end: 4500, session: "next")]
        XCTAssertEqual(ConversationRow.group(messages).count, 3)
    }
}
