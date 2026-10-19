# Buddy: the assistant at the notch

Date: 2026-10-17. Status: approved by the author in chat ("just cool design", "buddy must not be visible in the call, like Screening today"). Design inspiration came from NotchBuddy (an island fused with the MacBook notch that opens on hover) and Notchprompt (a teleprompter in the notch so you keep looking at the camera).

## Intent

Screening already transcribes the interviewer locally and drafts answers through the user's ChatGPT account. Today the answer lives in a floating compact window that the user drags somewhere on screen, so their eyes leave the camera to read it.

Buddy moves the answer to the top edge of the screen, right under the camera. It grows out of the physical notch on a MacBook and simulates a notch on every other display. Reading from Buddy looks like looking at the interviewer.

Buddy is a view, not a new brain. It reads the same interview state as the two existing windows and triggers the same actions.

## Goals

- One glance tells the user what Buddy is doing: idle, listening, thinking, answer ready, or needs setup.
- The latest answer streams into a large, high-contrast reading panel near the camera.
- The meeting app keeps keyboard focus at all times. Buddy never steals it.
- Everything outside the island passes clicks through to the apps below.
- Buddy is excluded from screen capture exactly like the compact and workspace windows, and the verify suite proves it.
- Works on Windows and on Macs without a notch through a simulated notch pill.
- It should make people say "wow": a living orb, a waveform driven by the real input level, a fluid expand and collapse, and a dark island that fuses with the hardware.

## Non-goals

- No composer in Buddy. Typing stays in the compact window and the workspace.
- No new AI behavior, prompts, or model changes.
- No dragging. Buddy is anchored to the notch band.
- No settings beyond on/off and the keyboard shortcut.

## Anti-goals (failure even if it "works")

- Buddy appears in a screen share or recording path that the other two windows are excluded from.
- Clicking Buddy moves focus away from Zoom, Meet, or Teams.
- Buddy covers menu bar items on Macs without a notch. The collapsed pill stays under 220 points wide and centered, where the menu bar is normally empty.
- Flicker or layout jumps when the island opens.

## How it behaves

### Modes

Derived from the shared snapshot by a pure function (`src/buddy-model.js`), so it is unit tested without Electron.

| Mode | When | Collapsed island shows | Open panel shows |
| --- | --- | --- | --- |
| `off` | Buddy disabled | nothing (window hidden) | |
| `setup` | Whisper not ready or ChatGPT not connected | orb + "Set up Screening" | what is missing, button to open the workspace |
| `idle` | ready, not recording, no answer | breathing orb | mode label, shortcuts, actions |
| `listening` | recording | waveform + elapsed timer | last transcript line, "Answer now" |
| `thinking` | answer requested, no text yet | spinning orb + "Thinking" | question being answered |
| `answer` | latest assistant message has text and was not dismissed | orb + "Answer ready" | the answer, streaming, in reading size |
| `error` | latest assistant message failed and was not dismissed | orb + "Answer failed" | the error text |

Priority when several apply: `off` > `setup` > `thinking` > `answer` > `error` > `listening` > `idle`. The waveform and timer show whenever recording is on, in any mode.

### Opening and closing

- The island opens on hover after 150 ms and closes 500 ms after the pointer leaves.
- A new answer opens the island by itself and keeps it open while text streams. One minute after the answer completes, it closes unless pinned or hovered.
- Clicking the orb pins the island open. Clicking again unpins it.
- Dismiss (the × in the panel) hides the current answer and returns to listening or idle.
- `Cmd/Ctrl+Shift+B` shows or hides Buddy. `Cmd/Ctrl+Shift+Enter` (existing) answers the recent transcript and Buddy displays it.
- "Hide both windows" (`Cmd/Ctrl+Shift+H`) now hides Buddy as well. Recover and the toggle shortcut bring it back.
- Buddy stays visible over fullscreen apps on purpose. Calls are often fullscreen.

### Window mechanics (my call)

Electron, not Swift. One transparent, frameless `BrowserWindow`, 620 by 460 points, fixed at the top center of the primary display:

- `alwaysOnTop` at the `screen-saver` level so it draws above the menu bar and fullscreen spaces.
- `type: "panel"`, `visibleOnAllWorkspaces` with `visibleOnFullScreen`, `hiddenInMissionControl`, `skipTaskbar`.
- `focusable: false` so clicks never move focus away from the meeting app.
- `setContentProtection` follows the shared protection switch like the other two windows.
- `setIgnoreMouseEvents(true, { forward: true })` by default. The renderer watches forwarded mouse moves and turns mouse events on only while the pointer is over the island.
- Buddy's media source id joins the exclusion list so it never appears in the window snapshot picker.

### Notch geometry

`src/services/notch.cjs` is pure and tested:

- `parseNotch(json)` reads the helper output.
- `estimateNotch(display)` falls back to a 180 by 32 point notch when the display is internal and its menu bar is at least 30 points tall, otherwise no notch.
- `islandLayout({ display, notch })` returns the window bounds and the CSS variables the renderer needs: notch width and height, wing width, and whether the notch is real.

`scripts/notch-info.swift` is a third tiny helper next to the existing two. It prints the notch rectangle from `NSScreen.auxiliaryTopLeftArea`, `auxiliaryTopRightArea` and `safeAreaInsets` as JSON. `build:native` compiles it and the macOS package bundles it. Without the helper (Windows, CI, missing build), the estimate is used.

Geometry is recomputed when display metrics change.

## How it looks

### Island

- Background `#070709`, the same black as the hardware notch, so the wings read as the notch growing sideways. Top corners square (flush with the screen edge), bottom corners 18 points when collapsed and 22 when open.
- Collapsed height equals the notch height. The gap between the wings is exactly the notch width, so nothing is drawn behind the camera cutout.
- Without a real notch, the gap is zero and the island is a 192 by 30 point pill.
- A 1 pixel inner hairline at 8 percent white and a soft drop shadow lift it from busy content.
- Text is the system font. Labels are 12.5 points medium with slight tracking. The answer is 18 points, line height 1.5, max 60 characters per line.
- Muted text is white at 68 percent, which keeps contrast above 4.5:1 on the island.

### Signature elements

- **Orb.** A 14 point disc (20 when open) with a conic gradient from violet `#7c5cff` through cyan `#36d1ff` and mint `#5cf0b8` back to violet, a soft glow, and a glossy highlight. It breathes when idle (3.6 s), spins when thinking (1.1 s), and swells with the input level when listening.
- **Waveform.** Five 3 point bars driven by the real audio level, each with its own multiplier, 90 ms height transitions.
- **Bloom.** When a new answer arrives, the island's glow pulses once over 600 ms.
- **Reading panel.** A top and bottom fade mask so lines enter and leave softly, like a prompter. While streaming, the panel follows the newest text unless the user has scrolled up.

### Motion

Open: 320 ms with a slight overshoot easing. Close: 200 ms ease-in. `prefers-reduced-motion` removes all animation and transitions.

### Refresh of the existing windows

Keep the structure and ids (the verify suite depends on them). Change the skin:

- Tokens: accent `#3d5af1`, ink `#1b1d22`, muted `#646a74`, surfaces `#f7f7f5` and white, radius 10.
- The orb becomes the brand accent in the compact header, the sidebar, and empty states.
- Primary buttons get a subtle top highlight. Tabs in the compact window become pills. The composer floats as a card with a soft shadow.
- Protection status becomes a pill with a dot in both windows.
- A "Buddy at the notch" switch appears in the workspace settings and the compact settings, with the shortcut next to it. The sidebar shows Buddy's current mode.

## Copy

Three languages (Russian, English, Kazakh), short and literal. English set: "Buddy", "Show Buddy at the notch", "Listening", "Thinking…", "Answer ready", "Answer failed", "Set up Screening", "Answer now", "Copy", "Open Screening", "Keep open", "Auto-hide", "Hide Buddy", "Buddy reads the latest answer here, near your camera."

## Verification

Unit tests (`node --test`): notch parsing, estimate, layout bounds and clamping; every Buddy mode and priority; elapsed formatting; last transcript line.

Verify suite (`npm run verify`), new checks:

- Buddy is content protected, always on top, hidden from Mission Control, and not focusable.
- Buddy's window is centered on the notch band of the primary display at y = 0.
- A synthetic assistant message appears in the reading panel and opens the island; removing it closes the island.
- The Buddy switch hides and restores the window.
- Screenshots `buddy-collapsed.png` and `buddy-open.png` in the validation folder.

## Left to the builder

- Exact wing width and label truncation.
- Whether the error mode shows the full error or the first sentence.
- Pixel values of shadows and glows.
