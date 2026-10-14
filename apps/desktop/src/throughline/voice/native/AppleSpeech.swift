import Foundation
import Speech

// Private native qualification only. No recorder is constructed, no speech is
// captured, no asset installation is requested, and no credential is read.
// The TypeScript main-process owner will own the recording protocol separately.
@main
enum AppleSpeechNative {
  static func emit(available: Bool, assets: String, locale: String?) {
    let value: [String: Any] = [
      "schema": "throughline.desktop-voice-qualification.v1",
      "engine": "apple-speech-analyzer",
      "available": available,
      "assets": assets,
      "locale": locale.map { $0 as Any } ?? NSNull(),
      "captureStarted": false,
      "assetInstallRequested": false,
      "credentialRequired": false,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
      exit(70)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }

  static func main() async {
    if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "fixture-file" && CommandLine.arguments[2].hasPrefix("/") && CommandLine.arguments[3].hasPrefix("/") {
      if #available(macOS 26.0, *) {
        await AppleSpeechCapture.run(directory: CommandLine.arguments[2], fixtureAudio: URL(fileURLWithPath: CommandLine.arguments[3]))
      } else { exit(69) }
      return
    }
    if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "capture" && CommandLine.arguments[2].hasPrefix("/") {
      if #available(macOS 26.0, *) {
        await AppleSpeechCapture.run(directory: CommandLine.arguments[2])
      } else {
        guard let data = try? JSONSerialization.data(withJSONObject: ["event": "error", "code": "unsupported"]) else { exit(70) }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
      }
      return
    }
    guard CommandLine.arguments == [CommandLine.arguments[0], "qualify"] else { exit(64) }
    guard #available(macOS 26.0, *) else {
      emit(available: false, assets: "unsupported", locale: nil)
      return
    }
    guard SpeechTranscriber.isAvailable else {
      emit(available: false, assets: "not_checked", locale: nil)
      return
    }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
      emit(available: false, assets: "unsupported", locale: nil)
      return
    }
    let preset = SpeechTranscriber.Preset.timeIndexedTranscriptionWithAlternatives
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: preset.transcriptionOptions,
      reportingOptions: preset.reportingOptions.subtracting([.alternativeTranscriptions]),
      attributeOptions: preset.attributeOptions
    )
    let status = await AssetInventory.status(forModules: [transcriber])
    switch status {
    case .installed: emit(available: true, assets: "installed", locale: locale.identifier)
    case .supported: emit(available: true, assets: "supported", locale: locale.identifier)
    case .downloading: emit(available: true, assets: "downloading", locale: locale.identifier)
    case .unsupported: emit(available: false, assets: "unsupported", locale: locale.identifier)
    @unknown default: emit(available: false, assets: "unknown", locale: locale.identifier)
    }
  }
}
