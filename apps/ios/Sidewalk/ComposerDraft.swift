import Foundation

/// A late send receipt can clear only the exact draft that was submitted.
struct ComposerDraft {
    struct Submission { let text: String; let revision: UUID }
    private(set) var text = ""
    private var revision = UUID()
    var submission: Submission { Submission(text: text, revision: revision) }
    mutating func edit(_ value: String) {
        guard value != text else { return }
        text = value; revision = UUID()
    }
    mutating func reset() { text = ""; revision = UUID() }
    @discardableResult mutating func accept(_ submission: Submission) -> Bool {
        guard revision == submission.revision else { return false }
        reset()
        return true
    }
}
