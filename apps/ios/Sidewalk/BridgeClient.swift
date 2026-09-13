import Foundation
import Security

enum BridgeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
struct BridgeClient {
    let credential: DeviceCredential
    static func validateURL(_ value: String) throws -> URL {
        guard let url = URL(string: value), let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else {
            throw BridgeError.message("Use the connection address from your Mac.")
        }
        #if targetEnvironment(simulator)
        let local = ["localhost", "127.0.0.1", "::1"].contains(host)
        #else
        let local = false
        #endif
        guard url.scheme == "https" || (local && url.scheme == "http") else {
            throw BridgeError.message("Your phone needs a secure HTTPS connection to the Mac.")
        }
        return url
    }
    func request<T: Decodable>(_ path: String, body: [String: Any]? = nil, query: [String: String] = [:]) async throws -> T {
        var body = body
        var outboxKey: String?
        if let mutation = body, mutation["commandID"] != nil {
            let prepared = try RequestOutbox.shared.prepare(deviceID: credential.deviceID, path: path, body: mutation)
            body = prepared.body; outboxKey = prepared.key
        }
        let root = try Self.validateURL(credential.baseURL)
        var components = URLComponents(url: root.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: components.url!, timeoutInterval: path == "v1/state" || path == "v1/conversation" ? 6 : 25)
        req.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        if let body { req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let session = try BridgeTLS.session(root: root, fingerprint: credential.certificateSHA256)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: req)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            if let status = (response as? HTTPURLResponse)?.statusCode, [400, 401, 403, 404, 409, 413, 415].contains(status), let outboxKey { try? RequestOutbox.shared.resolve(outboxKey) }
            let detail = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
            throw BridgeError.message(detail?["message"] ?? "Your Mac could not complete the request.")
        }
        let decoded = try JSONDecoder().decode(T.self, from: data)
        // A local cleanup failure must not turn a confirmed server acceptance into a failed send.
        if let outboxKey { try? RequestOutbox.shared.resolve(outboxKey) }
        return decoded
    }
    func speech(taskID: String, replyID: String? = nil) async throws -> Data {
        let root = try Self.validateURL(credential.baseURL)
        var req = URLRequest(url: root.appendingPathComponent("v1/speech"), timeoutInterval: 40)
        req.httpMethod = "POST"
        req.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body = ["taskID": taskID]
        if let replyID { body["replyID"] = replyID }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let session = try BridgeTLS.session(root: root, fingerprint: credential.certificateSHA256)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: req)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, response.mimeType == "audio/mpeg" else {
            throw BridgeError.message("Could not read Claude’s reply aloud. Tap Hear reply to retry.")
        }
        return data
    }
    static func pair(_ payload: PairingPayload) async throws -> DeviceCredential {
        let url = try validateURL(payload.url)
        var req = URLRequest(url: url.appendingPathComponent("v1/pair"), timeoutInterval: 15)
        req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["code": payload.code, "name": "My iPhone"])
        let session = try BridgeTLS.session(root: url, fingerprint: payload.certificateSHA256)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: req)
        guard (response as? HTTPURLResponse)?.statusCode == 201 else { throw BridgeError.message("Pairing expired or failed. Get a fresh connection code on your Mac.") }
        struct Reply: Codable { let deviceID: String; let token: String }
        let result = try JSONDecoder().decode(Reply.self, from: data)
        return DeviceCredential(deviceID: result.deviceID, token: result.token, baseURL: url.absoluteString, certificateSHA256: payload.certificateSHA256)
    }
}
struct CredentialVault {
    static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.lucasfranco.sidewalk", kSecAttrAccount as String: "paired-mac"] }
    static func read() -> DeviceCredential? {
        var query = query; query[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(DeviceCredential.self, from: data)
    }
    static func save(_ credential: DeviceCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let fields: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            let status = SecItemAdd(query.merging(fields) { _, new in new } as CFDictionary, nil)
            guard status == errSecSuccess else { throw BridgeError.message("Could not securely store this connection.") }; return
        }
        guard status == errSecSuccess else { throw BridgeError.message("Could not update the secure connection.") }
    }
    static func remove() { SecItemDelete(query as CFDictionary) }
}
