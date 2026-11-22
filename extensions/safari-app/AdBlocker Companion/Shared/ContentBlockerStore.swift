// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Where the compiled content-blocker rules live: the app group container shared
// by the web extension (which writes them) and the content blockers (which hand
// them to Safari). Nothing here leaves the Mac.
import Foundation

enum ContentBlockerStore {
    static let count = 3
    static func identifier(_ index: Int) -> String { "io.github.enigmaticzee.quietfort.Blocker\(index + 1)" }

    /// The app group (Info.plist `ADBAppGroup`, set from the team prefix at build time).
    static var directory: URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "ADBAppGroup") as? String,
              let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        let d = base.appendingPathComponent("ContentBlockers", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// What content blocker `index` hands to Safari: its filter-list rules (`baseFile`) followed by the
    /// per-site switches (`sitesFile`), so turning a site off rewrites only the small tail.
    static func rulesFile(_ index: Int) -> URL? { directory?.appendingPathComponent("blocker-\(index + 1).json") }
    /// The filter-list rules of content blocker `index`, as the web extension compiled them.
    static func baseFile(_ index: Int) -> URL? { directory?.appendingPathComponent("base-\(index + 1).json") }
    /// Sites the user turned blocking off on: `ignore-previous-rules` rules appended to every content blocker.
    static var sitesFile: URL? { directory?.appendingPathComponent("sites.json") }
    static var stateFile: URL? { directory?.appendingPathComponent("state.json") }

    /// `base` (a JSON array) with the rules of `sites` (a JSON array, may be empty) appended.
    /// Plain byte splicing: neither list is parsed.
    static func served(base: Data, sites: Data?) -> Data {
        guard let sites, let open = sites.firstIndex(of: UInt8(ascii: "[")), let close = sites.lastIndex(of: UInt8(ascii: "]")),
              let baseClose = base.lastIndex(of: UInt8(ascii: "]")) else { return base }
        let inner = sites[sites.index(after: open)..<close]
        guard inner.contains(where: { ![0x20, 0x0a, 0x0d, 0x09].contains($0) }) else { return base }
        var out = Data(base[..<baseClose])
        out.append(UInt8(ascii: ","))
        out.append(inner)
        out.append(UInt8(ascii: "]"))
        return out
    }

    /// When Safari last asked content blocker `index` for its rules (it does when the blocker is on).
    static func lastServed(_ index: Int) -> Double? {
        guard let f = directory?.appendingPathComponent("served-\(index + 1)"),
              let d = try? Data(contentsOf: f), let s = String(data: d, encoding: .utf8) else { return nil }
        return Double(s)
    }

    static func markServed(_ index: Int) {
        guard let f = directory?.appendingPathComponent("served-\(index + 1)") else { return }
        try? Data(String(Date().timeIntervalSince1970).utf8).write(to: f, options: .atomic)
    }

    /// A rule list that never matches (a content blocker must return at least one rule).
    static let emptyRules = Data(#"[{"trigger":{"url-filter":"^adblocker-empty-list:"},"action":{"type":"block"}}]"#.utf8)
}
