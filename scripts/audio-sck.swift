import Foundation
import ScreenCaptureKit
import CoreMedia
import AVFoundation
import Darwin

final class AudioSink: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sample.isValid,
              let desc = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              asbd.pointee.mSampleRate == 16000,
              asbd.pointee.mChannelsPerFrame == 1,
              asbd.pointee.mBitsPerChannel == 32,
              let data = CMSampleBufferGetDataBuffer(sample) else { return }
        var pointer: UnsafeMutablePointer<Int8>?
        var length = 0
        guard CMBlockBufferGetDataPointer(data, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer = pointer else { return }
        FileHandle.standardOutput.write(Data(bytes: pointer, count: length))
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data(error.localizedDescription.utf8)); exit(1)
    }
}
@main struct Recorder {
    static func main() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { throw NSError(domain: "CaptureLab", code: 1, userInfo: [NSLocalizedDescriptionKey:"No display available."]) }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = 2; config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.capturesAudio = true; config.sampleRate = 16000; config.channelCount = 1
            config.excludesCurrentProcessAudio = true
            let sink = AudioSink()
            let stream = SCStream(filter: filter, configuration: config, delegate: sink)
            try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: DispatchQueue(label: "capturelab.audio"))
            try await stream.startCapture()
            FileHandle.standardError.write(Data("SCREENING_AUDIO_READY\n".utf8))
            // Parent terminates this process when the user presses Stop or quits.
            try await Task.sleep(nanoseconds: UInt64.max)
        } catch {
            FileHandle.standardError.write(Data(error.localizedDescription.utf8)); exit(1)
        }
    }
}
