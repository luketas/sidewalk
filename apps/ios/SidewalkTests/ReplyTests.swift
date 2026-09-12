import XCTest
@testable import Sidewalk
@MainActor final class ReplyTests: XCTestCase {
    func testOnlyLatestReplyPlaysAndInterruptedAttemptWaitsForRetry() {
        let a = WorkTask(id: "a", threadID: "t", text: "Hello", status: "completed", result: "Hello there", questionID: nil)
        let b = WorkTask(id: "b", threadID: "t", text: "Research this", status: "working", result: "On it", questionID: nil)
        XCTAssertEqual(TaskSpeaker.candidate([a], heard: [], attempted: [])?.id, "a")
        XCTAssertNil(TaskSpeaker.candidate([a], heard: [TaskSpeaker.key(a)], attempted: []))
        XCTAssertNil(TaskSpeaker.candidate([a], heard: [], attempted: [TaskSpeaker.key(a)]))
        XCTAssertNil(TaskSpeaker.candidate([a, b], heard: [], attempted: []))
        XCTAssertEqual(TaskSpeaker.candidate([a], heard: [], attempted: [])?.id, "a")
    }
    func testAcknowledgmentAndProgressPlayButOldAcknowledgmentsDoNot() {
        var task = WorkTask(id: "a", threadID: "t", text: "Research", status: "working", result: "Sure, let me look into it.", questionID: nil)
        task.replyID = "ack"; task.replyKind = "accepted"; task.reportedAt = Date().timeIntervalSince1970 * 1000
        XCTAssertNotNil(TaskSpeaker.candidate([task], heard: [], attempted: []))
        task.permissionRequired = "Read"
        XCTAssertNotNil(TaskSpeaker.candidate([task], heard: [], attempted: []), "A tool approval must not suppress Claude’s acknowledgment")
        task.permissionRequired = nil; task.reportedAt = 0
        XCTAssertNil(TaskSpeaker.candidate([task], heard: [], attempted: []))
    }
    func testPermissionsAreSilentWhileDisconnectedWorkHasAudibleStatus() {
        var task = WorkTask(id: "a", threadID: "t", text: "Research", status: "working", result: "Looking", questionID: nil)
        XCTAssertNil(ConversationAudio.blocker(task: task, permission: nil, online: true))
        XCTAssertEqual(ConversationAudio.blocker(task: task, permission: nil, online: false)?.0, "offline")
        let permission = ToolPermission(id: "p", threadID: "t", taskID: "a", epoch: 1, tool: "Read", input: "{}", state: "pending", expiresAt: 100)
        let phoneBlock = ConversationAudio.blocker(task: task, permission: permission, online: true)
        XCTAssertNotNil(phoneBlock, "Permission waits must suppress waiting reminders and tones")
        XCTAssertNil(phoneBlock?.1)
        task.permissionRequired = "Read"
        let macBlock = ConversationAudio.blocker(task: task, permission: nil, online: true)
        XCTAssertNotNil(macBlock)
        XCTAssertNil(macBlock?.1)
    }
    func testStatusAnnouncementsCannotEnterMicrophoneAndUserMuteIsPreserved() {
        XCTAssertFalse(VoiceTransport.captureEnabled(ready: true, ending: false, userMuted: false, statusAudio: false, replyAudio: true))
        XCTAssertTrue(VoiceTransport.captureEnabled(ready: true, ending: false, userMuted: false, statusAudio: false))
        XCTAssertFalse(VoiceTransport.captureEnabled(ready: true, ending: false, userMuted: false, statusAudio: true))
        XCTAssertFalse(VoiceTransport.captureEnabled(ready: true, ending: false, userMuted: true, statusAudio: false))
        XCTAssertFalse(VoiceTransport.captureEnabled(ready: false, ending: false, userMuted: false, statusAudio: false))
        XCTAssertFalse(VoiceTransport.captureEnabled(ready: true, ending: true, userMuted: false, statusAudio: false))
    }
    func testChangedQuestionGetsANewPlaybackIdentity() {
        let a = WorkTask(id: "a", threadID: "t", text: "Research", status: "question", result: "Which project?", questionID: "q1")
        let b = WorkTask(id: "a", threadID: "t", text: "Research", status: "question", result: "Which project?", questionID: "q2")
        XCTAssertNotEqual(TaskSpeaker.key(a), TaskSpeaker.key(b))
        XCTAssertFalse(TaskSpeaker.key(a).contains("Which project"))
    }
}
