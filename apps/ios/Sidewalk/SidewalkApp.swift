import SwiftUI
@main
struct SidewalkApp: App {
    @State private var model = AppModel()
    var body: some Scene { WindowGroup { ConversationView(model: model).tint(Palette.teal).preferredColorScheme(.light) } }
}
enum Palette {
    static let background = Color(red: 0.97, green: 0.96, blue: 0.93)
    static let ink = Color(red: 0.12, green: 0.18, blue: 0.19)
    static let teal = Color(red: 0.14, green: 0.40, blue: 0.39)
    static let quiet = Color(red: 0.42, green: 0.46, blue: 0.45)
}
