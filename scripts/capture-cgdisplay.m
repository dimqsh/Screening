// Independent recorder: optional PNG path captures one frame; otherwise stream marker counts for seven seconds.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#import <AppKit/AppKit.h>

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc != 7 && argc != 8) return 2;
    if (!CGPreflightScreenCaptureAccess()) { puts("{\"error\":\"screen-permission-not-granted\"}"); return 3; }
    CGDirectDisplayID display = (CGDirectDisplayID)strtoul(argv[1], NULL, 10);
    CGRect rect = CGRectMake(atof(argv[2]), atof(argv[3]), atof(argv[4]), atof(argv[5]));
    double scale = atof(argv[6]);
    NSString *filename = argc == 8 ? @(argv[7]) : nil;
    if (rect.size.width <= 0 || rect.size.height <= 0 || scale <= 0 ||
        rect.size.width * scale > 16384 || rect.size.height * scale > 16384) return 2;
    const CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
    __block BOOL stopping = NO;
    CFDictionaryRef rectDict = CGRectCreateDictionaryRepresentation(rect);
    NSDictionary *props = @{(__bridge NSString *)kCGDisplayStreamSourceRect:(__bridge NSDictionary *)rectDict,
                            (__bridge NSString *)kCGDisplayStreamShowCursor:@NO,
                            (__bridge NSString *)kCGDisplayStreamMinimumFrameTime:@(1.0/10)};
    dispatch_queue_t queue = dispatch_queue_create("screening.cg-probe", DISPATCH_QUEUE_SERIAL);
    __block CGDisplayStreamRef stream = NULL;
    __block unsigned frames = 0;
    stream = CGDisplayStreamCreateWithDispatchQueue(display, (size_t)(rect.size.width*scale), (size_t)(rect.size.height*scale), kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)props, queue,
      ^(CGDisplayStreamFrameStatus status, uint64_t displayTime, IOSurfaceRef surface, CGDisplayStreamUpdateRef update) {
        if (status == kCGDisplayStreamFrameStatusStopped) { CFRelease(stream); exit(0); }
        if (status != kCGDisplayStreamFrameStatusFrameComplete || !surface) return;
        IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL);
        const uint8_t *p = IOSurfaceGetBaseAddress(surface);
        size_t width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface), stride = IOSurfaceGetBytesPerRow(surface), count = 0, left = 0, right = 0, green = 0;
        for (size_t y=0;y<height;y++) for(size_t x=0;x<width;x++) {
          const uint8_t *v=p+y*stride+x*4;
          if(v[0]>140 && v[1]<65 && v[2]>200) {count++; if(x<width/2)left++;else right++;}
          // WindowServer color conversion gives sRGB green nonzero red/blue
          // on wide-gamut displays. Match its dominance, not exact primaries.
          if(v[1]>150 && v[1]>v[0]*1.5 && v[1]>v[2]*1.5)green++;
        }
        if (filename && !stopping) {
          CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
          CGContextRef context = CGBitmapContextCreate((void *)p, width, height, 8, stride, colors,
              kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
          CGImageRef image = CGBitmapContextCreateImage(context);
          NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
          BOOL saved = [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
              writeToFile:filename atomically:YES];
          CGImageRelease(image); CGContextRelease(context); CGColorSpaceRelease(colors);
          if (!saved) { fputs("Could not save capture ROI\n", stderr); exit(7); }
        }
        IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
        printf("{\"elapsed\":%.6f,\"frame\":%u,\"markerPixels\":%zu,\"left\":%zu,\"right\":%zu,\"green\":%zu,\"width\":%zu,\"height\":%zu,\"displayTime\":%llu}\n",CFAbsoluteTimeGetCurrent()-started,++frames,count,left,right,green,width,height,displayTime); fflush(stdout);
        if (filename && !stopping) { stopping = YES; CGDisplayStreamStop(stream); }
      });
    CFRelease(rectDict);
    if (!stream) { puts("{\"error\":\"stream-create-null\"}"); return 4; }
    CGError result = CGDisplayStreamStart(stream);
    if (result != kCGErrorSuccess) { printf("{\"error\":\"stream-start\",\"code\":%d}\n",result); CFRelease(stream); return 5; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 7*NSEC_PER_SEC), queue, ^{ if (!stopping) { stopping = YES; CGDisplayStreamStop(stream); } });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 9*NSEC_PER_SEC), queue, ^{ puts("{\"error\":\"stop-timeout\"}"); exit(6); });
    dispatch_main();
  }
}
