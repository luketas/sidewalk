import XCTest
import Security
import CryptoKit
@testable import Sidewalk

final class TLSTests: XCTestCase {
    // Public test certificate only; generated for a synthetic IP, private key discarded.
    private let certificate = "MIIBxzCCAW2gAwIBAgIUYRBVZluJevze7R+LJNsxXYYPgJkwCgYIKoZIzj0EAwIwHTEbMBkGA1UEAwwSU2lkZXdhbGsgVEVTVCBPTkxZMB4XDTI2MDkxMjA3MDI0MloXDTI3MDkxMjA3MDI0MlowHTEbMBkGA1UEAwwSU2lkZXdhbGsgVEVTVCBPTkxZMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXce5N+D6MynO36MxRwEKLLYWAqEHe0IRk+yxF+Xc9Bk8Urmm/FfqSaJeSMdNmUgkCDlhf1h8jYXi18NdzG2LnaOBijCBhzAdBgNVHQ4EFgQUUBxqrw7S326x/LgpaK7mCfoTLRkwHwYDVR0jBBgwFoAUUBxqrw7S326x/LgpaK7mCfoTLRkwDwYDVR0RBAgwBocEChctQzAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIChDATBgNVHSUEDDAKBggrBgEFBQcDATAKBggqhkjOPQQDAgNIADBFAiEA0559wCJ4E0ozPURGwVSD5+77/iep0UWw1LuI/XqHjjoCICru+wNdZUbKSjAK80RERPledx6UGk4qpTmigp6wokJG"
    func testPinnedCertificateRequiresBothExactFingerprintAndHostname() throws {
        let data = try XCTUnwrap(Data(base64Encoded: certificate))
        let cert = try XCTUnwrap(SecCertificateCreateWithData(nil, data as CFData))
        let fingerprint = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        func trust() throws -> SecTrust {
            var result: SecTrust?
            XCTAssertEqual(SecTrustCreateWithCertificates(cert, SecPolicyCreateSSL(true, "10.23.45.67" as CFString), &result), errSecSuccess)
            let value = try XCTUnwrap(result)
            // Freeze verification within this synthetic certificate's validity period.
            SecTrustSetVerifyDate(value, Date(timeIntervalSince1970: 1789196622) as CFDate)
            return value
        }
        XCTAssertTrue(BridgeTLS.matches(try trust(), host: "10.23.45.67", fingerprint: fingerprint))
        XCTAssertFalse(BridgeTLS.matches(try trust(), host: "10.23.45.68", fingerprint: fingerprint))
        XCTAssertFalse(BridgeTLS.matches(try trust(), host: "10.23.45.67", fingerprint: String(repeating: "0", count: 64)))
    }
    func testScannedPinsAreLimitedToSecurePrivateAddresses() throws {
        let fingerprint = String(repeating: "a", count: 64)
        for host in ["example.com", "8.8.8.8", "127.0.0.1", "bad.10.0.0.1", "10.0.0.999"] {
            XCTAssertFalse(BridgeTLS.isPrivateIPv4(host))
            XCTAssertThrowsError(try BridgeTLS.session(root: XCTUnwrap(URL(string: "https://\(host)")), fingerprint: fingerprint))
        }
        XCTAssertThrowsError(try BridgeTLS.session(root: XCTUnwrap(URL(string: "http://10.0.0.1")), fingerprint: fingerprint))
        XCTAssertThrowsError(try BridgeTLS.session(root: XCTUnwrap(URL(string: "https://10.0.0.1")), fingerprint: "invalid"))
        let session = try BridgeTLS.session(root: XCTUnwrap(URL(string: "https://10.0.0.1")), fingerprint: fingerprint)
        session.invalidateAndCancel()
    }
    func testPairingPinPersistsAndOlderCredentialsRemainReadable() throws {
        let old = Data(#"{"deviceID":"device","token":"token","baseURL":"https://mac.example.ts.net"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(DeviceCredential.self, from: old).certificateSHA256)
        let credential = DeviceCredential(deviceID: "device", token: "token", baseURL: "https://10.0.0.1", certificateSHA256: String(repeating: "a", count: 64))
        let restored = try JSONDecoder().decode(DeviceCredential.self, from: JSONEncoder().encode(credential))
        XCTAssertEqual(restored.certificateSHA256, credential.certificateSHA256)
    }
}
