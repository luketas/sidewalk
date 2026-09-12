import Foundation
import CryptoKit

struct ConversationMessage: Codable, Identifiable {
    let seq: Int
    let id: String
    let threadID: String
    let role: String
    let kind: String
    var text: String
    let at: Double
    let sessionID: String?
    let startMS: Double?
    let endMS: Double?
    let taskID: String?
}
struct ConversationPage: Decodable {
    let threadID: String
    let messages: [ConversationMessage]
    let cursor: Int
    let hasMore: Bool
}
struct ConversationRow: Identifiable {
    let id: String
    let role: String
    var text: String
    var endMS: Double?
    let sessionID: String?
    let taskID: String?
    static func group(_ messages: [ConversationMessage]) -> [ConversationRow] {
        var rows: [ConversationRow] = []
        for message in messages {
            if let last = rows.indices.last, message.sessionID != nil,
               rows[last].sessionID == message.sessionID, rows[last].role == message.role,
               let end = rows[last].endMS, let start = message.startMS, start - end < 1800, start >= end - 1000 {
                // Transcript fragments retain provider whitespace; display grouping never dispatches tasks.
                rows[last].text += message.text; rows[last].endMS = message.endMS
            } else {
                rows.append(ConversationRow(id: message.id, role: message.role, text: message.text,
                    endMS: message.endMS, sessionID: message.sessionID, taskID: message.taskID))
            }
        }
        return rows
    }
}
struct ConversationCache {
    private func file(deviceID: String, threadID: String) throws -> URL {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Conversations", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let name = SHA256.hash(data: Data("\(deviceID):\(threadID)".utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(name + ".json")
    }
    func load(deviceID: String, threadID: String) -> [ConversationMessage] {
        guard let url = try? file(deviceID: deviceID, threadID: threadID), let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([ConversationMessage].self, from: data)) ?? []
    }
    func save(_ messages: [ConversationMessage], deviceID: String, threadID: String) throws {
        try JSONEncoder().encode(messages).write(to: file(deviceID: deviceID, threadID: threadID), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func loadState(deviceID: String) -> BridgeState? {
        guard let url = try? file(deviceID: deviceID, threadID: "__state__"), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(BridgeState.self, from: data)
    }
    func saveState(_ state: BridgeState, deviceID: String) throws {
        try JSONEncoder().encode(state).write(to: file(deviceID: deviceID, threadID: "__state__"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func removeAll() {
        guard let root = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false) else { return }
        try? FileManager.default.removeItem(at: root.appendingPathComponent("Conversations"))
    }
}
