#import <AppKit/AppKit.h>

// A separate application exercises the real WindowServer Space transition.
// It neither joins a call nor records another application's pixels.
@interface FullscreenHost : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic) BOOL entered;
@property(nonatomic) BOOL left;
@end
@implementation FullscreenHost
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 180, 760, 460)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
  self.window.releasedWhenClosed = NO;
  self.window.delegate = self;
  self.window.title = @"Buddy fullscreen regression test";
  self.window.backgroundColor = [NSColor colorWithWhite:0.12 alpha:1];
  self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    [self.window toggleFullScreen:nil];
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (!self.left) {
      fputs("Fullscreen Space transition timed out.\n", stderr);
      exit(1);
    }
  });
}
- (void)windowDidEnterFullScreen:(NSNotification *)notification {
  self.entered = YES;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    [self.window toggleFullScreen:nil];
  });
}
- (void)windowDidExitFullScreen:(NSNotification *)notification {
  self.left = YES;
  puts("{\"enteredFullscreen\":true,\"leftFullscreen\":true}");
  fflush(stdout);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    [NSApp terminate:nil];
  });
}
@end
int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    FullscreenHost *delegate = [FullscreenHost new];
    NSApp.delegate = delegate;
    [NSApp run];
  }
}
