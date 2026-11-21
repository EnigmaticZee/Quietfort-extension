// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Host app for the Safari web extension (dist/safari) and its content blockers
// (Blocker1...3, which carry the filter-list rules). Its only job: show which
// of them are on and open Safari's extension settings. It reads nothing from
// them and sends nothing anywhere.
import SafariServices
import SwiftUI

let extensionBundleIdentifier = "app.adblocker.companion.Extension"
let contentBlockerIdentifiers = (1...3).map { "app.adblocker.companion.Blocker\($0)" }

@main
struct CompanionApp: App {
    var body: some Scene {
        Window(appName, id: "main") {
            ContentView()
        }
        .windowResizability(.contentSize)
    }
}

/// The app's display name (Info.plist), so the text follows a rename.
let appName: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
    ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Companion"

struct ContentView: View {
    /// nil: unknown (Safari didn't answer).
    @State private var extensionOn: Bool?
    @State private var blockersOn: [Bool?] = Array(repeating: nil, count: contentBlockerIdentifiers.count)
    @State private var openError: String?

    private var allOn: Bool { extensionOn == true && blockersOn.allSatisfy { $0 == true } }

    var body: some View {
        VStack(spacing: 16) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 96, height: 96)
            Text(appName).font(.title2.weight(.semibold))
            Text(allOn ? "Everything is on. Ads and trackers are blocked in Safari."
                       : "Turn on all four items in Safari’s extension settings. The extension handles pages; the three rule sets carry the full filter lists.")
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 6) {
                row("\(appName) Extension", extensionOn)
                ForEach(contentBlockerIdentifiers.indices, id: \.self) { i in
                    row("Quietfort Rules \(i + 1)", blockersOn[i])
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !allOn {
                VStack(alignment: .leading, spacing: 6) {
                    Text("1. Open Safari Settings → Extensions.")
                    Text("2. Tick every item marked “Off” above.")
                    Text("3. Allow the extension on all websites when Safari asks.")
                }
                .font(.callout).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button("Open Safari Extension Settings…", action: openSettings)
                .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            if let openError { Text(openError).font(.callout).foregroundStyle(.red) }
        }
        .padding(28)
        .frame(width: 440)
        .task { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refresh() }
        }
    }

    private func row(_ name: String, _ on: Bool?) -> some View {
        HStack {
            Image(systemName: on == true ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(on == true ? Color.green : Color.secondary)
            Text(name)
            Spacer()
            Text(on == true ? "On" : on == false ? "Off" : "Unknown").foregroundStyle(.secondary)
        }
    }

    private func refresh() async {
        extensionOn = await withCheckedContinuation { cont in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { @Sendable st, err in
                cont.resume(returning: err == nil ? st?.isEnabled : nil)
            }
        }
        var states: [Bool?] = []
        for id in contentBlockerIdentifiers {
            states.append(await withCheckedContinuation { cont in
                SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: id) { @Sendable st, err in
                    cont.resume(returning: err == nil ? st?.isEnabled : nil)
                }
            })
        }
        blockersOn = states
    }

    private func openSettings() {
        openError = nil
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { @Sendable err in
            guard err != nil else { return }
            Task { @MainActor in openError = "Couldn’t open Safari. Open Safari → Settings → Extensions yourself." }
        }
    }
}
