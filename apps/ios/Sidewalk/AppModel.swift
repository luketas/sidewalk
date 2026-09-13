import SwiftUI
import Observation

@MainActor @Observable
final class AppModel {
    var state = BridgeState.empty
    var phase = VoicePhase.idle
    var captions: [Caption] = []
    var messages: [ConversationMessage] = []
    var historyError: String?
    var conversationRows: [ConversationRow] { ConversationRow.group(messages) }
    private let historyCache = ConversationCache()
    private var historyLoading = false
    private var lastOutputAt = Date.distantPast
    var error: String?
    var online = false
    var busy = false
    var muted = false
    var speaking = false
    var playingReply = false
    private let speaker = TaskSpeaker()
    private let activity = ConversationAudio()
    var waitingSounds = UserDefaults.standard.object(forKey: "waitingSounds") as? Bool ?? true
    var currentPermissions: [ToolPermission] { (state.permissions ?? []).filter { $0.threadID == focused?.id } }
    private var displayedReplies = Set<String>()
    private var lastInputAt = Date.distantPast
    var sheet: AppSheet?
    var credential = CredentialVault.read()
    var disclosureAccepted = UserDefaults.standard.bool(forKey: "dataDisclosureV1")
    private let voice = VoiceTransport()
    private var startTask: Task<Void, Never>?
    var focused: WorkThread? { state.threads.first { $0.id == state.focus.threadID } }
    var currentTasks: [WorkTask] { state.tasks.filter { $0.threadID == focused?.id && $0.status != "continued" } }
    func summary(for thread: WorkThread) -> String {
        guard thread.status == "ready" else { return thread.detail }
        let tasks = state.tasks.filter { $0.threadID == thread.id }
        if let question = tasks.last(where: { $0.status == "question" }) { return question.statusLabel }
        if let active = tasks.last(where: { ["unknown", "answer_queued", "working", "delivered", "queued"].contains($0.status) }) {
            return active.statusLabel
        }
        return thread.detail
    }
    var client: BridgeClient? { credential.map(BridgeClient.init) }
    var inCall: Bool { phase == .connecting || phase == .listening || phase == .ending }
    var status: String {
        if case .failed(let message) = phase { return message }
        if credential == nil { return "Bring your Mac into the conversation." }
        if !online { return "Connecting to your Mac…" }
        if !state.readiness.voiceKey { return "Add your OpenAI key on the Mac to enable voice." }
        if phase == .connecting { return "Connecting your voice…" }
        if phase == .ending { return "Ending the voice conversation…" }
        if speaking { return "Speaking · you can interrupt by talking" }
        if !currentPermissions.isEmpty { return "Claude needs your approval. Review the action below." }
        if let active = currentTasks.last(where: { ["queued", "working", "delivered", "unknown", "answer_queued"].contains($0.status) }) { return active.waitingReason ?? active.activity ?? active.statusLabel }
        if let notice = state.notice, !notice.isEmpty { return notice }
        if phase == .listening { return muted ? "Microphone muted" : "Listening. Take your time." }
        return focused?.detail ?? "Start a thread, or just start talking."
    }
    init() {
        if let credential, let saved = historyCache.loadState(deviceID: credential.deviceID) {
            state = saved
            if let threadID = saved.focus.threadID { messages = historyCache.load(deviceID: credential.deviceID, threadID: threadID) }
        }
        activity.onSpeech = { [weak self] in self?.voice.protectStatusAudio($0) }
        speaker.onPlayback = { [weak self] active in self?.playingReply = active; self?.voice.protectReplyAudio(active) }
        speaker.onState = { [weak self] active in self?.speaking = active; if active { self?.activity.stopOutputs() } }
        speaker.onError = { [weak self] in self?.error = $0 }
        voice.onPhase = { [weak self] in
            self?.phase = $0
            if $0 != .listening { self?.speaker.stop(); self?.activity.reset() }
            if case .failed(let message) = $0 { self?.activity.say(message) }
        }
        voice.onAudioActivity = { [weak self] active in
            guard let self else { return }
            self.speaking = active; self.playingReply = active
            if active { self.lastOutputAt = Date(); self.activity.stopOutputs() }
        }
        voice.onCaption = { [weak self] user, _ in
            guard let self else { return }
            self.activity.stopOutputs()
            if user { self.lastInputAt = Date() } else { self.lastOutputAt = Date() }
        }
    }

    func refresh() async {
        guard let client else { return }
        let deviceID = client.credential.deviceID
        do {
            let next: BridgeState = try await client.request("v1/state")
            guard credential?.deviceID == deviceID else { return }
            applyState(next); online = true
            try? historyCache.saveState(state, deviceID: deviceID)
            await refreshHistory(client: client)
            updateActivity()
        } catch {
            guard credential?.deviceID == deviceID else { return }
            online = false; self.error = error.localizedDescription
            speaker.stop(); updateActivity()
        }
    }
    private func updateActivity() {
        if case .failed = phase { return }
        activity.update(task: currentTasks.last, permission: currentPermissions.first, online: online, inCall: phase == .listening, quiet: Date().timeIntervalSince(lastInputAt) > 1.2 && Date().timeIntervalSince(lastOutputAt) > 1.5, replying: speaking, sounds: waitingSounds)
    }
    private func refreshHistory(client: BridgeClient) async {
        guard !historyLoading, let threadID = state.focus.threadID else { return }
        let deviceID = client.credential.deviceID
        historyLoading = true; defer { historyLoading = false }
        do {
            // Drain pages without delaying current status indefinitely; resume next poll.
            for _ in 0..<5 {
                let cursor = messages.last?.seq ?? 0
                let page: ConversationPage = try await client.request("v1/conversation", query: ["threadID": threadID, "after": String(cursor)])
                guard credential?.deviceID == deviceID, state.focus.threadID == threadID, page.threadID == threadID else { return }
                let existing = Set(messages.map(\.id))
                let additions = page.messages.filter { !existing.contains($0.id) }
                if !additions.isEmpty {
                    messages.append(contentsOf: additions)
                    try historyCache.save(messages, deviceID: deviceID, threadID: threadID)
                }
                historyError = nil
                if !page.hasMore { break }
            }
        } catch { if state.focus.threadID == threadID { historyError = "Conversation sync paused. Your saved messages are still here." } }
    }
    func sendText(_ text: String) async -> Bool {
        guard let client, let threadID = state.focus.threadID, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        do {
            let accepted: WorkTask = try await client.request("v1/tasks", body: ["commandID": UUID().uuidString, "threadID": threadID, "text": text, "sourceRevision": 0, "focusEpoch": state.focus.epoch])
            // Acceptance is the send boundary. History/network refresh must not keep
            // the submitted text in the composer or delay the next message.
            if credential?.deviceID == client.credential.deviceID {
                if !state.tasks.contains(where: { $0.id == accepted.id }) { state.tasks.append(accepted) }
                error = nil
                Task { await refresh() }
            }
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func decide(_ permission: ToolPermission, allow: Bool) async {
        guard let client else { return }
        do { let _: ToolPermission = try await client.request("v1/permissions", body: ["permissionID": permission.id, "commandID": UUID().uuidString, "decision": allow ? "allow" : "deny", "focusEpoch": state.focus.epoch]); error = nil; await refresh() }
        catch { self.error = error.localizedDescription }
    }
    func poll() async {
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .milliseconds(inCall ? 500 : 2000)) } catch { return }
        }
    }
    func pair(_ value: String) async {
        guard !busy, !inCall else { return }
        busy = true; defer { busy = false }
        do {
            let payload = try JSONDecoder().decode(PairingPayload.self, from: Data(value.utf8))
            let result = try await BridgeClient.pair(payload)
            let previousThreadID = state.focus.threadID
            try CredentialVault.save(result); resetConversation(); credential = result
            await refresh(); sheet = nil
            if let thread = state.threads.first(where: { $0.id == previousThreadID }) { await focus(thread) }
        } catch { self.error = error.localizedDescription }
    }
    func resetConversation() {
        speaker.stop(); activity.reset(); displayedReplies.removeAll()
        state = .empty; captions.removeAll(); messages.removeAll(); historyError = nil; error = nil; online = false
    }
    func applyState(_ next: BridgeState) {
        guard next.focus.epoch >= state.focus.epoch else { return }
        if next.focus.threadID != state.focus.threadID {
            speaker.stop(); activity.reset(); displayedReplies = Set(next.tasks.filter { $0.threadID == next.focus.threadID && $0.hasReply }.map(TaskSpeaker.key))
            captions.removeAll()
            messages = next.focus.threadID.flatMap { threadID in credential.map { historyCache.load(deviceID: $0.deviceID, threadID: threadID) } } ?? []
            historyError = nil
            error = nil
        }
        state = next
    }
    func createThread() async -> Bool {
        guard !busy else { return false }
        guard let client, let projectID = focused?.projectID ?? state.projects.first?.id else { error = "Configure a project on your Mac first."; return false }
        busy = true; defer { busy = false }
        do { let _: WorkThread = try await client.request("v1/threads", body: ["commandID": UUID().uuidString, "projectID": projectID, "focus": true]); captions.removeAll(); error = nil; await refresh(); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    func focus(_ thread: WorkThread) async {
        guard let client else { return }
        do { let focus: Focus = try await client.request("v1/focus", body: ["threadID": thread.id, "commandID": UUID().uuidString]); var next = state; next.focus = focus; applyState(next); error = nil; await refresh() }
        catch { self.error = error.localizedDescription }
    }
    func resume(_ thread: WorkThread) async {
        guard let client else { return }
        busy = true; defer { busy = false }
        do {
            let _: WorkThread = try await client.request("v1/resume", body: [
                "commandID": UUID().uuidString, "threadID": thread.id
            ])
            error = nil
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func check(_ task: WorkTask) async {
        guard let client else { return }
        do {
            let _: WorkTask = try await client.request("v1/reconcile", body: [
                "commandID": UUID().uuidString, "taskID": task.id
            ])
            error = nil
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func cancel(_ task: WorkTask) async {
        guard let client else { return }
        do { let _: WorkTask = try await client.request("v1/cancel", body: ["taskID": task.id, "commandID": UUID().uuidString]); error = nil; await refresh() }
        catch { self.error = error.localizedDescription }
    }
    func answer(_ task: WorkTask, text: String) async -> Bool {
        guard let client, let questionID = task.questionID,
              state.focus.threadID == task.threadID else { return false }
        let focusEpoch = state.focus.epoch
        do {
            let _: WorkTask = try await client.request("v1/answers", body: [
                "commandID": UUID().uuidString, "threadID": task.threadID,
                "taskID": task.id, "questionID": questionID,
                "text": text, "focusEpoch": focusEpoch
            ])
            error = nil
            await refresh()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func acceptDisclosure() { disclosureAccepted = true; UserDefaults.standard.set(true, forKey: "dataDisclosureV1") }
    func talk() {
        guard let client, online, state.readiness.voiceKey, disclosureAccepted else { sheet = .settings; return }
        error = nil; muted = false; speaker.stop(); speaker.beginCall()
        startTask = Task { do { try await voice.start(client: client) } catch is CancellationError { phase = .idle } catch { phase = .failed(error.localizedDescription) } }
    }
    func interruptReply() { speaker.stop(); voice.interrupt(); lastInputAt = Date() }
    func playReply(_ task: WorkTask) {
        guard let client else { return }
        if inCall { Task { do { try await voice.repeatReply(task) } catch { self.error = error.localizedDescription } } }
        else { speaker.play(task, client: client) }
    }
    func end() async { activity.reset(); speaker.stop(); startTask?.cancel(); await voice.end() }
    func toggleMute() async {
        muted.toggle()
        do { try await voice.mute(muted) } catch { muted = true; self.error = error.localizedDescription }
    }
    func forget() async {
        await end()
        if let client { let _: [String: Bool]? = try? await client.request("v1/revoke", body: [:]) }
        CredentialVault.remove(); historyCache.removeAll(); credential = nil; resetConversation()
    }
}
