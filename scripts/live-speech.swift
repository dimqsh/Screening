import AVFoundation
import CoreMedia
import Foundation
import Speech

// Live speech-to-text with Apple's on-device models (macOS 26+). Words show up
// while someone is still talking; Whisper writes only whole phrases.
//
//   live-speech --locale en   16 kHz mono float32 on stdin, one JSON object per line on stdout:
//                               {"type":"ready","locale":"en-US","model":"speech"}
//                               {"type":"partial","text":"ask not what","start":4.1,"end":5.0}
//                               {"type":"final","text":"Ask not what your country can do for you.","start":4.1,"end":7.2}
//                             Closing stdin finishes the last words and exits.
//                             SIGUSR1 settles the words heard so far, for an answer now.
//   live-speech --check en    {"locale":"en-US","model":"speech","installed":true}, or {"locale":null}
//   live-speech --install en  downloads the language, printing {"type":"progress","progress":0.4}

func emit(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

// SpeechTranscriber is Apple's newer long-form model; DictationTranscriber,
// the one behind dictation, also covers Russian, Ukrainian, Turkish and more.
enum Model: String { case speech, dictation }

// A language code alone ("en") would match the first English Apple lists
// (Australian). Prefer the Mac's own region, then the most common one.
let usualRegion = [
    "en": "US", "es": "ES", "fr": "FR", "de": "DE", "zh": "CN", "ja": "JP", "pt": "BR",
    "it": "IT", "ko": "KR", "ru": "RU", "uk": "UA", "tr": "TR",
]

func resolve(_ code: String, model forced: Model?) async -> (Locale, Model)? {
    var wanted: [String] = []
    if code.contains("-") { wanted.append(code) }
    if Locale.current.language.languageCode?.identifier == code, let region = Locale.current.region?.identifier {
        wanted.append("\(code)-\(region)")
    }
    if let region = usualRegion[code] { wanted.append("\(code)-\(region)") }
    let models: [Model] = forced.map { [$0] } ?? [.speech, .dictation]
    for model in models {
        let supported = model == .speech
            ? await SpeechTranscriber.supportedLocales
            : await DictationTranscriber.supportedLocales
        let byId = Dictionary(supported.map { ($0.identifier(.bcp47), $0) }, uniquingKeysWith: { a, _ in a })
        for id in wanted { if let locale = byId[id] { return (locale, model) } }
        if let locale = supported.first(where: { $0.language.languageCode?.identifier == code }) {
            return (locale, model)
        }
    }
    return nil
}

func module(_ model: Model, _ locale: Locale) -> any SpeechModule {
    switch model {
    case .speech:
        return SpeechTranscriber(
            locale: locale, transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults], attributeOptions: [.audioTimeRange])
    case .dictation:
        return DictationTranscriber(
            locale: locale, contentHints: [], transcriptionOptions: [.punctuation],
            reportingOptions: [.volatileResults, .frequentFinalization], attributeOptions: [.audioTimeRange])
    }
}

// Apple keeps at most five languages per app. When they are taken, let go of
// another one, which macOS keeps on disk until it needs the space.
func installation(_ modules: [any SpeechModule], for locale: Locale) async throws -> AssetInstallationRequest? {
    while true {
        do {
            return try await AssetInventory.assetInstallationRequest(supporting: modules)
        } catch {
            let wanted = locale.identifier(.bcp47)
            guard let other = await AssetInventory.reservedLocales.first(where: { $0.identifier(.bcp47) != wanted }),
                  await AssetInventory.release(reservedLocale: other) else { throw error }
        }
    }
}

func install(_ modules: [any SpeechModule], for locale: Locale) async throws {
    guard let request = try await installation(modules, for: locale) else { return }
    let progress = request.progress
    let watch = progress.observe(\.fractionCompleted) { progress, _ in
        emit(["type": "progress", "progress": (progress.fractionCompleted * 100).rounded() / 100])
    }
    try await request.downloadAndInstall()
    watch.invalidate()
}

// Words carry their own time ranges, so "end" is where the last word stops.
func times(_ text: AttributedString, _ range: CMTimeRange) -> (Double, Double) {
    var start: Double?, end: Double?
    for run in text.runs {
        guard let time = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self] else { continue }
        if start == nil { start = time.start.seconds }
        end = time.end.seconds
    }
    let round = { (value: Double) in (value * 100).rounded() / 100 }
    return (round(start ?? range.start.seconds), round(end ?? range.end.seconds))
}

// --words adds each word's time range to final results, for measuring latency.
let withWords = CommandLine.arguments.contains("--words")

func report<Results: AsyncSequence>(_ results: Results, text: @escaping (Results.Element) -> AttributedString) async throws
where Results.Element: SpeechModuleResult {
    for try await result in results {
        let words = text(result)
        let (start, end) = times(words, result.range)
        let plain = String(words.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        sentence.done = !result.isFinal && plain.last.map { ".?!…。？！".contains($0) } == true
        var line: [String: Any] = [
            "type": result.isFinal ? "final" : "partial",
            "text": plain,
            "start": start, "end": end,
        ]
        if withWords && result.isFinal {
            line["words"] = words.runs.compactMap { run -> [Any]? in
                guard let time = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self] else { return nil }
                return [String(words[run.range].characters), time.start.seconds, time.end.seconds]
            }
        }
        emit(line)
    }
}

// Whether Apple's words so far end a sentence. Results arrive on one task,
// audio on another thread.
final class Sentence: @unchecked Sendable {
    private let lock = NSLock()
    private var ended = false
    var done: Bool {
        get { lock.withLock { ended } }
        set { lock.withLock { ended = newValue } }
    }
}
let sentence = Sentence()

// Apple settles words on its own schedule, often two seconds after the speaker
// stops, and answers wait for settled text. So a pause settles the words up to
// it: 0.7 s after a finished sentence, or 1.6 s after anything else, because
// settling in the middle of a sentence costs Apple the context for the rest.
// Pauses are found the way Screening's segmenter finds phrase ends: 30 ms
// frames against an adaptive noise floor.
struct PauseFinder {
    private var floor: Float = 0.003
    private var frame: [Float] = []
    private var position = 0
    private var speechEnd: Int?
    private let shortPause = 16000 * 7 / 10
    private let longPause = 16000 * 16 / 10

    // The sample position to settle through, once a pause follows speech.
    mutating func push(_ samples: UnsafeBufferPointer<Float>) -> Int? {
        var settle: Int?
        for sample in samples {
            frame.append(sample)
            position += 1
            guard frame.count == 480 else { continue }
            let rms = (frame.reduce(0) { $0 + $1 * $1 } / 480).squareRoot()
            frame.removeAll(keepingCapacity: true)
            let speaking = rms > max(0.006, floor * 3)
            if rms < floor { floor = floor * 0.9 + rms * 0.1 } else if !speaking { floor += (rms - floor) * 0.01 }
            guard !speaking else { speechEnd = position; continue }
            if let end = speechEnd, position - end >= longPause || (position - end >= shortPause && sentence.done) {
                settle = end
                speechEnd = nil
            }
        }
        return settle
    }
}

// Reads stdin on its own thread: Node writes whatever the call or microphone
// delivered, and a chunk may end in the middle of a 4-byte sample.
func readInput(into feed: AsyncStream<AnalyzerInput>.Continuation, as format: AVAudioFormat, analyzer: SpeechAnalyzer) {
    let source = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    let converter = format == source ? nil : AVAudioConverter(from: source, to: format)
    Thread.detachNewThread {
        var pauses = PauseFinder()
        var leftover = Data()
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { break }
            leftover.append(chunk)
            let frames = leftover.count / 4
            guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(frames)) else { continue }
            buffer.frameLength = AVAudioFrameCount(frames)
            leftover.withUnsafeBytes { bytes in
                _ = memcpy(buffer.floatChannelData![0], bytes.baseAddress!, frames * 4)
            }
            leftover.removeFirst(frames * 4)
            let settle = pauses.push(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: frames))
            if let converter {
                let capacity = AVAudioFrameCount(Double(frames) * format.sampleRate / 16000) + 32
                guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { continue }
                var supplied = false
                var error: NSError?
                converter.convert(to: out, error: &error) { _, status in
                    if supplied { status.pointee = .noDataNow; return nil }
                    supplied = true
                    status.pointee = .haveData
                    return buffer
                }
                if error == nil, out.frameLength > 0 { feed.yield(AnalyzerInput(buffer: out)) }
            } else { feed.yield(AnalyzerInput(buffer: buffer)) }
            // A little past the last loud frame, so the final word is whole.
            if let settle {
                let through = CMTime(value: CMTimeValue(settle + 3200), timescale: 16000)
                Task { try? await analyzer.finalize(through: through) }
            }
        }
        feed.finish()
    }
}

@main struct LiveSpeech {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        func value(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        guard SpeechTranscriber.isAvailable else { fail("Live transcription needs macOS 26 on a supported Mac.", code: 3) }
        let code = value("--check") ?? value("--install") ?? value("--locale") ?? "en"
        let forced = value("--model").flatMap(Model.init(rawValue:))
        guard let (locale, model) = await resolve(code, model: forced) else {
            if arguments.contains("--check") { emit(["locale": NSNull()]); return }
            fail("Apple's speech recognition does not support \(code).", code: 3)
        }
        let modules = [module(model, locale)]
        let id = locale.identifier(.bcp47)
        if arguments.contains("--check") {
            // status(forModules:) can say "supported" for a language that works
            // offline; no installation request means nothing is left to download.
            let request: AssetInstallationRequest?
            do {
                request = try await installation(modules, for: locale)
            } catch {
                fail("Checking \(id) failed: \(error.localizedDescription)")
            }
            emit(["locale": id, "model": model.rawValue, "installed": request == nil])
            return
        }
        do {
            try await install(modules, for: locale)
            if arguments.contains("--install") { return }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
                fail("No audio format for \(id).")
            }
            let analyzer = SpeechAnalyzer(
                modules: modules, options: .init(priority: .userInitiated, modelRetention: .processLifetime))
            try await analyzer.prepareToAnalyze(in: format)
            let listening = Task {
                if let transcriber = modules[0] as? SpeechTranscriber {
                    try await report(transcriber.results) { $0.text }
                } else if let transcriber = modules[0] as? DictationTranscriber {
                    try await report(transcriber.results) { $0.text }
                }
            }
            let (inputs, feed) = AsyncStream.makeStream(of: AnalyzerInput.self)
            // Stop finishes like the end of input, so the last words still arrive.
            signal(SIGTERM, SIG_IGN)
            let stop = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            stop.setEventHandler {
                feed.finish()
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(0) }
            }
            stop.resume()
            signal(SIGUSR1, SIG_IGN)
            let settle = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
            settle.setEventHandler { Task { try? await analyzer.finalize(through: nil) } }
            settle.resume()
            readInput(into: feed, as: format, analyzer: analyzer)
            try await analyzer.start(inputSequence: inputs)
            emit(["type": "ready", "locale": id, "model": model.rawValue])
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await listening.value
            withExtendedLifetime((stop, settle)) {}
        } catch {
            fail("Live transcription stopped: \(error.localizedDescription)")
        }
    }
}
