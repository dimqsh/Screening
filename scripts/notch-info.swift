import AppKit
import Foundation

// Prints the camera housing rectangle of the menu bar screen, in points,
// relative to that screen's top-left corner. Buddy anchors its island to it.
@main struct NotchInfo {
    static func main() {
        guard let screen = NSScreen.screens.first else {
            print("{\"hasNotch\":false}")
            return
        }
        let top = screen.safeAreaInsets.top
        guard top > 0,
              let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea,
              right.minX > left.maxX else {
            print("{\"hasNotch\":false}")
            return
        }
        // Both areas share one coordinate space, so their gap is the notch.
        let x = left.width
        let width = right.minX - left.maxX
        print("{\"hasNotch\":true,\"notch\":{\"x\":\(x),\"y\":0,\"width\":\(width),\"height\":\(top)}}")
    }
}
