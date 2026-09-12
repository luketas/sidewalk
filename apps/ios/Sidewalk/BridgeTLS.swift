import Foundation
import Security
import CryptoKit

final class BridgeTLS: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let root: URL
    let fingerprint: String?

    init(root: URL, fingerprint: String?) {
        self.root = root
        self.fingerprint = fingerprint
    }

    static func isPrivateIPv4(_ host: String) -> Bool {
        let segments = host.split(separator: ".", omittingEmptySubsequences: false)
        let parts = segments.compactMap { UInt8($0) }
        guard segments.count == 4, parts.count == 4 else { return false }
        return parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168)
    }

    static func session(root: URL, fingerprint: String?) throws -> URLSession {
        if let fingerprint {
            guard root.scheme == "https", isPrivateIPv4(root.host ?? ""),
                  fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
                throw BridgeError.message("The Mac's secure connection code is invalid. Scan a fresh code.")
            }
        }
        return URLSession(configuration: .ephemeral, delegate: BridgeTLS(root: root, fingerprint: fingerprint), delegateQueue: nil)
    }

    static func matches(_ trust: SecTrust, host: String, fingerprint: String) -> Bool {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first else { return false }
        let data = SecCertificateCopyData(certificate) as Data
        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actual == fingerprint else { return false }
        // Trust only the certificate authenticated by the scanned QR, with an
        // SSL policy for this exact host. This does not alter the system trust store.
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { return false }
        return SecTrustEvaluateWithError(trust, nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        guard challenge.protectionSpace.host == root.host else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        guard let fingerprint else { completionHandler(.performDefaultHandling, nil); return }
        guard let trust = challenge.protectionSpace.serverTrust,
              Self.matches(trust, host: root.host!, fingerprint: fingerprint) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Bridge endpoints never redirect. Never forward pairing codes or tokens.
        completionHandler(nil)
    }
}
