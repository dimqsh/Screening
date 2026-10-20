import Foundation
import CoreAudio
import AVFoundation
import Darwin

// Call audio through a Core Audio process tap (macOS 14.2+). Unlike
// ScreenCaptureKit, a tap needs only "System Audio Recording", which macOS
// asks for with an Allow button, so Screening never needs screen recording
// to listen to a call.
//
//   audio-tap            16 kHz mono float32 on stdout, SCREENING_AUDIO_READY on stderr
//   audio-tap --status   prints granted, denied or unknown
//   audio-tap --request  asks once and prints granted or denied

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(code)
}

// There is no public API to read or request this permission; without it a
// tap records silence instead of failing. TCC's own calls give a real answer.
enum Permission {
    typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
    typealias Request = @convention(c) (CFString, CFDictionary?, @convention(block) @escaping (Bool) -> Void) -> Void
    static let service = "kTCCServiceAudioCapture" as CFString
    static let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)

    static func status() -> String {
        guard let symbol = dlsym(tcc, "TCCAccessPreflight") else { return "unknown" }
        switch unsafeBitCast(symbol, to: Preflight.self)(service, nil) {
        case 0: return "granted"
        case 1: return "denied"
        default: return "unknown"
        }
    }

    static func request() -> Bool {
        guard let symbol = dlsym(tcc, "TCCAccessRequest") else { return false }
        let done = DispatchSemaphore(value: 0)
        var granted = false
        unsafeBitCast(symbol, to: Request.self)(service, nil) { answer in
            granted = answer
            done.signal()
        }
        done.wait()
        return granted
    }
}

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T) -> OSStatus {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<T>.size)
    return withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
    }
}

func check(_ status: OSStatus, _ what: String) {
    if status != noErr { fail("\(what) failed (\(status)).") }
}

final class Recorder {
    var tap = AudioObjectID(kAudioObjectUnknown)
    var device = AudioObjectID(kAudioObjectUnknown)
    var proc: AudioDeviceIOProcID?
    let queue = DispatchQueue(label: "screening.audio-tap")
    let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

    func start() {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "Screening call audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        check(AudioHardwareCreateProcessTap(description, &tap), "Creating the audio tap")

        var stream = AudioStreamBasicDescription()
        check(property(tap, kAudioTapPropertyFormat, &stream), "Reading the tap format")
        guard let source = AVAudioFormat(streamDescription: &stream),
              let converter = AVAudioConverter(from: source, to: target) else { fail("Unsupported tap format.") }
        converter.downmix = true

        // A tap delivers audio only inside an aggregate device clocked by the output device.
        var output = AudioObjectID(kAudioObjectUnknown)
        check(property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, &output), "Finding the output device")
        var reference: Unmanaged<CFString>?
        check(property(output, kAudioDevicePropertyDeviceUID, &reference), "Reading the output device")
        guard let uid = reference?.takeRetainedValue() else { fail("The output device has no identifier.") }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Screening call audio",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: uid as String,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: uid as String]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "Creating the audio device")

        let target = self.target
        check(AudioDeviceCreateIOProcIDWithBlock(&proc, device, queue) { _, input, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: source, bufferListNoCopy: input, deallocator: nil),
                  buffer.frameLength > 0 else { return }
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / source.sampleRate) + 32
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil, out.frameLength > 0, let samples = out.floatChannelData?[0] else { return }
            FileHandle.standardOutput.write(Data(bytes: samples, count: Int(out.frameLength) * 4))
        }, "Listening to the audio device")
        check(AudioDeviceStart(device, proc), "Starting the audio device")
        FileHandle.standardError.write(Data("SCREENING_AUDIO_READY\n".utf8))
    }

    func stop() {
        if let proc {
            AudioDeviceStop(device, proc)
            AudioDeviceDestroyIOProcID(device, proc)
        }
        if device != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(device) }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
    }
}

@main struct AudioTap {
    static func main() {
        let arguments = CommandLine.arguments.dropFirst()
        if arguments.contains("--status") {
            print(Permission.status())
            return
        }
        if arguments.contains("--request") {
            print(Permission.status() == "granted" || Permission.request() ? "granted" : "denied")
            return
        }
        let settings = "Allow Screening in System Settings → Privacy & Security → Screen & System Audio Recording, under System Audio Recording Only."
        switch Permission.status() {
        case "denied": fail(settings, code: 2)
        case "unknown": if !Permission.request() { fail(settings, code: 2) }
        default: break
        }
        let recorder = Recorder()
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        var handlers: [DispatchSourceSignal] = []
        for number in [SIGTERM, SIGINT] {
            let handler = DispatchSource.makeSignalSource(signal: number, queue: .main)
            handler.setEventHandler {
                recorder.stop()
                exit(0)
            }
            handler.resume()
            handlers.append(handler)
        }
        recorder.start()
        // The parent stops this process when the user presses Stop or quits.
        withExtendedLifetime(handlers) { dispatchMain() }
    }
}
