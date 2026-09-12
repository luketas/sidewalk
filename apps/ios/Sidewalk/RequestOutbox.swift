import Foundation
import CryptoKit

/// Serializes durable command identities. Retrying an uncertain UI mutation reuses its ID.
final class RequestOutbox: @unchecked Sendable {
    static let shared = RequestOutbox()
    private let lock = NSLock()
    private var file: URL {
        get throws {
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            return directory.appendingPathComponent("pending-command-identities.json")
        }
    }
    private func load() throws -> [String: String] {
        let path = try file
        guard FileManager.default.fileExists(atPath: path.path) else { return [:] }
        return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: path))
    }
    private func save(_ value: [String: String]) throws {
        try JSONEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func prepare(deviceID: String, path: String, body: [String: Any]) throws -> (key: String, body: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        var source = body; source.removeValue(forKey: "commandID")
        let data = try JSONSerialization.data(withJSONObject: ["deviceID": deviceID, "path": path, "body": source], options: [.sortedKeys])
        let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        var records = try load(); let commandID = records[key] ?? (body["commandID"] as? String ?? UUID().uuidString)
        records[key] = commandID; try save(records)
        source["commandID"] = commandID; return (key, source)
    }
    func resolve(_ key: String) throws { lock.lock(); defer { lock.unlock() }; var records = try load(); records.removeValue(forKey: key); try save(records) }
}
