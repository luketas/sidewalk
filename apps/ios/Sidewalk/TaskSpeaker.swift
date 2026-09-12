import Foundation
import AVFoundation
import CryptoKit

@MainActor
final class TaskSpeaker: NSObject, AVAudioPlayerDelegate {
    var onPlayback: ((Bool) -> Void)?
    var onState: ((Bool) -> Void)?
    var onError: ((String) -> Void)?
    private var playing = false
    private var player: AVAudioPlayer?
    private var download: Task<Void, Never>?
    private var generation = UUID()
    private var currentKey: String?
    private var attempted = Set<String>()
    private var heard = Set(UserDefaults.standard.stringArray(forKey: "heardClaudeReplies") ?? [])
    static func key(_ task: WorkTask) -> String {
        let value = task.id + ":" + task.status + ":" + (task.questionID ?? "") + ":" + (task.speech ?? task.result) + ":" + (task.replyID ?? "")
        return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func candidate(_ tasks: [WorkTask], heard: Set<String>, attempted: Set<String>) -> WorkTask? {
        guard let task = tasks.last, task.hasSpokenUpdate, !heard.contains(key(task)), !attempted.contains(key(task)) else { return nil }
        return task
    }
    func beginCall() { attempted.removeAll() }
    func consider(_ tasks: [WorkTask], client: BridgeClient) {
        if let latest = tasks.last, let currentKey, latest.hasReply && Self.key(latest) != currentKey { stop() }
        guard player == nil, download == nil,
              let task = Self.candidate(tasks, heard: heard, attempted: attempted) else { return }
        play(task, client: client)
    }
    func play(_ task: WorkTask, client: BridgeClient) {
        stop()
        let run = generation, key = Self.key(task)
        attempted.insert(key); currentKey = key; onState?(true)
        download = Task { [weak self] in
            do {
                let data = try await client.speech(taskID: task.id, replyID: task.replyID)
                try Task.checkCancellation()
                guard let self, self.generation == run else { return }
                let audio = AVAudioSession.sharedInstance()
                try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
                try audio.setActive(true)
                let player = try AVAudioPlayer(data: data)
                self.player = player; player.delegate = self
                self.playing = true; self.onPlayback?(true)
                guard player.play() else { throw BridgeError.message("Could not play Claude’s reply. Tap Hear reply to retry.") }
                self.download = nil
            } catch is CancellationError {} catch {
                guard let self, self.generation == run else { return }
                self.stop(); self.onError?(error.localizedDescription)
            }
        }
    }
    func stop() {
        generation = UUID(); download?.cancel(); download = nil
        player?.stop(); player = nil; currentKey = nil; if playing { playing = false; onPlayback?(false) }; onState?(false)
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let identity = ObjectIdentifier(player)
        Task { @MainActor in
            guard self.player.map(ObjectIdentifier.init) == identity else { return }
            if flag, let key = self.currentKey {
                self.heard.insert(key)
                UserDefaults.standard.set(Array(self.heard.suffix(200)), forKey: "heardClaudeReplies")
            }
            self.stop()
        }
    }
}
