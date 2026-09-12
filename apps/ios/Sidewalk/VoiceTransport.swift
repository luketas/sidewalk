import Foundation
import AVFoundation
@preconcurrency import WebRTC

@MainActor
final class VoiceTransport: NSObject {
    var onPhase: ((VoicePhase) -> Void)?
    var onAudioActivity: ((Bool) -> Void)?
    private var activityTask: Task<Void, Never>?
    private var lastAudibleAt = Date.distantPast
    var onCaption: ((Bool, String) -> Void)?
    private var peer: RTCPeerConnection?
    private var events: RTCDataChannel?
    private var microphone: RTCAudioTrack?
    private var client: BridgeClient?
    private var sessionID: String?
    private var generation = UUID()
    private var ending = false
    private var ready = false
    private var userMuted = false
    private var statusAudio = false
    private var replyAudio = false
    private var captureRelease: Task<Void, Never>?
    static func captureEnabled(ready: Bool, ending: Bool, userMuted: Bool, statusAudio: Bool, replyAudio: Bool = false) -> Bool { ready && !ending && !userMuted && !statusAudio && !replyAudio }
    private func updateCapture() { microphone?.isEnabled = Self.captureEnabled(ready: ready, ending: ending, userMuted: userMuted, statusAudio: statusAudio, replyAudio: replyAudio) }
    func protectReplyAudio(_ active: Bool) {
        replyAudio = active
        if !active { protectStatusAudio(true); protectStatusAudio(false) }
        updateCapture()
    }
    func protectStatusAudio(_ active: Bool) {
        captureRelease?.cancel()
        if active { statusAudio = true; updateCapture() }
        else if statusAudio {
            captureRelease = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                guard let self else { return }; self.statusAudio = false; self.updateCapture()
            }
        }
    }
    private var timeout: Task<Void, Never>?
    private var interruption: NSObjectProtocol?
    private lazy var factory = RTCPeerConnectionFactory()

    func interrupt() {
        guard let events else { return }
        let event: [String: Any] = ["type": "session.instructions.append", "event_id": UUID().uuidString, "delegation_id": NSNull(), "content": "Pause speaking now and listen. This interrupts playback only; do not cancel or repeat backend work."]
        if let data = try? JSONSerialization.data(withJSONObject: event) { events.sendData(RTCDataBuffer(data: data, isBinary: false)) }
    }
    func repeatReply(_ task: WorkTask) async throws {
        guard let client, let sessionID else { return }
        let _: [String: Bool] = try await client.request("v1/voice/repeat", body: ["sessionID": sessionID, "taskID": task.id, "replyID": task.replyID ?? ""])
    }
    private func observeAudio() {
        activityTask?.cancel()
        let run = generation
        activityTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.generation == run, let peer = self.peer else { return }
                peer.statistics { [weak self] report in
                    let audible = report.statistics.values.contains { stat in
                        stat.type == "inbound-rtp" && (stat.values["kind"] as? String == "audio" || stat.values["mediaType"] as? String == "audio") && ((stat.values["audioLevel"] as? NSNumber)?.doubleValue ?? 0) > 0.002
                    }
                    Task { @MainActor in
                        guard let self, self.generation == run else { return }
                        if audible { self.lastAudibleAt = Date() }
                        self.onAudioActivity?(Date().timeIntervalSince(self.lastAudibleAt) < 0.6)
                    }
                }
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            }
        }
    }
    func start(client: BridgeClient) async throws {
        guard peer == nil else { return }
        generation = UUID(); let run = generation
        ending = false; ready = false; userMuted = false; self.client = client; onPhase?(.connecting)
        let allowed = await AVAudioApplication.requestRecordPermission()
        guard allowed else { throw BridgeError.message("Allow microphone access in iPhone Settings to talk.") }
        try Task.checkCancellation()
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
        try audio.setActive(true)
        RTCInitializeSSL()
        let configuration = RTCConfiguration(); configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else { throw BridgeError.message("Audio connection could not be created.") }
        self.peer = peer
        let source = factory.audioSource(with: constraints)
        let track = factory.audioTrack(with: source, trackId: "microphone")
        track.isEnabled = false; microphone = track
        peer.add(track, streamIds: ["voice"])
        events = peer.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
        events?.delegate = self
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  type == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in await self?.end(); self?.onPhase?(.failed("Audio was interrupted. Tap Talk to reconnect.")) }
        }
        do {
            let offerSDP: String = try await withCheckedThrowingContinuation { continuation in
                peer.offer(for: RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)) { offer, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let offer { continuation.resume(returning: offer.sdp) }
                    else { continuation.resume(throwing: BridgeError.message("Could not create the audio offer.")) }
                }
            }
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in peer.setLocalDescription(RTCSessionDescription(type: .offer, sdp: offerSDP)) { error in if let error { c.resume(throwing: error) } else { c.resume() } } }
            for _ in 0..<80 {
                if peer.iceGatheringState == .complete { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            guard peer.iceGatheringState == .complete, let sdp = peer.localDescription?.sdp else { throw BridgeError.message("Audio network setup timed out. Try your connection again.") }
            let session: VoiceSession = try await client.request("v1/voice", body: ["sdp": sdp])
            sessionID = session.session.id
            guard generation == run, !ending else { await end(); return }
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: session.transport.sdp)) { error in if let error { c.resume(throwing: error) } else { c.resume() } } }
            if !ready { timeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self, self.generation == run else { return }
                await self.end(); self.onPhase?(.failed("Voice did not become ready. Check model access and the Mac connection."))
            } }
        } catch { await end(); throw error }
    }
    func mute(_ muted: Bool) async throws {
        userMuted = muted; updateCapture()
        guard let client, let sessionID else { return }
        do { let _: [String: Bool] = try await client.request("v1/voice/mute", body: ["sessionID": sessionID, "muted": muted]) }
        catch { microphone?.isEnabled = false; throw error }
    }
    func end() async {
        ending = true; timeout?.cancel(); microphone?.isEnabled = false
        guard let sessionID, let client else { cleanup(); onPhase?(.idle); return }
        onPhase?(.ending)
        // The bridge owns close. Keep media alive briefly for session.closed/final usage.
        let _: [String: String]? = try? await client.request("v1/voice/end", body: ["sessionID": sessionID])
        let run = generation
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled, let self, self.generation == run else { return }
            self.cleanup(); self.onPhase?(.idle)
        }
    }
    private func cleanup() {
        activityTask?.cancel(); onAudioActivity?(false); timeout?.cancel(); captureRelease?.cancel(); ready = false; statusAudio = false; replyAudio = false; generation = UUID(); microphone?.isEnabled = false
        events?.delegate = nil; events?.close(); events = nil
        peer?.delegate = nil; peer?.close(); peer = nil; microphone = nil; sessionID = nil
        if let interruption { NotificationCenter.default.removeObserver(interruption) }; interruption = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    private func event(_ data: Data) {
        guard let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = event["type"] as? String else { return }
        switch type {
        case "session.started":
            guard !ending else { return }
            ready = true; timeout?.cancel(); updateCapture(); observeAudio(); onPhase?(.listening)
        case "session.closed": cleanup(); onPhase?(.idle)
        case "session.input_transcript.delta", "session.output_transcript.delta":
            if let delta = event["delta"] as? String { onCaption?(type == "session.input_transcript.delta", delta) }
        case "error":
            Task { await end(); onPhase?(.failed("Voice reported an error. Check the Mac and reconnect.")) }
        default: break
        }
    }
}
extension VoiceTransport: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        let identity = ObjectIdentifier(dataChannel)
        Task { @MainActor in guard self.events.map(ObjectIdentifier.init) == identity else { return }; self.event(data) }
    }
}
extension VoiceTransport: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) { stream.audioTracks.forEach { $0.isEnabled = true } }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]) { rtpReceiver.track?.isEnabled = true }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed || newState == .disconnected {
            let identity = ObjectIdentifier(peerConnection)
            Task { @MainActor in guard self.peer.map(ObjectIdentifier.init) == identity, !self.ending else { return }; await self.end(); self.onPhase?(.failed("Audio disconnected. Your Claude work remains on the Mac.")) }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
