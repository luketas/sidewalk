import SwiftUI
@preconcurrency import AVFoundation

struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onError: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode; controller.onError = onError
        return controller
    }
    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
    static func dismantleUIViewController(_ uiViewController: ScannerController, coordinator: ()) { uiViewController.stop() }
}
final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onError: ((String) -> Void)?
    private let capture = AVCaptureSession()
    private var layer: AVCaptureVideoPreviewLayer?
    private var finished = false
    private var inactive = false
    private let captureQueue = DispatchQueue(label: "sidewalk.camera")
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        Task { @MainActor in
            guard await AVCaptureDevice.requestAccess(for: .video) else { onError?("Allow camera access to scan, or paste the connection code."); return }
            configure()
        }
    }
    private func configure() {
        guard !inactive else { return }
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), capture.canAddInput(input) else { onError?("Camera is unavailable. Paste the Mac connection code instead."); return }
        capture.addInput(input)
        let metadata = AVCaptureMetadataOutput()
        guard capture.canAddOutput(metadata) else { onError?("QR scanning is unavailable."); return }
        capture.addOutput(metadata); metadata.setMetadataObjectsDelegate(self, queue: .main); metadata.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: capture); preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview); layer = preview
        // Capture setup uses a private queue; callbacks return on the main queue.
        let session = capture
        captureQueue.async { session.startRunning() }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); layer?.frame = view.bounds }
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let value = object.stringValue else { return }
        Task { @MainActor in
            guard !self.finished, !self.inactive,
                  (try? JSONDecoder().decode(PairingPayload.self, from: Data(value.utf8))) != nil else { return }
            self.finished = true; self.stop(); self.onCode?(value)
        }
    }
    func stop() { inactive = true; let session = capture; captureQueue.async { session.stopRunning() } }
}
