// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// One Safari content blocker (the same code runs as Blocker1, Blocker2, ...).
// Safari asks for the rules when the blocker is turned on or reloaded; they are
// the file the web extension wrote to the app group (ContentBlockerStore).
import Foundation

final class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let provider: NSItemProvider
        if let index = Self.index, let url = ContentBlockerStore.rulesFile(index),
           FileManager.default.fileExists(atPath: url.path), let p = NSItemProvider(contentsOf: url) {
            provider = p
        } else {
            provider = NSItemProvider(item: ContentBlockerStore.emptyRules as NSData, typeIdentifier: "public.json")
        }
        if let index = Self.index { ContentBlockerStore.markServed(index) }
        let item = NSExtensionItem()
        item.attachments = [provider]
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }

    /// 0-based index from the bundle id (…Blocker1 → 0).
    static var index: Int? {
        guard let id = Bundle.main.bundleIdentifier, let r = id.range(of: #"Blocker(\d+)$"#, options: .regularExpression),
              let n = Int(id[r].dropFirst("Blocker".count)), n >= 1, n <= ContentBlockerStore.count else { return nil }
        return n - 1
    }
}
