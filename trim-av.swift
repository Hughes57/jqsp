import AVFoundation
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

guard CommandLine.arguments.count == 5 else {
  fail("Usage: trim-av <input> <output.mp4> <startSeconds> <durationSeconds>")
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard let start = Double(CommandLine.arguments[3]),
      let duration = Double(CommandLine.arguments[4]),
      start >= 0,
      duration > 0 else {
  fail("Invalid start or duration")
}

try? FileManager.default.removeItem(at: outputURL)

let asset = AVURLAsset(url: inputURL)
guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
  fail("Cannot create AVAssetExportSession")
}

guard export.supportedFileTypes.contains(.mp4) else {
  fail("This video cannot be exported as MP4 by AVFoundation")
}

export.outputURL = outputURL
export.outputFileType = .mp4
export.shouldOptimizeForNetworkUse = true
export.timeRange = CMTimeRange(
  start: CMTime(seconds: start, preferredTimescale: 600),
  duration: CMTime(seconds: duration, preferredTimescale: 600)
)

var exportFinished = false
export.exportAsynchronously {
  exportFinished = true
}

while !exportFinished {
  RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
}

switch export.status {
case .completed:
  exit(0)
case .failed, .cancelled:
  fail(export.error?.localizedDescription ?? "AVFoundation export failed")
default:
  fail("AVFoundation export ended with status \(export.status.rawValue)")
}
