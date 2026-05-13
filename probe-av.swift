import AVFoundation
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

guard CommandLine.arguments.count == 2 else {
  fail("Usage: probe-av <input-video>")
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: inputURL)

guard let videoTrack = asset.tracks(withMediaType: .video).first else {
  fail("No video track found")
}

let duration = CMTimeGetSeconds(asset.duration)
var fps = Double(videoTrack.nominalFrameRate)

if fps <= 0 {
  let frameDuration = videoTrack.minFrameDuration
  if frameDuration.isValid && frameDuration.value > 0 {
    fps = Double(frameDuration.timescale) / Double(frameDuration.value)
  }
}

guard fps > 0, duration.isFinite, duration > 0 else {
  fail("Cannot determine video frame rate")
}

let payload = """
{"fps":\(fps),"duration":\(duration)}
"""

print(payload)
