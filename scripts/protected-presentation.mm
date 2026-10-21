#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>
#include <cstring>

// Chromium's NSViews remain in place for hit testing, accessibility and IME.
// Only their ordinary display layers are suppressed. The visible pixels come
// exclusively from the protected sample-buffer layer.
@interface BuddyPresentation : NSObject
@property(nonatomic, weak) NSView *view;
@property(nonatomic, weak) NSView *source;
@property(nonatomic, weak) NSWindow *parent;
@property(nonatomic, strong) AVSampleBufferDisplayLayer *display;
@property(nonatomic, strong) NSPanel *host;
@property(nonatomic, strong) NSArray *observers;
@property(nonatomic, strong) id spaceObserver;
@property(nonatomic) BOOL closed;
@property(nonatomic) BOOL wantsVisible;
@property(nonatomic) uint64_t frames;
@property(nonatomic) NSUInteger width;
@property(nonatomic) NSUInteger height;
@property(nonatomic) uint64_t spaceChanges;
@property(nonatomic) BOOL metricsPending;
@property(nonatomic) BOOL metricsAvailable;
@property(nonatomic) NSInteger videoFrames;
@property(nonatomic) NSInteger droppedFrames;
@property(nonatomic) NSInteger corruptedFrames;
// Frames reuse IOSurface-backed buffers of the current size.
@property(nonatomic) CVPixelBufferPoolRef pool;
@property(nonatomic) uint32_t poolWidth;
@property(nonatomic) uint32_t poolHeight;
@end
@implementation BuddyPresentation
- (void)dealloc {
  if (_pool) CVPixelBufferPoolRelease(_pool);
}
@end

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}
static napi_value nothing(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}
static BuddyPresentation *presentation(napi_env env, napi_value value) {
  void *pointer = nullptr;
  if (napi_get_value_external(env, value, &pointer) != napi_ok) return nil;
  return (__bridge BuddyPresentation *)pointer;
}
static void suppressSource(BuddyPresentation *p) {
  if (p.source.layer.opacity == 0 && CGRectEqualToRect(p.display.frame, p.view.bounds) &&
      p.display.contentsScale == p.parent.backingScaleFactor)
    return;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  p.source.layer.opacity = 0;
  // This is a layer-hosting view: AppKit must not own the display's backing
  // layer or redraw an empty backing store over the protected presentation.
  p.display.frame = p.view.bounds;
  p.display.contentsScale = p.parent.backingScaleFactor;
  [CATransaction commit];
}
static void synchronize(BuddyPresentation *p) {
  if (p.closed || !p.parent) return;
  suppressSource(p);
  if (!NSEqualRects(p.host.frame, p.parent.frame))
    [p.host setFrame:p.parent.frame display:YES];
  if (p.host.level != p.parent.level + 1) p.host.level = p.parent.level + 1;
  NSWindowCollectionBehavior behavior = p.parent.collectionBehavior;
  behavior &= ~(NSWindowCollectionBehaviorPrimary | NSWindowCollectionBehaviorAuxiliary |
      NSWindowCollectionBehaviorFullScreenPrimary | NSWindowCollectionBehaviorMoveToActiveSpace);
  behavior |= NSWindowCollectionBehaviorCanJoinAllSpaces |
      NSWindowCollectionBehaviorFullScreenAuxiliary |
      NSWindowCollectionBehaviorCanJoinAllApplications | NSWindowCollectionBehaviorIgnoresCycle;
  if (p.host.collectionBehavior != behavior) p.host.collectionBehavior = behavior;
  if (p.wantsVisible && p.parent.visible && !p.parent.miniaturized && p.frames > 0) {
    if (!p.host.visible) [p.host orderFrontRegardless];
  }
  else [p.host orderOut:nil];
}
static void closePresentation(BuddyPresentation *p) {
  if (p.closed) return;
  p.closed = YES;
  for (id token in p.observers) [NSNotificationCenter.defaultCenter removeObserver:token];
  p.observers = nil;
  if (p.spaceObserver)
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:p.spaceObserver];
  p.spaceObserver = nil;
  [p.parent removeChildWindow:p.host];
  [p.host orderOut:nil];
  [p.host close];
  p.view.layer = nil;
}
static void replaceDisplay(BuddyPresentation *p, BOOL protectedContent) {
  // Detach the old image and queue before changing protection for a test.
  [p.host orderOut:nil];
  p.view.wantsLayer = NO;
  p.view.layer = nil;
  p.frames = 0;
  p.metricsAvailable = NO;
  p.display = [AVSampleBufferDisplayLayer layer];
  p.display.preventsCapture = protectedContent;
  p.display.videoGravity = AVLayerVideoGravityResize;
  p.display.autoresizingMask = kCALayerWidthSizable | kCALayerHeightSizable;
  // Assign before wantsLayer to use NSView's layer-hosting contract rather
  // than installing an AV sublayer in an AppKit-managed backing layer.
  p.view.layer = p.display;
  p.view.wantsLayer = YES;
  suppressSource(p);
}
static void finalize(napi_env env, void *pointer, void *hint) {
  BuddyPresentation *p = (__bridge_transfer BuddyPresentation *)pointer;
  closePresentation(p);
  // Never reveal the unprotected source as a disposal/error fallback.
}
static napi_value attach(napi_env env, napi_callback_info info) {
  if (![NSThread isMainThread]) return fail(env, "Presentation must run on the main thread.");
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void *bytes = nullptr;
  size_t length = 0;
  if (argc < 1 || napi_get_buffer_info(env, argv[0], &bytes, &length) != napi_ok ||
      length != sizeof(void *))
    return fail(env, "Expected a native NSView handle.");
  bool protectedContent = true;
  if (argc == 2 && napi_get_value_bool(env, argv[1], &protectedContent) != napi_ok)
    return fail(env, "Expected a protection flag.");
  NSView *view = (__bridge NSView *)*(void **)bytes;
  if (!view.window) return fail(env, "Buddy has no native window.");
  BuddyPresentation *p = [BuddyPresentation new];
  NSWindow *window = view.window;
  p.host = [[NSPanel alloc] initWithContentRect:window.frame styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
  p.host.releasedWhenClosed = NO;
  p.host.opaque = NO;
  p.host.backgroundColor = NSColor.clearColor;
  p.host.hasShadow = NO;
  p.host.ignoresMouseEvents = YES;
  p.host.hidesOnDeactivate = NO;
  p.host.canHide = NO;
  NSView *presentationView = [[NSView alloc] initWithFrame:
      NSMakeRect(0, 0, window.frame.size.width, window.frame.size.height)];
  p.host.contentView = presentationView;
  p.view = presentationView;
  p.parent = window;
  p.wantsVisible = window.visible;
  p.host.title = @"Screening — Buddy";
  // macOS 27 keeps a window hidden from screen sharing once it was hidden,
  // unless Screening may record the screen; an unprotected Buddy starts visible.
  p.host.sharingType = protectedContent ? NSWindowSharingNone : NSWindowSharingReadOnly;
  p.source = view;
  view.wantsLayer = YES;
  view.layer.opacity = 0;
  replaceDisplay(p, protectedContent);
  // Visibility is driven explicitly by Buddy, including when the source
  // window was already occluded and no new occlusion notification arrives.
  [p.host orderOut:nil];
  __weak BuddyPresentation *weak = p;
  NSMutableArray *observers = [NSMutableArray array];
  for (NSNotificationName name in @[NSWindowDidMoveNotification, NSWindowDidResizeNotification,
      NSWindowDidChangeScreenNotification, NSWindowDidChangeOcclusionStateNotification,
      NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification]) {
    [observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:name
        object:window queue:nil usingBlock:^(NSNotification *notification) {
          BuddyPresentation *strong = weak;
          if (strong) synchronize(strong);
        }]];
  }
  [observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:NSWindowWillCloseNotification
      object:window queue:nil usingBlock:^(NSNotification *notification) {
        BuddyPresentation *strong = weak;
        if (strong) closePresentation(strong);
      }]];
  p.observers = observers;
  p.spaceObserver = [NSWorkspace.sharedWorkspace.notificationCenter
      addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification object:nil
      queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
        BuddyPresentation *strong = weak;
        if (!strong || strong.closed) return;
        strong.spaceChanges++;
        // Keep the protected image and queue intact across Spaces. Replacing
        // the layer here introduced a blank interval and did not resolve the
        // reported Telegram-call visibility failure.
        synchronize(strong);
      }];
  napi_value result;
  napi_create_external(env, (__bridge_retained void *)p, finalize, nullptr, &result);
  return result;
}
static napi_value frame(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 4) return fail(env, "Expected presentation, BGRA pixels, width and height.");
  BuddyPresentation *p = presentation(env, argv[0]);
  void *bytes = nullptr;
  size_t length = 0;
  uint32_t width = 0, height = 0;
  if (!p || p.closed || !p.view || napi_get_buffer_info(env, argv[1], &bytes, &length) != napi_ok ||
      napi_get_value_uint32(env, argv[2], &width) != napi_ok ||
      napi_get_value_uint32(env, argv[3], &height) != napi_ok ||
      width == 0 || height == 0 || width > 16384 || height > 16384 ||
      length != (size_t)width * height * 4)
    return fail(env, "Invalid presentation frame.");
  suppressSource(p);
  id<AVQueuedSampleBufferRendering> renderer = p.display.sampleBufferRenderer;
  if (p.display.sampleBufferRenderer.status == AVQueuedSampleBufferRenderingStatusFailed)
    [renderer flush];
  if (!renderer.readyForMoreMediaData) return nothing(env);
  if (!p.pool || p.poolWidth != width || p.poolHeight != height) {
    if (p.pool) CVPixelBufferPoolRelease(p.pool);
    p.pool = nullptr;
    NSDictionary *attributes = @{
      (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
      (id)kCVPixelBufferWidthKey: @(width),
      (id)kCVPixelBufferHeightKey: @(height),
      (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
    };
    CVPixelBufferPoolRef pool = nullptr;
    if (CVPixelBufferPoolCreate(kCFAllocatorDefault, nullptr,
            (__bridge CFDictionaryRef)attributes, &pool) != kCVReturnSuccess)
      return fail(env, "Could not allocate Buddy's pixel buffers.");
    p.pool = pool;
    p.poolWidth = width;
    p.poolHeight = height;
  }
  CVPixelBufferRef pixels = nullptr;
  CVReturn created = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, p.pool, &pixels);
  if (created != kCVReturnSuccess) return fail(env, "Could not allocate Buddy's pixel buffer.");
  CVBufferSetAttachment(pixels, kCVImageBufferAlphaChannelModeKey,
      kCVImageBufferAlphaChannelMode_PremultipliedAlpha, kCVAttachmentMode_ShouldPropagate);
  CVPixelBufferLockBaseAddress(pixels, 0);
  uint8_t *destination = (uint8_t *)CVPixelBufferGetBaseAddress(pixels);
  size_t stride = CVPixelBufferGetBytesPerRow(pixels);
  for (uint32_t row = 0; row < height; row++)
    memcpy(destination + row * stride, (uint8_t *)bytes + row * width * 4, width * 4);
  CVPixelBufferUnlockBaseAddress(pixels, 0);
  CMVideoFormatDescriptionRef format = nullptr;
  CMSampleBufferRef sample = nullptr;
  OSStatus result = CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixels, &format);
  if (!result) {
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    result = CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pixels, format, &timing, &sample);
  }
  if (sample) {
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, true);
    CFDictionarySetValue((CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0),
        kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);
    [renderer enqueueSampleBuffer:sample];
    p.frames++;
    p.width = width;
    p.height = height;
    if (@available(macOS 14.4, *)) {
      if (p.frames % 30 == 0 && !p.metricsPending) {
        p.metricsPending = YES;
        __weak BuddyPresentation *weak = p;
        AVSampleBufferDisplayLayer *display = p.display;
        [display.sampleBufferRenderer loadVideoPerformanceMetricsWithCompletionHandler:
            ^(AVVideoPerformanceMetrics *metrics) {
          dispatch_async(dispatch_get_main_queue(), ^{
            BuddyPresentation *strong = weak;
            if (!strong || strong.closed) return;
            strong.metricsPending = NO;
            if (strong.display != display) return;
            strong.metricsAvailable = metrics != nil;
            strong.videoFrames = metrics.totalNumberOfFrames;
            strong.droppedFrames = metrics.numberOfDroppedFrames;
            strong.corruptedFrames = metrics.numberOfCorruptedFrames;
          });
        }];
      }
    }
    CFRelease(sample);
  }
  if (format) CFRelease(format);
  CFRelease(pixels);
  if (result) return fail(env, "Could not prepare Buddy's sample buffer.");
  synchronize(p);
  return nothing(env);
}
static napi_value protect(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool enabled = true;
  BuddyPresentation *p = argc == 2 ? presentation(env, argv[0]) : nil;
  if (!p || napi_get_value_bool(env, argv[1], &enabled) != napi_ok)
    return fail(env, "Expected presentation and protection flag.");
  p.display.preventsCapture = enabled;
  p.host.sharingType = enabled ? NSWindowSharingNone : NSWindowSharingReadOnly;
  suppressSource(p);
  return nothing(env);
}
static napi_value clear(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  BuddyPresentation *p = argc == 1 ? presentation(env, argv[0]) : nil;
  if (!p || p.closed) return fail(env, "Invalid presentation.");
  replaceDisplay(p, p.display.preventsCapture);
  return nothing(env);
}
static napi_value status(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  BuddyPresentation *p = argc == 1 ? presentation(env, argv[0]) : nil;
  if (!p) return fail(env, "Invalid presentation.");
  napi_value object, value;
  napi_create_object(env, &object);
  for (NSString *key in @[@"protected", @"ready", @"sourceSuppressed", @"visible", @"aligned",
      @"wantsVisible", @"parentVisible", @"onActiveSpace", @"parentOnActiveSpace",
      @"outputObscured", @"applicationHidden", @"hostOcclusionVisible", @"parentOcclusionVisible",
      @"layerHosted", @"metricsAvailable"]) {
    bool flag = false;
    if ([key isEqualToString:@"protected"]) flag = p.display.preventsCapture;
    if ([key isEqualToString:@"ready"]) {
      if (@available(macOS 14.4, *)) flag = p.display.readyForDisplay;
      else flag = p.frames > 0 && p.display.sampleBufferRenderer.status != AVQueuedSampleBufferRenderingStatusFailed;
    }
    if ([key isEqualToString:@"sourceSuppressed"]) {
      flag = p.source != nil && p.parent.contentView == p.source &&
          p.source.layer.opacity == 0;
    }
    if ([key isEqualToString:@"visible"]) flag = p.host.visible;
    if ([key isEqualToString:@"wantsVisible"]) flag = p.wantsVisible;
    if ([key isEqualToString:@"parentVisible"]) flag = p.parent.visible;
    if ([key isEqualToString:@"onActiveSpace"]) flag = p.host.onActiveSpace;
    if ([key isEqualToString:@"parentOnActiveSpace"]) flag = p.parent.onActiveSpace;
    if ([key isEqualToString:@"outputObscured"])
      flag = p.display.outputObscuredDueToInsufficientExternalProtection;
    if ([key isEqualToString:@"applicationHidden"]) flag = NSApp.hidden;
    if ([key isEqualToString:@"layerHosted"]) flag = p.view.layer == p.display;
    if ([key isEqualToString:@"metricsAvailable"]) flag = p.metricsAvailable;
    if ([key isEqualToString:@"hostOcclusionVisible"])
      flag = (p.host.occlusionState & NSWindowOcclusionStateVisible) != 0;
    if ([key isEqualToString:@"parentOcclusionVisible"])
      flag = (p.parent.occlusionState & NSWindowOcclusionStateVisible) != 0;
    if ([key isEqualToString:@"aligned"])
      flag = NSEqualRects(p.host.frame, p.parent.frame);
    napi_get_boolean(env, flag, &value);
    napi_set_named_property(env, object, key.UTF8String, value);
  }
  for (NSString *key in @[@"frames", @"width", @"height", @"windowNumber", @"rendererStatus",
      @"spaceChanges", @"videoFrames", @"droppedFrames", @"corruptedFrames"]) {
    double number = [key isEqualToString:@"frames"] ? p.frames :
        [key isEqualToString:@"width"] ? p.width :
        [key isEqualToString:@"height"] ? p.height :
        [key isEqualToString:@"spaceChanges"] ? p.spaceChanges :
        [key isEqualToString:@"videoFrames"] ? p.videoFrames :
        [key isEqualToString:@"droppedFrames"] ? p.droppedFrames :
        [key isEqualToString:@"corruptedFrames"] ? p.corruptedFrames :
        [key isEqualToString:@"rendererStatus"] ? p.display.sampleBufferRenderer.status :
        p.host.windowNumber;
    napi_create_double(env, number, &value);
    napi_set_named_property(env, object, key.UTF8String, value);
  }
  return object;
}
static napi_value sync(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  BuddyPresentation *p = argc >= 1 ? presentation(env, argv[0]) : nil;
  if (!p) return fail(env, "Invalid presentation.");
  if (argc == 2) {
    bool visible;
    if (napi_get_value_bool(env, argv[1], &visible) != napi_ok)
      return fail(env, "Invalid visibility.");
    p.wantsVisible = visible;
  }
  synchronize(p);
  return nothing(env);
}
static napi_value close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  BuddyPresentation *p = argc == 1 ? presentation(env, argv[0]) : nil;
  if (!p) return fail(env, "Invalid presentation.");
  closePresentation(p);
  return nothing(env);
}
static napi_value releaseKeyboard(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  BuddyPresentation *p = argc == 1 ? presentation(env, argv[0]) : nil;
  if (!p) return fail(env, "Invalid presentation.");
  [p.parent resignKeyWindow];
  return nothing(env);
}
static napi_value takeKeyboard(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  BuddyPresentation *p = argc == 1 ? presentation(env, argv[0]) : nil;
  if (!p) return fail(env, "Invalid presentation.");
  [p.parent makeKeyWindow];
  return nothing(env);
}
// Lets go of idle pooled buffers; the frame on screen stays alive.
static napi_value trim(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  BuddyPresentation *p = argc == 1 ? presentation(env, argv[0]) : nil;
  if (!p) return fail(env, "Invalid presentation.");
  if (p.pool) CVPixelBufferPoolRelease(p.pool);
  p.pool = nullptr;
  return nothing(env);
}
static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"attach", nullptr, attach, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"frame", nullptr, frame, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"protect", nullptr, protect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"clear", nullptr, clear, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"status", nullptr, status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sync", nullptr, sync, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseKeyboard", nullptr, releaseKeyboard, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"takeKeyboard", nullptr, takeKeyboard, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"trim", nullptr, trim, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
