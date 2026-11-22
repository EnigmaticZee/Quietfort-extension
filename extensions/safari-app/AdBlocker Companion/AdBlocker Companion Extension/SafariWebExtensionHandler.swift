// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Native side of the Safari web extension. Its only job is the content
// blockers: the extension compiles the filter lists into WebKit content-rule
// JSON and sends it here in compressed parts (background/safari-cb.ts); this
// writes it to the app group container and reloads each content blocker.
// Messages other than `cb:*` are answered empty. Nothing is logged beyond rule
// counts and errors, and nothing is sent anywhere.
import SafariServices
import WebKit
import os

private let log = Logger(subsystem: "io.github.enigmaticzee.quietfort", category: "content-blockers")

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let msg = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        log.notice("request \(msg["type"] as? String ?? "?", privacy: .public)")
        DispatchQueue.global(qos: .userInitiated).async {
            let reply = ContentBlockerUpdater.handle(msg)
            let out = NSExtensionItem()
            out.userInfo = [SFExtensionMessageKey: reply]
            context.completeRequest(returningItems: [out], completionHandler: nil)
            log.notice("replied \(msg["type"] as? String ?? "?", privacy: .public)")
        }
    }
}

enum ContentBlockerUpdater {
    private static let lock = NSLock()

    static func handle(_ msg: [String: Any]) -> [String: Any] {
        // Status only reads: it never waits behind an update in progress.
        let isStatus = msg["type"] as? String == "cb:status"
        if !isStatus { lock.lock() }
        defer { if !isStatus { lock.unlock() } }
        guard let dir = ContentBlockerStore.directory else { return ["ok": false, "error": "app group unavailable", "blockers": []] }
        let started = Date()
        defer { log.notice("\(msg["type"] as? String ?? "?", privacy: .public) handled in \(Int(Date().timeIntervalSince(started) * 1000)) ms") }
        switch msg["type"] as? String {
        case "cb:status":
            return status()
        case "cb:begin":
            guard let gen = generation(msg) else { return ["ok": false, "error": "bad generation"] }
            // Drop staging left over from earlier (interrupted) updates.
            for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            where f.lastPathComponent.hasPrefix("staging-") {
                try? FileManager.default.removeItem(at: f)
            }
            let ok = (try? FileManager.default.createDirectory(at: staging(dir, gen), withIntermediateDirectories: true)) != nil
            return ["ok": ok]
        case "cb:part":
            guard let gen = generation(msg), let index = msg["index"] as? Int, (0..<ContentBlockerStore.count).contains(index),
                  let seq = msg["seq"] as? Int, (0..<10_000).contains(seq), let data = msg["data"] as? String else {
                return ["ok": false, "error": "bad part"]
            }
            let f = staging(dir, gen).appendingPathComponent(String(format: "%d-%05d.b64", index, seq))
            return ["ok": (try? Data(data.utf8).write(to: f)) != nil]
        case "cb:commit":
            guard let gen = generation(msg), let hash = msg["hash"] as? String else { return ["ok": false, "error": "bad commit"] }
            return commit(dir: dir, gen: gen, hash: hash, sites: msg["sites"] as? String, sitesHash: msg["sitesHash"] as? String)
        case "cb:sites":
            guard let rules = msg["rules"] as? String, let hash = msg["hash"] as? String else { return ["ok": false, "error": "bad sites"] }
            return sites(rules: rules, hash: hash)
        default:
            return [:]
        }
    }

    private static func generation(_ msg: [String: Any]) -> String? {
        guard let g = msg["gen"] as? String, !g.isEmpty, g.count <= 40,
              g.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        return g
    }

    private static func staging(_ dir: URL, _ gen: String) -> URL { dir.appendingPathComponent("staging-\(gen)", isDirectory: true) }

    /// A JSON array of rules (the per-site switches): at most 5,000 entries.
    private static func ruleArray(_ text: String) -> Data? {
        let d = Data(text.utf8)
        guard d.count <= 4_000_000, let a = (try? JSONSerialization.jsonObject(with: d)) as? [Any], a.count <= 5000,
              a.allSatisfy({ $0 is [String: Any] }) else { return nil }
        return d
    }

    // MARK: commit (filter lists changed)

    private static func commit(dir: URL, gen: String, hash: String, sites: String?, sitesHash: String?) -> [String: Any] {
        let stage = staging(dir, gen)
        defer { try? FileManager.default.removeItem(at: stage) }
        let previous = savedState()
        var newSitesHash = previous["sitesHash"] as? String
        if let sites, let sitesHash {
            guard let data = ruleArray(sites), let f = ContentBlockerStore.sitesFile, (try? data.write(to: f, options: .atomic)) != nil else {
                return ["ok": false, "error": "bad sites"]
            }
            newSitesHash = sitesHash
        }
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: stage.path)) ?? []).sorted()
        var state: [[String: Any]] = []
        var valid: [Int] = []
        for i in 0..<ContentBlockerStore.count {
            var entry: [String: Any] = ["id": ContentBlockerStore.identifier(i)]
            defer { state.append(entry) }
            let parts = files.filter { $0.hasPrefix("\(i)-") }
            var b64 = ""
            for p in parts { b64 += (try? String(contentsOf: stage.appendingPathComponent(p), encoding: .utf8)) ?? "" }
            guard let packed = Data(base64Encoded: b64),
                  let json = try? (packed as NSData).decompressed(using: .zlib) as Data,
                  let rules = (try? JSONSerialization.jsonObject(with: json)) as? [Any], !rules.isEmpty,
                  let url = ContentBlockerStore.baseFile(i), (try? json.write(to: url, options: .atomic)) != nil else {
                entry["error"] = "rules missing or unreadable"
                entry["rules"] = 0
                continue
            }
            entry["rules"] = rules.count
            valid.append(i)
        }
        applyServed(valid, state: &state, previous: previous["blockers"] as? [[String: Any]] ?? [])
        save(hash: hash, sitesHash: newSitesHash, blockers: state)
        return status()
    }

    // MARK: sites (per-site switch changed)

    /// Only the per-site switches changed: re-splice them onto each content blocker's
    /// filter-list rules and reload. Safari recompiles, but nothing is rebuilt or resent.
    private static func sites(rules: String, hash: String) -> [String: Any] {
        guard let data = ruleArray(rules) else { return ["ok": false, "error": "bad sites"] }
        let missing = (0..<ContentBlockerStore.count).contains { i in
            guard let f = ContentBlockerStore.baseFile(i) else { return true }
            return !FileManager.default.fileExists(atPath: f.path)
        }
        if missing { return ["ok": false, "needsFull": true] }
        guard let f = ContentBlockerStore.sitesFile, (try? data.write(to: f, options: .atomic)) != nil else {
            return ["ok": false, "error": "could not write sites"]
        }
        let previous = savedState()
        let before = previous["blockers"] as? [[String: Any]] ?? []
        var state: [[String: Any]] = (0..<ContentBlockerStore.count).map { i in
            var e = before.first { $0["id"] as? String == ContentBlockerStore.identifier(i) } ?? ["id": ContentBlockerStore.identifier(i)]
            e["pending"] = nil
            return e
        }
        applyServed(Array(0..<ContentBlockerStore.count), state: &state, previous: before)
        save(hash: previous["hash"] as? String ?? "", sitesHash: hash, blockers: state)
        return status()
    }

    // MARK: write + reload

    /// For each blocker in `indices`: served rules = base + sites; write if changed, reload if on.
    private static func applyServed(_ indices: [Int], state: inout [[String: Any]], previous: [[String: Any]]) {
        let sitesData = ContentBlockerStore.sitesFile.flatMap { try? Data(contentsOf: $0) }
        let siteCount = sitesData.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [Any] }?.count ?? 0
        var toReload: [Int] = []
        var servedByBlocker: [Int: Data] = [:]
        for i in indices {
            guard let baseURL = ContentBlockerStore.baseFile(i), let base = try? Data(contentsOf: baseURL),
                  let url = ContentBlockerStore.rulesFile(i) else {
                state[i]["error"] = "rules missing or unreadable"
                continue
            }
            let served = ContentBlockerStore.served(base: base, sites: sitesData)
            let baseCount = (state[i]["rules"] as? Int).map { $0 - ((state[i]["sites"] as? Int) ?? 0) } ?? 0
            state[i]["sites"] = siteCount
            if baseCount > 0 { state[i]["rules"] = baseCount + siteCount }
            // Unchanged and loaded fine last time: no reload (Safari recompiles the whole list).
            let before = previous.first { $0["id"] as? String == ContentBlockerStore.identifier(i) }
            if (try? Data(contentsOf: url)) == served, let before, before["error"] == nil, before["pending"] == nil {
                if let removed = before["removed"] { state[i]["removed"] = removed }
                state[i]["error"] = nil
                continue
            }
            guard (try? served.write(to: url, options: .atomic)) != nil else {
                state[i]["error"] = "could not write rules"
                continue
            }
            state[i]["error"] = nil
            // Safari never answers a reload of a content blocker that is off; it
            // reads the file itself when the user turns the blocker on.
            if enabled(ContentBlockerStore.identifier(i)) != true {
                state[i]["pending"] = true
                continue
            }
            toReload.append(i)
            servedByBlocker[i] = served
        }
        // Safari compiles each content blocker separately: reload them in parallel.
        var errors: [Int: String] = [:]
        let errLock = NSLock()
        DispatchQueue.concurrentPerform(iterations: toReload.count) { k in
            let i = toReload[k]
            let t = Date()
            let e = reload(ContentBlockerStore.identifier(i))
            log.notice("reload blocker \(i + 1): \(e ?? "ok", privacy: .public) in \(Int(Date().timeIntervalSince(t) * 1000)) ms")
            errLock.lock(); errors[i] = e; errLock.unlock()
        }
        for i in toReload {
            guard var err = errors[i] else { continue }
            // One rule WebKit can't compile fails the whole content blocker: if
            // that is why it failed, leave out only the rejected rules and retry.
            if let json = servedByBlocker[i], !compiles(json), var rules = (try? JSONSerialization.jsonObject(with: json)) as? [Any],
               let url = ContentBlockerStore.rulesFile(i), let baseURL = ContentBlockerStore.baseFile(i) {
                let bad = findInvalid(rules)
                if !bad.isEmpty && bad.count <= 200 {
                    let drop = Set(bad)
                    let baseCount = rules.count - siteCount
                    rules = rules.enumerated().filter { !drop.contains($0.offset) }.map(\.element)
                    let data = (try? JSONSerialization.data(withJSONObject: rules)) ?? ContentBlockerStore.emptyRules
                    try? data.write(to: url, options: .atomic)
                    // Keep the filter-list part without them too, for the next per-site change.
                    let keptBase = rules.prefix(max(0, baseCount - drop.filter { $0 < baseCount }.count))
                    if let b = try? JSONSerialization.data(withJSONObject: Array(keptBase)) { try? b.write(to: baseURL, options: .atomic) }
                    state[i]["removed"] = bad.count
                    state[i]["rules"] = rules.count
                    log.error("blocker \(i + 1): left out \(bad.count) rules WebKit rejected")
                    if let again = reload(ContentBlockerStore.identifier(i)) { err = again } else { continue }
                }
            }
            state[i]["error"] = err
            log.error("blocker \(i + 1): reload failed: \(err, privacy: .public)")
        }
    }

    private static func save(hash: String, sitesHash: String?, blockers: [[String: Any]]) {
        var saved: [String: Any] = ["hash": hash, "blockers": blockers, "updatedAt": Date().timeIntervalSince1970]
        if let sitesHash { saved["sitesHash"] = sitesHash }
        if let f = ContentBlockerStore.stateFile, let d = try? JSONSerialization.data(withJSONObject: saved) {
            try? d.write(to: f, options: .atomic)
        }
    }

    private static func savedState() -> [String: Any] {
        guard let f = ContentBlockerStore.stateFile, let d = try? Data(contentsOf: f),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
        return o
    }

    private static func status() -> [String: Any] {
        let saved = savedState()
        let savedBlockers = saved["blockers"] as? [[String: Any]] ?? []
        let ids = (0..<ContentBlockerStore.count).map(ContentBlockerStore.identifier)
        // Ask Safari about all blockers at once, briefly: this must never hold up the popup.
        var states = [Bool?](repeating: nil, count: ids.count)
        let stLock = NSLock()
        DispatchQueue.concurrentPerform(iterations: ids.count) { i in
            let v = enabled(ids[i])
            stLock.lock(); states[i] = v; stLock.unlock()
        }
        var blockers: [[String: Any]] = []
        for (i, id) in ids.enumerated() {
            var b = savedBlockers.first { $0["id"] as? String == id } ?? ["id": id, "rules": 0]
            b["enabled"] = states[i] ?? NSNull()
            if let t = ContentBlockerStore.lastServed(i) { b["servedAt"] = t }
            blockers.append(b)
        }
        var out: [String: Any] = ["ok": true, "blockers": blockers]
        if let h = saved["hash"] { out["hash"] = h }
        if let h = saved["sitesHash"] { out["sitesHash"] = h }
        return out
    }

    // MARK: Safari

    private static func reload(_ id: String) -> String? {
        let sem = DispatchSemaphore(value: 0)
        var result: String?
        SFContentBlockerManager.reloadContentBlocker(withIdentifier: id) { err in
            if let err { result = (err as NSError).localizedDescription + " (\((err as NSError).domain) \((err as NSError).code))" }
            sem.signal()
        }
        if sem.wait(timeout: .now() + 90) == .timedOut { return "timed out" }
        return result
    }

    private static func enabled(_ id: String) -> Bool? {
        let sem = DispatchSemaphore(value: 0)
        var result: Bool?
        SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: id) { st, err in
            if err == nil { result = st?.isEnabled }
            sem.signal()
        }
        if sem.wait(timeout: .now() + 3) == .timedOut { log.notice("state of \(id, privacy: .public): no answer within 3 s") }
        return result
    }

    // MARK: WebKit validation

    private static func compiles(_ json: Data) -> Bool {
        guard let text = String(data: json, encoding: .utf8) else { return false }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("cbcheck-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        DispatchQueue.main.async {
            guard let store = WKContentRuleListStore(url: tmp) else { sem.signal(); return }
            store.compileContentRuleList(forIdentifier: "check", encodedContentRuleList: text) { list, err in
                ok = list != nil && err == nil
                sem.signal()
            }
        }
        if sem.wait(timeout: .now() + 300) == .timedOut { return true } // can't tell: let Safari decide
        return ok
    }

    /// Indices of the rules WebKit rejects (bisection; stops after 200).
    private static func findInvalid(_ rules: [Any]) -> [Int] {
        var bad: [Int] = []
        func check(_ range: Range<Int>) {
            if bad.count > 200 || range.isEmpty { return }
            guard let d = try? JSONSerialization.data(withJSONObject: Array(rules[range])) else { bad.append(contentsOf: range); return }
            if compiles(d) { return }
            if range.count == 1 { bad.append(range.lowerBound); return }
            let mid = range.lowerBound + range.count / 2
            check(range.lowerBound..<mid)
            check(mid..<range.upperBound)
        }
        check(0..<rules.count)
        return bad
    }
}
