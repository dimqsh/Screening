# Screening 0.6: Buddy is the app

Date: 2026-10-19. Requested by the author in chat: redesign everything, remove the compact window and the large workspace, keep only Buddy, add a menu-bar icon, English only, target audience in the United States. Builds on `2026-10-17-buddy-notch-design.md`.

## Intent

Screening becomes a menu-bar app with one visible surface: Buddy, the island at the notch. Everything the compact window and the workspace did moves into Buddy or into the menu-bar menu. Nothing that worked before is dropped without a replacement.

## Goals

- One visible window. No Dock icon on macOS. A menu-bar icon is the entry point.
- Buddy carries the whole interview flow: setup, listening, asking by typing, window snapshots, answers, transcript, notes, and the user's background.
- English everywhere. Speech and answer language default to English for new installs. Saved settings from older versions still win.
- The look stays the black island fused with the notch, refined into a full app: onboarding, tabs, a composer and a snapshot picker inside the island.
- Capture protection, focus behavior and click-through stay as verified in 0.5.

## Non-goals

- No new AI behavior. The prompt, model and Codex runtime do not change.
- No English-only Whisper model swap. That changes downloads and provenance and belongs in its own change.
- No localization framework. Russian and Kazakh copy is removed.

## Architecture (my calls)

- **Buddy window**: unchanged mechanics. Transparent, non-focusable panel at the notch. Window grows to 760 by 660 points, leaving room for shadows, so the open island can hold the full app.
- **Typing**: Buddy is non-focusable by default so the meeting app keeps keyboard focus. Clicking the composer, or Cmd/Ctrl+Shift+Space, makes Buddy focusable and focuses it. On macOS the panel is non-activating, so the meeting app stays the active app. Sending, Escape or leaving the field makes Buddy non-focusable again.
- **Clipboard keys**: Buddy handles Cmd/Ctrl+V, C, X and A in its text fields through the existing clipboard bridge, because a menu-bar app's edit menu is not reliable from a non-activating panel.
- **Audio engine**: a hidden window with no UI hosts microphone and Windows loopback capture (`audio.js`, `audio-worklet.js`). It is never shown, is sandboxed, and is the only frame allowed to send audio. macOS call audio keeps using the native helper.
- **Tray**: `src/tray-menu.cjs` builds the menu template from state as a pure function, unit tested. `main.cjs` maps item ids to actions. The menu is rebuilt only when its inputs change. While recording, the tray title shows the elapsed time on macOS.
- **Removed files**: `index.html`, `overlay.html`, `renderer.js`, `controls.js`, `style.css`, `i18n.js`, `verify-compact.cjs`.
- **Verify** moves to `src/verify.cjs`. Flags: `--verify`, `--interview-test`, `--audio-test` (replaces `--compact-test`), `--system-audio-test`, `--live-ai-test`, `--vision-test`, `--capture-test`. `--screening-test` checks are folded into `--verify`. Release workflows are updated.

## Buddy, open

Width 600 points. From top to bottom:

1. **Bar** at the notch: orb, and on the right a waveform with timer while listening, otherwise the protection dot.
2. **Header**: status with timer, source switch (Call audio, Microphone), Listen/Stop button, pin, close.
3. **Tabs**: Answer, Transcript, Notes, You.
4. **Content**:
   - Answer: the question, the answer in large teleprompter type, turn navigation (previous, count, next), Copy, New session. Empty state explains the two ways to ask.
   - Transcript: timestamped lines, newest at the bottom, Answer now.
   - Notes: text, "Use in answers" switch.
   - You: background text (role, skills, real wins), Save. Encrypted with the OS key store as before.
5. **Composer**: pending snapshot chip, text field, Snapshot, Paste, Send.

A **snapshot picker** sheet covers the content area with window thumbnails. A **setup** view replaces tabs until Whisper is ready and ChatGPT is signed in: three steps with progress.

Collapsed and auto-open behavior stays as in 0.5. Buddy stays open while the composer has focus or a sheet is open.

## Menu-bar menu

Status line, Start/Stop Listening (call audio, microphone), Answer What Was Just Said, Ask Buddy, Show/Hide Buddy; Interview Type, Answer Length, Answer Automatically, Use Notes in Answers, Speech Language, Answer Language; Hide From Screen Sharing, Test Screen Sharing Protection; speech model and ChatGPT status or actions; Export Session, New Session; Quit.

## Shortcuts

Cmd/Ctrl+Shift+B show or hide Buddy. Cmd/Ctrl+Shift+Space ask. Cmd/Ctrl+Shift+Enter answer what was just said. Cmd/Ctrl+Shift+L start or stop listening.

## Verification

Unit: tray menu builder, Buddy model (turns, setup steps), notch geometry. Electron: only Buddy visible, engine hidden, Dock hidden, tray present, protection, focus toggling for the composer, notes, paste, snapshot rejection, scenes with screenshots, real Whisper through the engine, audio flow through Buddy's controls, capture A/B for Buddy.
