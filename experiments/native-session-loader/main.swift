import Foundation

let path = CommandLine.arguments[1]
let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
defer { try? file.close() }
var entries: [Any] = []
var textBytes = 0
var pending = Data()

func retain(_ data: Data) {
    guard let line = String(data: data, encoding: .utf8), !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    guard let entry = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return }
    if let object = entry as? [String: Any],
       let message = object["message"] as? [String: Any],
       let content = message["content"] as? [[String: Any]],
       let text = content.first?["text"] as? String {
        textBytes += text.utf8.count
    }
    entries.append(entry)
}

while let chunk = try file.read(upToCount: 32_768), !chunk.isEmpty {
    pending.append(chunk)
    while let newline = pending.firstIndex(of: 10) {
        retain(Data(pending[..<newline]))
        pending.removeSubrange(pending.startIndex...newline)
    }
}
retain(pending)
if let header = entries.first as? [String: Any],
   header["type"] as? String == "session",
   header["id"] is String {
} else {
    entries.removeAll()
    textBytes = 0
}
FileHandle.standardOutput.write(Data("READY \(entries.count) \(textBytes)\n".utf8))
Thread.sleep(forTimeInterval: 2)
withExtendedLifetime(entries) {}
