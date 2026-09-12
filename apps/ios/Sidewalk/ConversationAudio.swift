import AVFoundation
import Foundation

@MainActor
final class ConversationAudio: NSObject, AVSpeechSynthesizerDelegate {
    var onSpeech: ((Bool) -> Void)?
    private var currentUtterance: AVSpeechUtterance?
    override init() { super.init(); voice.delegate = self }
    private let voice = AVSpeechSynthesizer()
    private var tone: AVAudioPlayer?
    private var condition = ""
    private var started = Date()
    private var lastTone = Date.distantPast
    private var lastReminder = Date()
    private var taskID: String?
    private var pendingAnnouncement: String?
    static func blocker(task: WorkTask?, permission: ToolPermission?, online: Bool) -> (String, String?)? {
        if !online { return ("offline", "Your Mac disconnected. I’m reconnecting.") }
        // Permission cards are screen-only. Keep the blocker so waiting reminders also stay silent.
        if let permission { return (permission.id, nil) }
        if let tool = task?.permissionRequired { return ("mac:\(task!.id):\(tool)", nil) }
        if task?.status == "unknown" { return ("unknown:\(task!.id)", "Claude’s request was interrupted or lost its connection. I’m checking its status before continuing.") }
        return nil
    }
    func update(task: WorkTask?, permission: ToolPermission?, online: Bool, inCall: Bool, quiet: Bool, replying: Bool, sounds: Bool) {
        guard inCall else { reset(); return }
        let block = Self.blocker(task: task, permission: permission, online: online)
        let nextCondition = block?.0 ?? ""
        if condition != nextCondition {
            condition = nextCondition; pendingAnnouncement = block?.1
            stopOutputs()
        }
        if !quiet || replying { stopOutputs(); return }
        // In-call narration comes only from Live; native audio is the quiet nonverbal cue.
        pendingAnnouncement = nil
        guard block == nil else { return }
        guard let task, ["queued", "delivered", "working", "answer_queued"].contains(task.status) else { tone?.stop(); taskID = nil; return }
        if taskID != task.id { taskID = task.id; started = Date(); lastReminder = Date(); lastTone = Date() }
        guard !voice.isSpeaking else { return }
        if sounds && Date().timeIntervalSince(started) > 3 && Date().timeIntervalSince(lastTone) > 10 {
            lastTone = Date()
            if let url = Bundle.main.url(forResource: "waiting", withExtension: "wav") {
                tone = try? AVAudioPlayer(contentsOf: url); tone?.volume = 0.22; tone?.play()
            }
        }
    }
    func say(_ text: String) {
        stopOutputs()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.5
        currentUtterance = utterance; onSpeech?(true)
        voice.speak(utterance)
    }
    func stopOutputs() { tone?.stop(); currentUtterance = nil; voice.stopSpeaking(at: .immediate); onSpeech?(false) }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let identity = ObjectIdentifier(utterance)
        Task { @MainActor in
            guard self.currentUtterance.map(ObjectIdentifier.init) == identity else { return }
            self.currentUtterance = nil; self.onSpeech?(false)
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let identity = ObjectIdentifier(utterance)
        Task { @MainActor in
            guard self.currentUtterance.map(ObjectIdentifier.init) == identity else { return }
            self.currentUtterance = nil; self.onSpeech?(false)
        }
    }
    func reset() { stopOutputs(); condition = ""; pendingAnnouncement = nil; taskID = nil }
}
