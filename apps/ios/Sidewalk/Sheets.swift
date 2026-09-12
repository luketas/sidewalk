import SwiftUI
struct ThreadsSheet: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                if model.state.threads.isEmpty {
                    ContentUnavailableView("A fresh conversation", systemImage: "bubble.left.and.bubble.right", description: Text("Connect your Mac, then start a thread here or ask naturally while talking."))
                }
                ForEach(model.state.threads.reversed()) { thread in
                    Button { Task { await model.focus(thread); dismiss() } } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 5) { Text(thread.name).foregroundStyle(Palette.ink); Text(model.summary(for: thread)).font(.caption).foregroundStyle(Palette.quiet) }
                            Spacer()
                            if thread.id == model.state.focus.threadID { Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.teal) }
                        }.padding(.vertical, 6)
                    }
                }
                Section {
                    Button { Task { if await model.createThread() { dismiss() } } } label: {
                        HStack { Label("New thread", systemImage: "plus"); if model.busy { Spacer(); ProgressView() } }
                    }.disabled(model.busy || !model.online || model.state.projects.isEmpty).accessibilityIdentifier("newThread")
                } footer: { Text("Start talking. The name will update from Claude Code.") }
                if let error = model.error { Text(error).foregroundStyle(.red).font(.footnote) }
            }.scrollContentBackground(.hidden).background(Palette.background)
                .navigationTitle("Your threads").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.large])
    }
}
struct SettingsSheet: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var pairing = ""
    @State private var scanning = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Your Mac") {
                    if let credential = model.credential {
                        LabeledContent("Connection", value: model.online ? "Connected" : "Unavailable")
                        Text(credential.baseURL).font(.caption).foregroundStyle(.secondary)
                        Button { scanning = true } label: { Label("Update connection", systemImage: "qrcode.viewfinder") }
                            .disabled(model.busy || model.inCall)
                        Text("Scan a new Mac code to use an internet connection. Your threads stay on the Mac.").font(.footnote).foregroundStyle(.secondary)
                        Button("Forget this Mac", role: .destructive) { Task { await model.forget() } }
                    } else {
                        Text("Connect once. Your iPhone remembers this Mac.")
                        Text("Scan the code shown on your Mac, or paste it below.").font(.footnote).foregroundStyle(.secondary)
                        Button { scanning = true } label: { Label("Scan Mac code", systemImage: "qrcode.viewfinder") }
                        SecureField("Or paste the connection code", text: $pairing).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("pairingPayload")
                        Button("Connect") { Task { await model.pair(pairing); pairing = "" } }.disabled(pairing.isEmpty || model.busy).accessibilityIdentifier("pairMac")
                    }
                }
                Section("Before you talk") {
                    Text("Microphone audio and selected conversation context go to OpenAI. Your messages go to Claude on your Mac. Claude’s replies are sent to OpenAI and read aloud using an AI-generated voice. Your OpenAI key stays on the Mac; this phone stores only its connection credential.")
                    Text("Internet mode works over cellular and other Wi-Fi networks while your Mac is awake and connected. Its connection provider, Cloudflare, carries the encrypted HTTPS requests between your phone and Mac.").font(.footnote).foregroundStyle(.secondary)
                    Text("No raw audio is recorded by this app. Provider retention is separate. Your Mac saves the conversation and full Claude answers. This phone caches chat history for later reading.").font(.footnote).foregroundStyle(.secondary)
                    Toggle("I understand this data flow", isOn: Binding(get: { model.disclosureAccepted }, set: { value in if value { model.acceptDisclosure() } else { model.disclosureAccepted = false; UserDefaults.standard.set(false, forKey: "dataDisclosureV1") } }))
                }
                Section("Development build") {
                    LabeledContent("Voice key", value: model.state.readiness.voiceKey ? "Available on Mac" : "Set up on Mac")
                    Toggle("Quiet waiting sounds", isOn: $model.waitingSounds).onChange(of: model.waitingSounds) { _, value in UserDefaults.standard.set(value, forKey: "waitingSounds") }
                    Text("Sidewalk manages the voice conversation and conveys Claude’s answers. Speak anytime to interrupt. Permission requests appear here for one-time approval. Active-work stopping remains on your Mac.").font(.footnote).foregroundStyle(.secondary)
                }
                if let error = model.error { Text(error).foregroundStyle(.red).font(.footnote) }
            }.sheet(isPresented: $scanning) {
                NavigationStack {
                    QRScanner(onCode: { code in scanning = false; Task { await model.pair(code) } }, onError: { message in model.error = message; scanning = false })
                        .navigationTitle("Scan your Mac code").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
                }
            }.navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
