import Foundation
import AVFoundation
import Speech
import Darwin


struct NodeOwnedVoiceDirectoryExpectation {
  let device: UInt64
  let inode: UInt64
  let owner: UInt32
}

enum PrivateVoiceDirectoryPolicy {
  static func identity(_ attributes: [FileAttributeKey: Any]) -> NodeOwnedVoiceDirectoryExpectation? {
    guard let device = attributes[.systemNumber] as? NSNumber,
          let inode = attributes[.systemFileNumber] as? NSNumber,
          let owner = attributes[.ownerAccountID] as? NSNumber else { return nil }
    return NodeOwnedVoiceDirectoryExpectation(device: device.uint64Value, inode: inode.uint64Value, owner: owner.uint32Value)
  }

  // expected is the qualified Node-owned minted directory snapshot, NOT
  // metadata obtained from the resolved URL. Current private protocol does
  // not carry a Node creation-time descriptor; same-UID replacement races
  // before snapshot/between checks are not claimed proven away.
  static func accepts(_ directory: URL, expected: NodeOwnedVoiceDirectoryExpectation) -> Bool {
    let resolved = directory.resolvingSymlinksInPath()
    let spellingAllowed = directory.path == resolved.path || (
      directory.deletingLastPathComponent().path == "/private/tmp" &&
      resolved.deletingLastPathComponent().path == "/tmp" &&
      directory.lastPathComponent == resolved.lastPathComponent
    )
    guard spellingAllowed, directory.lastPathComponent.hasPrefix("throughline-voice-") else { return false }
    do {
      let given = try FileManager.default.attributesOfItem(atPath: directory.path)
      let target = try FileManager.default.attributesOfItem(atPath: resolved.path)
      guard (given[.type] as? FileAttributeType) == .typeDirectory,
            (target[.type] as? FileAttributeType) == .typeDirectory,
            (given[.posixPermissions] as? NSNumber)?.intValue == 0o700,
            (target[.posixPermissions] as? NSNumber)?.intValue == 0o700,
            expected.owner == geteuid(),
            let actual = identity(given), let resolvedIdentity = identity(target) else { return false }
      return actual.owner == expected.owner && resolvedIdentity.owner == expected.owner &&
        actual.device == expected.device && actual.inode == expected.inode &&
        resolvedIdentity.device == expected.device && resolvedIdentity.inode == expected.inode
    } catch { return false }
  }
}


// Native exception: Apple Speech/AVFoundation have no TypeScript binding.
// One private child owns one recording; TypeScript owns its lifetime and IPC.
// No shell, renderer-selected paths, cloud recognizer, credential, or logging.
@available(macOS 26.0, *)
@MainActor
final class AppleSpeechCapture {
  private var task: Task<Void, Never>?
  private var recorder: AVAudioRecorder?
  private var recordingGate: CheckedContinuation<Bool, Never>?
  private var finish: CheckedContinuation<Bool, Never>?
  private var cancelled = false

  static func emit(_ value: [String: String]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(70) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }

  private func cancel() {
    cancelled = true
    task?.cancel()
    recorder?.stop()
    recordingGate?.resume(returning: false)
    recordingGate = nil
    finish?.resume(returning: false)
    finish = nil
  }

  private func record() {
    guard let waiting = recordingGate else { cancel(); return }
    recordingGate = nil
    waiting.resume(returning: true)
  }

  private func stop() {
    guard let waiting = finish else { cancel(); return }
    recorder?.stop()
    finish = nil
    waiting.resume(returning: true)
  }

  private func checkCancellation() throws {
    if cancelled || Task.isCancelled { throw CancellationError() }
  }

  private func runCapture(directory: URL, fixtureAudio: URL?) async {
    let files = FileManager.default
    let audio = directory.appendingPathComponent("recording.caf")
    var failure = "preparation-failed"
    defer {
      recorder?.stop()
      recorder = nil
      // Parent owns the directory and repeats exact-file cleanup after exit,
      // including emergency termination where Swift defer cannot execute.
      try? files.removeItem(at: audio)
    }
    do {
      try checkCancellation()
      let attributes = try files.attributesOfItem(atPath: directory.path)
      // This path was minted/chmod/realpath by NativeVoiceSession, not supplied
      // by the renderer. Capture its expected identity before alias resolution.
      guard let expectedDirectory = PrivateVoiceDirectoryPolicy.identity(attributes),
            PrivateVoiceDirectoryPolicy.accepts(directory, expected: expectedDirectory) else {
        Self.emit(["event": "error", "code": "recording-failed"]); return
      }
      guard SpeechTranscriber.isAvailable,
            let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else {
        Self.emit(["event": "error", "code": "unsupported"]); return
      }
      let preset = SpeechTranscriber.Preset.timeIndexedTranscriptionWithAlternatives
      let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: preset.transcriptionOptions,
        reportingOptions: preset.reportingOptions.subtracting([.alternativeTranscriptions]),
        attributeOptions: preset.attributeOptions
      )
      // Same public on-device preparation path as NativeAppleTranscription.
      let assets = await AssetInventory.status(forModules: [transcriber])
      switch assets {
      case .installed: break
      case .supported, .downloading:
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
          try await request.downloadAndInstall()
        }
      case .unsupported:
        Self.emit(["event": "error", "code": "unsupported"]); return
      @unknown default:
        Self.emit(["event": "error", "code": "unsupported"]); return
      }
      try checkCancellation()
      if fixtureAudio == nil {
        let authorized = await AVCaptureDevice.requestAccess(for: .audio)
        try checkCancellation()
        guard authorized else { Self.emit(["event": "error", "code": "permission-denied"]); return }
      }
      // No audio file or recorder until the renderer has captured its draft.
      let shouldRecord = await withCheckedContinuation { continuation in
        recordingGate = continuation
        Self.emit(["event": "ready", "locale": locale.identifier])
      }
      guard shouldRecord else { throw CancellationError() }
      try checkCancellation()
      failure = "recording-failed"
      if let fixtureAudio {
        guard fixtureAudio.lastPathComponent == "input.caf",
              fixtureAudio.deletingLastPathComponent().lastPathComponent.hasPrefix("throughline-voice-input-"),
              fixtureAudio.resolvingSymlinksInPath().path == fixtureAudio.path else {
          Self.emit(["event": "error", "code": failure]); return
        }
        try files.copyItem(at: fixtureAudio, to: audio)
      } else {
        let recording = try AVAudioRecorder(url: audio, settings: [
          AVFormatIDKey: kAudioFormatLinearPCM,
          AVSampleRateKey: 44100.0,
          AVNumberOfChannelsKey: 1,
          AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false,
          AVLinearPCMIsBigEndianKey: false,
        ])
        recorder = recording
        guard recording.record(forDuration: 300) else { Self.emit(["event": "error", "code": failure]); return }
      }
      let transcribe = await withCheckedContinuation { continuation in
        finish = continuation
        Self.emit(["event": "recording"])
      }
      guard transcribe else { throw CancellationError() }
      try checkCancellation()
      failure = "transcription-failed"
      let audioFile = try AVAudioFile(forReading: audio)
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let collector = Task { () throws -> [String] in
        var parts: [String] = []
        for try await result in transcriber.results {
          if result.isFinal { parts.append(String(result.text.characters)) }
        }
        return parts
      }
      do {
        let lastSample = try await analyzer.analyzeSequence(from: audioFile)
        try checkCancellation()
        if let lastSample {
          try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
          await analyzer.cancelAndFinishNow()
        }
        let text = try await collector.value.joined(separator: " ")
        try checkCancellation()
        Self.emit(["event": "result", "text": text])
      } catch {
        collector.cancel()
        await analyzer.cancelAndFinishNow()
        _ = try? await collector.value
        throw error
      }
    } catch is CancellationError {
      Self.emit(["event": "cancelled"])
    } catch {
      // Never expose framework diagnostics, recording paths, or audio bytes.
      Self.emit(["event": "error", "code": failure])
    }
  }

  static func run(directory: String, fixtureAudio: URL? = nil) async {
    let owner = AppleSpeechCapture()
    let input = Task { @MainActor in
      do {
        for try await line in FileHandle.standardInput.bytes.lines {
          guard let data = line.data(using: .utf8),
                let object = try JSONSerialization.jsonObject(with: data) as? [String: String],
                object.count == 1 else { owner.cancel(); break }
          switch object["command"] {
          case "record": owner.record()
          case "stop": owner.stop()
          case "cancel": owner.cancel()
          default: owner.cancel()
          }
        }
      } catch { owner.cancel() }
      owner.cancel() // EOF is cancellation, never an implicit send/transcript.
    }
    let task = Task { @MainActor in await owner.runCapture(directory: URL(fileURLWithPath: directory, isDirectory: true), fixtureAudio: fixtureAudio) }
    owner.task = task
    await task.value
    input.cancel()
  }
}
