import Foundation
struct WorkThread: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    var projectID: String
    var sessionID: String
    var epoch: Int
    var status: String
    var detail: String
    var createdAt: Double
}
struct WorkTask: Codable, Identifiable {
    let id: String
    let threadID: String
    let text: String
    let status: String
    let result: String
    let questionID: String?
    var speech: String? = nil
    var replyID: String? = nil
    var replyKind: String? = nil
    var reportedAt: Double? = nil
    var permissionRequired: String? = nil
    var activity: String? = nil
    var activityAt: Double? = nil
    var deliveredAt: Double? = nil
    var createdAt: Double? = nil
    var hasSpokenUpdate: Bool { hasReply || (status == "working" && replyID != nil && ["accepted", "progress"].contains(replyKind ?? "") && Date().timeIntervalSince1970 * 1000 - (reportedAt ?? 0) < 30000 && !result.isEmpty) }
    var waitingReason: String? = nil
    var hasReply: Bool { ["completed", "failed", "question"].contains(status) && !result.isEmpty }
    var statusLabel: String {
        switch status {
        case "queued": "Waiting"
        case "delivered": "Sending to Claude"
        case "working": "Claude is working"
        case "question": "Needs your answer"
        case "answer_queued": "Answer waiting to send"
        case "completed": "Result received"
        case "canceled": "Canceled"
        case "failed": "Couldn’t finish"
        default: "Outcome unclear"
        }
    }
}
struct ToolPermission: Codable, Identifiable { let id: String; let threadID: String; let taskID: String; let epoch: Int; let tool: String; let input: String; let state: String; let expiresAt: Double }
struct Focus: Codable { var threadID: String?; var epoch: Int }
struct Project: Codable, Identifiable { let id: String; let name: String }
struct Readiness: Codable { let voiceKey: Bool; let claudeLaunch: Bool; let liveVerified: Bool; let stopSupported: Bool }
struct BridgeState: Codable {
    var threads: [WorkThread]
    var tasks: [WorkTask]
    var focus: Focus
    var projects: [Project]
    var readiness: Readiness
    var notice: String? = nil
    var permissions: [ToolPermission]? = nil
    static let empty = BridgeState(threads: [], tasks: [], focus: Focus(threadID: nil, epoch: 0), projects: [], readiness: Readiness(voiceKey: false, claudeLaunch: false, liveVerified: false, stopSupported: false))
}
struct PairingPayload: Codable { let url: String; let code: String; var certificateSHA256: String? = nil }
struct DeviceCredential: Codable { let deviceID: String; let token: String; var baseURL: String = ""; var certificateSHA256: String? = nil }
struct VoiceSession: Codable {
    struct Session: Codable { let id: String }
    struct Transport: Codable { let type: String; let sdp: String }
    let session: Session
    let transport: Transport
}
struct Caption: Identifiable { let id = UUID(); let isUser: Bool; var text: String }
enum AppSheet: String, Identifiable { case threads, settings; var id: String { rawValue } }
enum VoicePhase: Equatable { case idle, connecting, listening, ending, failed(String) }
