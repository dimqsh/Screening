import Foundation
import CoreGraphics
import CoreImage
import IOSurface
import ImageIO
import UniformTypeIdentifiers

final class Frame: @unchecked Sendable {
    var image: CGImage?
}

// The older display capture API that apps such as Telegram still use. macOS 15+
// SDKs mark CGDisplayStream unavailable, so build-native targets macOS 13 for
// this helper. Same arguments and output as capture-sck.
@main struct CaptureLegacy {
    static func fail(_ code: Int32, _ message: String) -> Never {
        FileHandle.standardError.write(Data(message.utf8))
        exit(code)
    }
    static func main() {
        let a = CommandLine.arguments
        guard a.count == 8,
              let displayID = UInt32(a[1]), let x = Double(a[2]), let y = Double(a[3]),
              let width = Double(a[4]), let height = Double(a[5]), let scale = Double(a[6]) else {
            fail(1, "Expected display ID, x, y, width, height, scale, output path")
        }
        let frame = Frame()
        let done = DispatchSemaphore(value: 0)
        let properties: [CFString: Any] = [
            CGDisplayStream.sourceRect: CGRect(x: x, y: y, width: width, height: height).dictionaryRepresentation,
            CGDisplayStream.showCursor: false,
        ]
        guard let stream = CGDisplayStream(
            dispatchQueueDisplay: displayID,
            outputWidth: Int(width * scale),
            outputHeight: Int(height * scale),
            pixelFormat: Int32(kCVPixelFormatType_32BGRA),
            properties: properties as CFDictionary,
            queue: DispatchQueue(label: "capture-lab.legacy-frames"),
            handler: { status, _, surface, _ in
                guard status == .frameComplete, frame.image == nil, let surface else { return }
                let source = CIImage(ioSurface: surface)
                frame.image = CIContext().createCGImage(source, from: source.extent)
                if frame.image != nil { done.signal() }
            }
        ) else { fail(2, "Display unavailable") }
        guard stream.start() == .success else { fail(2, "Cannot start display stream") }
        let waited = done.wait(timeout: .now() + 8)
        stream.stop()
        guard waited == .success, let image = frame.image else { fail(5, "No display frame arrived") }
        let url = URL(fileURLWithPath: a[7])
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            fail(3, "Cannot create PNG")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { fail(4, "Cannot finish PNG") }
    }
}
