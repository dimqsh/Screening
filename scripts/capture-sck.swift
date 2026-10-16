import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import CoreImage
import CoreMedia

final class FrameReceiver: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: CheckedContinuation<CGImage, Error>?
    private var captured: CGImage?
    func nextImage() async throws -> CGImage {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let image = captured { lock.unlock(); continuation.resume(returning: image) }
            else { pending = continuation; lock.unlock() }
        }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = sampleBuffer.imageBuffer else { return }
        lock.lock()
        guard captured == nil else { lock.unlock(); return }
        let source = CIImage(cvImageBuffer: buffer)
        guard let image = CIContext().createCGImage(source, from: source.extent) else { lock.unlock(); return }
        captured = image
        let continuation = pending
        pending = nil
        lock.unlock()
        continuation?.resume(returning: image)
    }
}

// A separate, explicit recorder. Empty excludingWindows intentionally tests
// whether the overlay's own sharing flag can exclude it from this modern API.
@main struct CaptureSCK {
    static func main() async {
        do {
            let a = CommandLine.arguments
            guard a.count == 8,
                  let displayID = UInt32(a[1]), let x = Double(a[2]), let y = Double(a[3]),
                  let width = Double(a[4]), let height = Double(a[5]), let scale = Double(a[6]) else {
                throw NSError(domain: "CaptureLab", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected display ID, x, y, width, height, scale, output path"])
            }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                throw NSError(domain: "CaptureLab", code: 2, userInfo: [NSLocalizedDescriptionKey: "Display unavailable"])
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.sourceRect = CGRect(x: x, y: y, width: width, height: height)
            config.width = Int(width * scale)
            config.height = Int(height * scale)
            config.showsCursor = false
            config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            let receiver = FrameReceiver()
            let stream = SCStream(filter: filter, configuration: config, delegate: nil)
            try stream.addStreamOutput(receiver, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture-lab.frames"))
            try await stream.startCapture()
            let image = try await receiver.nextImage()
            try await stream.stopCapture()
            let url = URL(fileURLWithPath: a[7])
            guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
                throw NSError(domain: "CaptureLab", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot create PNG"])
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else {
                throw NSError(domain: "CaptureLab", code: 4, userInfo: [NSLocalizedDescriptionKey: "Cannot finish PNG"])
            }
        } catch {
            FileHandle.standardError.write(Data(error.localizedDescription.utf8))
            exit(1)
        }
    }
}
