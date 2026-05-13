import AVFoundation
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

guard CommandLine.arguments.count == 7 else {
  fail("Usage: compose-av <source> <tail-or-none> <output.mp4> <segmentsJson> <tailAudioStartSeconds> <tailAudioEndSeconds>")
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let tailArgument = CommandLine.arguments[2]
let outputURL = URL(fileURLWithPath: CommandLine.arguments[3])

let segmentsJson = CommandLine.arguments[4]

guard let tailAudioStart = Double(CommandLine.arguments[5]),
      let tailAudioEnd = Double(CommandLine.arguments[6]),
      tailAudioStart >= 0 else {
  fail("Invalid tail audio range")
}

try? FileManager.default.removeItem(at: outputURL)

let composition = AVMutableComposition()
var videoTrack: AVMutableCompositionTrack?
var audioTrack: AVMutableCompositionTrack?
var cursor = CMTime.zero
var didSetTransform = false
let requestedTailAudioStart = CMTime(seconds: tailAudioStart, preferredTimescale: 600)
let requestedTailAudioEnd = CMTime(seconds: tailAudioEnd, preferredTimescale: 600)

struct Segment {
  let start: Double
  let end: Double

  var duration: Double {
    return end - start
  }
}

func parseSegments(_ json: String) -> [Segment] {
  guard let data = json.data(using: .utf8),
        let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
    fail("Invalid segments JSON")
  }

  let segments = raw.compactMap { item -> Segment? in
    guard let start = item["start"] as? Double,
          let end = item["end"] as? Double,
          start >= 0,
          end > start else {
      return nil
    }

    return Segment(start: start, end: end)
  }

  guard segments.count == raw.count, !segments.isEmpty else {
    fail("Invalid segment range")
  }

  return segments
}

func minTime(_ first: CMTime, _ second: CMTime) -> CMTime {
  return CMTimeCompare(first, second) <= 0 ? first : second
}

func positiveDuration(_ duration: CMTime) -> Bool {
  return CMTIME_IS_VALID(duration) && CMTimeCompare(duration, .zero) > 0
}

func appendVideoAsset(_ url: URL, range: CMTimeRange? = nil, outputDuration: CMTime? = nil) throws -> CMTime {
  let asset = AVURLAsset(url: url)
  let timeRange = range ?? CMTimeRange(start: .zero, duration: asset.duration)
  let insertedAt = cursor
  let targetDuration = outputDuration ?? timeRange.duration

  if let sourceVideo = asset.tracks(withMediaType: .video).first {
    if videoTrack == nil {
      videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    }
    try videoTrack?.insertTimeRange(timeRange, of: sourceVideo, at: cursor)
    if !didSetTransform {
      videoTrack?.preferredTransform = sourceVideo.preferredTransform
      didSetTransform = true
    }

    if CMTimeCompare(targetDuration, timeRange.duration) != 0 {
      videoTrack?.scaleTimeRange(
        CMTimeRange(start: insertedAt, duration: timeRange.duration),
        toDuration: targetDuration
      )
    }
  }

  cursor = CMTimeAdd(cursor, targetDuration)
  return targetDuration
}

do {
  let sourceAsset = AVURLAsset(url: sourceURL)
  let sourceDuration = sourceAsset.duration
  let sourceAudio = sourceAsset.tracks(withMediaType: .audio).first
  let segments = parseSegments(segmentsJson)

  for segment in segments {
    let clipStart = CMTime(seconds: segment.start, preferredTimescale: 600)
    let clipDuration = CMTime(seconds: segment.duration, preferredTimescale: 600)
    let insertAt = cursor
    let sourceVideoDuration = try appendVideoAsset(
      sourceURL,
      range: CMTimeRange(
        start: clipStart,
        duration: clipDuration
      )
    )

    if let sourceAudio {
      let availableClipAudioDuration = minTime(sourceVideoDuration, CMTimeSubtract(sourceDuration, clipStart))
      if positiveDuration(availableClipAudioDuration) {
        if audioTrack == nil {
          audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        }
        try audioTrack?.insertTimeRange(
          CMTimeRange(start: clipStart, duration: availableClipAudioDuration),
          of: sourceAudio,
          at: insertAt
        )
      }
    }
  }

  if tailArgument != "none" {
    guard tailAudioEnd > tailAudioStart else {
      fail("Invalid tail audio range")
    }

    guard let sourceAudio else {
      fail("The source video does not contain an audio track for the tail")
    }

    let clampedAudioEnd = minTime(requestedTailAudioEnd, sourceDuration)
    let selectedAudioDuration = CMTimeSubtract(clampedAudioEnd, requestedTailAudioStart)
    guard positiveDuration(selectedAudioDuration) else {
      fail("The selected tail audio range is outside the source video duration")
    }

    let tailAsset = AVURLAsset(url: URL(fileURLWithPath: tailArgument))
    let tailDuration = tailAsset.duration
    guard positiveDuration(tailDuration) else {
      fail("The selected tail video has no duration")
    }

    let tailOutputDuration: CMTime
    let tailAudioRange: CMTimeRange

    if CMTimeCompare(selectedAudioDuration, tailDuration) > 0 {
      tailOutputDuration = tailDuration
      let audioStart = CMTimeSubtract(clampedAudioEnd, tailDuration)
      tailAudioRange = CMTimeRange(start: audioStart, duration: tailDuration)
    } else {
      tailOutputDuration = selectedAudioDuration
      tailAudioRange = CMTimeRange(start: requestedTailAudioStart, duration: selectedAudioDuration)
    }

    let tailStartsAt = cursor
    _ = try appendVideoAsset(
      URL(fileURLWithPath: tailArgument),
      outputDuration: tailOutputDuration
    )

    if audioTrack == nil {
      audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
    }
    try audioTrack?.insertTimeRange(
        tailAudioRange,
        of: sourceAudio,
        at: tailStartsAt
    )
  }
} catch {
  fail(error.localizedDescription)
}

guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
  fail("Cannot create AVAssetExportSession")
}

guard export.supportedFileTypes.contains(.mp4) else {
  fail("This composition cannot be exported as MP4")
}

export.outputURL = outputURL
export.outputFileType = .mp4
export.shouldOptimizeForNetworkUse = true

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
  fail(export.error?.localizedDescription ?? "AVFoundation composition export failed")
default:
  fail("AVFoundation composition export ended with status \(export.status.rawValue)")
}
