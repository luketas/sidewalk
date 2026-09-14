import SwiftUI
struct ConversationView: View {
    @State private var draft = ComposerDraft()
    @FocusState private var composerFocused: Bool
    @State private var sendingText = false
    @State private var followingConversation = true
    @State private var threadsOpen = false
    @GestureState private var drawerDrag: CGFloat = 0
    @Bindable var model: AppModel
    @ScaledMetric(relativeTo: .largeTitle) private var heroSize: CGFloat = 43
    var body: some View {
        GeometryReader { geometry in
        let drawerWidth = min(geometry.size.width * 0.86, 360)
        ZStack(alignment: .leading) {
        VStack(spacing: 0) {
            header
            Text(model.status).font(.system(size: 14)).foregroundStyle(Palette.quiet)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 28).padding(.bottom, 10)
            if !model.currentPermissions.isEmpty {
                ScrollView {
                    ForEach(model.currentPermissions) { permission in
                        PermissionCard(permission: permission, decide: { await model.decide(permission, allow: $0) })
                    }
                }.frame(maxHeight: 260).padding(.horizontal, 28)
            }
            ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    HStack(spacing: 7) {
                        Circle().fill(model.online ? Palette.teal : Palette.quiet.opacity(0.4)).frame(width: 6, height: 6)
                        Text(model.online ? "MAC CONNECTED" : "YOUR VOICE WORKSPACE").font(.system(size: 11, weight: .semibold, design: .monospaced)).tracking(1.6)
                    }.foregroundStyle(Palette.quiet).padding(.top, 35)
                    Text(model.inCall || !model.messages.isEmpty ? "With Claude." : "Your work,\nin conversation.")
                        .font(.system(size: model.inCall || !model.messages.isEmpty ? 28 : heroSize, weight: .regular, design: .serif)).tracking(-1.3).fixedSize(horizontal: false, vertical: true)
                    if model.inCall, let task = model.currentTasks.last,
                       ["delivered", "working", "answer_queued", "queued"].contains(task.status),
                       !model.speaking, model.currentPermissions.isEmpty {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            let elapsed = max(0, Int(context.date.timeIntervalSince1970 - (task.activityAt ?? task.deliveredAt ?? task.createdAt ?? context.date.timeIntervalSince1970 * 1000) / 1000))
                            HStack(spacing: 10) {
                                ProgressView().tint(Palette.teal)
                                Text(elapsed >= 15 ? "Waiting for Claude’s next update · \(elapsed)s" : task.status == "queued" ? "Your message is queued." : "Claude has your message.").font(.caption).foregroundStyle(Palette.quiet)
                            }
                        }
                    }
                    if let thread = model.focused, ["offline", "unknown", "blocked"].contains(thread.status) {
                        Button { Task { await model.resume(thread) } } label: {
                            Label(model.busy ? "Reconnecting…" : "Reconnect this thread", systemImage: "arrow.clockwise")
                                .frame(minHeight: 44)
                        }.disabled(model.busy || !model.online)
                            .accessibilityIdentifier("resumeThread")
                    }
                    if model.messages.isEmpty {
                        voiceMotif.padding(.vertical, 24)
                        VStack(alignment: .leading, spacing: 13) {
                            Text("PICK UP A THOUGHT").font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.8).foregroundStyle(Palette.quiet)
                            Text("“Where did we leave off?”").font(.system(size: 21, design: .serif))
                            Text("“Start another thread for the login bug.”").font(.system(size: 17)).foregroundStyle(Palette.quiet)
                        }
                    } else {
                        ForEach(model.conversationRows) { row in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(row.role == "user" ? "YOU" : row.role == "voice" ? "SIDEWALK · VOICE" : "CLAUDE · FULL ANSWER")
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.5).foregroundStyle(Palette.quiet)
                                Text(.init(row.text)).font(.system(size: row.role == "voice" ? 16 : 18))
                                    .textSelection(.enabled).tint(Palette.teal)
                                if row.role == "claude", let task = model.currentTasks.first(where: { $0.id == row.taskID && $0.result == row.text && $0.hasReply }) {
                                    Button("Hear reply", systemImage: "speaker.wave.2") { model.playReply(task) }.font(.caption).frame(minHeight: 44)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading).id(row.id)
                        }
                    }
                    if let historyError = model.historyError { Text(historyError).font(.caption).foregroundStyle(Palette.quiet) }
                    ForEach(model.currentTasks.filter { !["completed", "failed", "canceled"].contains($0.status) }.suffix(3)) { task in
                        TaskCard(task: task, threadName: model.focused?.name ?? "Thread",
                                 cancel: { Task { await model.cancel(task) } },
                                 answer: { await model.answer(task, text: $0) },
                                 check: { await model.check(task) },
                                 hear: { model.playReply(task) })
                    }
                    Color.clear.frame(height: 1).id("conversationBottom")
                    if let error = model.error {
                        Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("connectionError")
                    }
                }.padding(.horizontal, 28).padding(.bottom, 28)
            }
            .scrollDismissesKeyboard(.interactively)
            .onScrollPhaseChange { _, phase in
                if phase == .interacting { followingConversation = false }
            }
            .onChange(of: model.messages.last?.seq) { _, _ in
                if followingConversation { withAnimation(.easeOut(duration: 0.18)) { scroll.scrollTo("conversationBottom", anchor: .bottom) } }
            }
            .onChange(of: model.state.focus.threadID) { _, _ in draft.reset(); composerFocused = false; followingConversation = true; scroll.scrollTo("conversationBottom", anchor: .bottom) }
            .onChange(of: model.credential?.deviceID) { _, _ in draft.reset(); composerFocused = false }
            .overlay(alignment: .bottomTrailing) {
                if !followingConversation {
                    Button("Latest", systemImage: "arrow.down") { followingConversation = true; withAnimation { scroll.scrollTo("conversationBottom", anchor: .bottom) } }
                        .font(.caption).padding(12).background(Palette.background, in: Capsule()).padding(.trailing, 28)
                }
            }
            }
            controls
        }
        .foregroundStyle(Palette.ink).background(Palette.background.ignoresSafeArea())
        .task(id: model.credential?.deviceID) { await model.poll() }
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .threads: ThreadsSheet(model: model)
            case .settings: SettingsSheet(model: model)
            }
        }
        .allowsHitTesting(!threadsOpen)
        .accessibilityHidden(threadsOpen)
        if threadsOpen || drawerDrag > 0 {
            Color.black.opacity(0.18 * drawerProgress(width: drawerWidth))
                .ignoresSafeArea()
                .onTapGesture { closeThreads() }
                .accessibilityLabel("Close threads")
            ThreadsDrawer(model: model, close: closeThreads)
                .frame(width: drawerWidth)
                .offset(x: threadsOpen ? min(0, drawerDrag) : -drawerWidth + drawerDrag)
                .transition(.move(edge: .leading))
        }
        Color.clear
            .frame(width: 24)
            .contentShape(Rectangle())
            .allowsHitTesting(!threadsOpen)
            .gesture(openDrawerGesture(width: drawerWidth))
            .accessibilityHidden(true)
        }
        .simultaneousGesture(closeDrawerGesture(width: drawerWidth))
        }
    }
    private var header: some View {
        HStack {
            Button { openThreads() } label: {
                Image(systemName: "line.3.horizontal").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Open threads")
            .accessibilityIdentifier("threadsMenuButton")
            Text("sidewalk").font(.system(size: 24, weight: .semibold, design: .serif)).tracking(-0.7)
            Spacer()
            Button { Task { _ = await model.createThread() } } label: {
                Group { if model.busy { ProgressView() } else { Image(systemName: "plus") } }.frame(width: 44, height: 44)
            }.disabled(model.busy || !model.online || model.state.projects.isEmpty)
                .accessibilityLabel("New thread").accessibilityIdentifier("quickNewThread")
            Button { model.sheet = .settings } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }.accessibilityLabel("Connection and settings")
        }.padding(.horizontal, 25).padding(.top, 12).padding(.bottom, 12)
    }
    private func openThreads() {
        composerFocused = false
        withAnimation(.snappy(duration: 0.24)) { threadsOpen = true }
    }
    private func closeThreads() {
        withAnimation(.snappy(duration: 0.24)) { threadsOpen = false }
    }
    private func drawerProgress(width: CGFloat) -> CGFloat {
        guard width > 0 else { return 0 }
        return threadsOpen ? max(0, min(1, 1 + drawerDrag / width)) : max(0, min(1, drawerDrag / width))
    }
    private func openDrawerGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($drawerDrag) { value, state, _ in
                guard value.translation.width > 0, abs(value.translation.width) > abs(value.translation.height) else { return }
                state = min(width, value.translation.width)
            }
            .onEnded { value in
                guard value.translation.width > 70 || value.predictedEndTranslation.width > width * 0.45 else { return }
                openThreads()
            }
    }
    private func closeDrawerGesture(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($drawerDrag) { value, state, _ in
                guard threadsOpen, value.translation.width < 0, abs(value.translation.width) > abs(value.translation.height) else { return }
                state = max(-width, value.translation.width)
            }
            .onEnded { value in
                guard threadsOpen,
                      value.translation.width < -70 || value.predictedEndTranslation.width < -width * 0.45
                else { return }
                closeThreads()
            }
    }
    private var voiceMotif: some View {
        ZStack {
            Circle().stroke(Palette.teal.opacity(0.07), lineWidth: 1).frame(width: 210, height: 210)
            Circle().stroke(Palette.teal.opacity(0.15), lineWidth: 1).frame(width: 158, height: 158)
            Circle().fill(Palette.teal.opacity(0.08)).frame(width: 104, height: 104)
            Image(systemName: "waveform").font(.system(size: 34, weight: .light)).foregroundStyle(Palette.teal)
        }.frame(maxWidth: .infinity).accessibilityHidden(true)
    }
    private var controls: some View {
        VStack(spacing: 14) {
            if model.focused != nil {
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("Message Claude…", text: Binding(get: { draft.text }, set: { draft.edit($0) }), axis: .vertical).lineLimit(1...4)
                        .focused($composerFocused)
                        .font(.body).accessibilityIdentifier("messageComposer")
                    Button {
                        let submission = draft.submission; sendingText = true
                        Task {
                            if await model.sendText(submission.text) {
                                if draft.accept(submission) { composerFocused = false }
                                followingConversation = true
                            }
                            sendingText = false
                        }
                    } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)).foregroundStyle(Palette.teal) }
                        .disabled(sendingText || !model.online || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityLabel("Send message").accessibilityIdentifier("sendMessage")
                }.padding(14).background(.white, in: RoundedRectangle(cornerRadius: 18))
            }
            if composerFocused {
                Button("Hide keyboard", systemImage: "keyboard.chevron.compact.down") { composerFocused = false }
                    .font(.caption).frame(maxWidth: .infinity, alignment: .trailing).frame(minHeight: 44)
                    .accessibilityIdentifier("hideKeyboard")
            }
            if model.inCall {
                if model.playingReply {
                    Button("Pause reply", systemImage: "pause.fill") { model.interruptReply() }
                        .frame(maxWidth: .infinity).frame(minHeight: 44)
                        .accessibilityIdentifier("interruptReply")
                }
                HStack(spacing: 14) {
                    Button { Task { await model.toggleMute() } } label: { Label(model.muted ? "Unmute" : "Mute", systemImage: model.muted ? "mic.slash" : "mic").frame(maxWidth: .infinity).frame(height: 58) }.background(.white, in: Capsule()).disabled(model.phase != .listening)
                    Button { Task { await model.end() } } label: { Label("End", systemImage: "phone.down.fill").frame(maxWidth: .infinity).frame(height: 58) }.foregroundStyle(.white).background(Palette.ink, in: Capsule()).disabled(model.phase == .ending)
                }
            } else {
                Button { composerFocused = false; model.credential == nil ? (model.sheet = .settings) : model.talk() } label: {
                    Label(model.credential == nil ? "Connect your Mac" : "Talk", systemImage: model.credential == nil ? "laptopcomputer" : "waveform").font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity).frame(height: 60)
                }.foregroundStyle(.white).background(Palette.teal, in: Capsule()).accessibilityIdentifier("talkButton")
            }
            Text(model.inCall ? "Speak anytime to interrupt. Work continues after the call." : "Think aloud. Ask naturally. Keep moving.")
                .font(.system(size: 11)).foregroundStyle(Palette.quiet).multilineTextAlignment(.center)
        }.padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 12).background(Palette.background)
    }
}
struct TaskCard: View {
    let task: WorkTask
    let threadName: String
    let cancel: () -> Void
    let answer: (String) async -> Bool
    let check: () async -> Void
    var hear: () -> Void = {}
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var draft = ""
    @State private var sending = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) {
                    Text(threadName).font(.caption.weight(.semibold))
                    Text(task.statusLabel).font(.caption).foregroundStyle(Palette.quiet)
                }
            } else {
                HStack { Text(threadName).font(.caption.weight(.semibold)); Spacer(); Text(task.statusLabel).font(.caption).foregroundStyle(Palette.quiet) }
            }
            Text(task.result.isEmpty ? task.text : task.result).font(.callout).textSelection(.enabled)
            if let reason = task.waitingReason { Text(reason).font(.caption).foregroundStyle(Palette.quiet) }
            if task.hasReply { Button("Hear reply", systemImage: "speaker.wave.2", action: hear).frame(minHeight: 44) }
            if task.status == "question", task.questionID != nil {
                Text("Answer naturally in your call, or type here.")
                    .font(.caption).foregroundStyle(Palette.quiet)
                TextField("Your answer", text: $draft, axis: .vertical)
                    .lineLimit(1...5).textFieldStyle(.roundedBorder)
                    .disabled(sending).accessibilityIdentifier("questionAnswer")
                Button(sending ? "Sending…" : "Send answer") {
                    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    sending = true
                    Task {
                        if await answer(text) { draft = "" }
                        sending = false
                    }
                }.frame(minHeight: 44)
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("sendAnswer")
            }
            if task.status == "unknown" {
                Button(sending ? "Checking…" : "Check with Claude") {
                    sending = true
                    Task { await check(); sending = false }
                }.frame(minHeight: 44).disabled(sending).accessibilityIdentifier("checkRequest")
            }
            if task.status == "queued" { Button("Cancel waiting request", action: cancel).font(.caption).frame(minHeight: 44) }
        }.padding(18).background(.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 18))
            .onChange(of: task.questionID) { _, _ in draft = "" }
    }
}

struct PermissionCard: View {
    let permission: ToolPermission
    let decide: (Bool) async -> Void
    @State private var sending = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Claude needs permission", systemImage: "hand.raised").font(.headline)
            Text(permission.tool).font(.subheadline.weight(.semibold))
            Text(permission.input).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            Text("Allow applies only to this exact action. No standing permission is saved.").font(.caption).foregroundStyle(Palette.quiet)
            HStack {
                Button("Deny") { respond(false) }.frame(minHeight: 44)
                Spacer()
                Button(sending ? "Sending…" : "Allow once") { respond(true) }.buttonStyle(.borderedProminent).frame(minHeight: 44)
            }.disabled(sending)
        }.padding(18).background(.white, in: RoundedRectangle(cornerRadius: 18))
    }
    private func respond(_ allow: Bool) { sending = true; Task { await decide(allow); sending = false } }
}
