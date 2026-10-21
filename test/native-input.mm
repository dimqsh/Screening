// Verification only. Dispatches NSEvents inside this process, through AppKit's
// real hit testing / responder chain, without global event injection.
#import <AppKit/AppKit.h>
#include <node_api.h>
static napi_value send(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void *bytes = nullptr;
  size_t length = 0, size = 0;
  if (argc != 2 || napi_get_buffer_info(env, argv[0], &bytes, &length) != napi_ok ||
      length != sizeof(void *) ||
      napi_get_value_string_utf8(env, argv[1], nullptr, 0, &size) != napi_ok) {
    napi_throw_error(env, nullptr, "Expected native handle and event JSON.");
    return nullptr;
  }
  NSMutableData *text = [NSMutableData dataWithLength:size + 1];
  napi_get_value_string_utf8(env, argv[1], (char *)text.mutableBytes, size + 1, &size);
  NSDictionary *data = [NSJSONSerialization JSONObjectWithData:
      [NSData dataWithBytes:text.bytes length:size] options:0 error:nil];
  NSView *view = (__bridge NSView *)*(void **)bytes;
  NSWindow *window = view.window;
  NSString *kind = data[@"type"];
  if ([kind isEqualToString:@"text"]) {
    id responder = window.firstResponder;
    if (![responder respondsToSelector:@selector(insertText:replacementRange:)]) {
      napi_throw_error(env, nullptr, "The first responder cannot receive native text input.");
      return nullptr;
    }
    [(id<NSTextInputClient>)responder insertText:data[@"text"]
        replacementRange:NSMakeRange(NSNotFound, 0)];
    napi_value result;
    napi_create_string_utf8(env, [responder className].UTF8String, NAPI_AUTO_LENGTH, &result);
    return result;
  }
  NSPoint point = [view convertPoint:NSMakePoint([data[@"x"] doubleValue],
      view.bounds.size.height - [data[@"y"] doubleValue]) toView:nil];
  NSEventModifierFlags modifiers = [data[@"command"] boolValue] ? NSEventModifierFlagCommand : 0;
  if ([data[@"shift"] boolValue]) modifiers |= NSEventModifierFlagShift;
  NSEvent *event;
  if ([kind isEqualToString:@"keyDown"] || [kind isEqualToString:@"keyUp"]) {
    event = [NSEvent keyEventWithType:[kind isEqualToString:@"keyDown"] ? NSEventTypeKeyDown : NSEventTypeKeyUp
        location:point modifierFlags:modifiers timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:window.windowNumber context:nil characters:data[@"text"] ?: @""
        charactersIgnoringModifiers:data[@"text"] ?: @"" isARepeat:NO keyCode:[data[@"keyCode"] unsignedShortValue]];
  } else {
    NSEventType type = [kind isEqualToString:@"mouseDown"] ? NSEventTypeLeftMouseDown :
        [kind isEqualToString:@"mouseUp"] ? NSEventTypeLeftMouseUp : NSEventTypeMouseMoved;
    event = [NSEvent mouseEventWithType:type location:point modifierFlags:modifiers
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
        context:nil eventNumber:1 clickCount:1 pressure:1];
  }
  [window sendEvent:event];
  NSString *hit = [[view hitTest:[view convertPoint:point fromView:nil]] className] ?: @"none";
  napi_value result;
  napi_create_string_utf8(env, hit.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "send", NAPI_AUTO_LENGTH, send, nullptr, &fn);
  napi_set_named_property(env, exports, "send", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
