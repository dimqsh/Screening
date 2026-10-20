# Screening

Interview answers at your MacBook notch, right under your camera. Screening listens to the call, transcribes it on your Mac, word by word with Apple's speech recognition on macOS 26 or phrase by phrase with Whisper, and drafts answers through your ChatGPT account. Everything happens in **Buddy**, a black island that grows out of the notch. When you read from Buddy, you are looking almost straight at the camera.

There are no other windows. A small island icon in the menu bar is the way in.

<img src="assets/buddy.png" width="640" alt="Buddy at the notch, showing an answer under the camera" />

## Get started

1. Install Screening.
   - **Mac:** paste this in Terminal. It downloads the newest DMG for your Mac (Apple Silicon or Intel), copies Screening to Applications and opens it.

     ```sh
     curl -fsSL https://raw.githubusercontent.com/dimqsh/Screening/main/install.sh | bash
     ```

     Or download the DMG from [Releases](https://github.com/dimqsh/Screening/releases) (`mac-arm64` for Apple Silicon, `mac-x64` for Intel), drag Screening to Applications, then right-click it and choose **Open** the first time.
   - **Windows (x64):** run the EXE from [Releases](https://github.com/dimqsh/Screening/releases). If SmartScreen warns, choose **More info**, then **Run anyway**.
2. Open Screening. The island icon appears in the menu bar, and Buddy opens at the notch with its setup steps.
3. **Set up speech.** On macOS 26 and later, Apple's on-device speech recognition transcribes most languages live (see [Live transcript](#live-transcript)), so this step is done without a download. If macOS has not downloaded your speech language yet, Screening asks it to and the step shows the progress. Whisper is then optional: download it for Kazakh, **Detect Automatically**, **Transcription → Whisper, Phrase by Phrase**, or as a backup if Apple's transcription stops. Choosing Kazakh, automatic detection or Whisper later brings the step back. On Windows and on macOS 14 and 15, **download the speech model** once. On Apple Silicon Macs Screening uses the Accurate model (Whisper large-v3-turbo, about 1 GB); on other computers it uses the Fast model (Whisper base, 77 MB). You can switch in the menu. After that, transcription works offline.
4. **Sign in with ChatGPT.** The bundled official Codex CLI opens your browser. Your ChatGPT plan, model access and limits apply. This does not turn a ChatGPT subscription into an OpenAI API key.
5. **Allow the microphone and call audio** on a Mac. One button asks for both, and each macOS prompt has an **Allow** button. Screening does not need screen recording on macOS 15 or later. If you turned one down before, System Settings opens on its page; call audio is under **System Audio Recording Only**. You can do this later from the menu, and updates keep both.
6. In Buddy, press **Call audio** to listen to the interviewer, or **Microphone** to listen to yourself. Press it again, now labeled **Stop**, to stop.
7. When the interviewer finishes a question, press Cmd/Ctrl+Shift+Enter. Buddy opens and streams the answer under your camera.

## Buddy

- **Buddy is a character**: a small round face with two eyes. It sleeps until setup is done, looks up and shows a "•••" badge while it thinks, reads along while an answer streams, smiles when the answer is ready, and looks worried if something fails. It blinks now and then, and its eyes follow your pointer.
- **Collapsed**, Buddy sits next to the notch with a green dot that means screen-sharing protection is on. While listening, it shows a waveform that follows the voice and a timer.
- **When an answer arrives**, Buddy opens a quiet reading view: the question and the answer in large type, nothing else. The answer streams in as it is written. It closes a minute after the answer finishes.
- **Answer Speed** in the menu: **Fast**, the default, uses your plan's quick model, with the first words in about 4–6 seconds and the whole answer in about 6. **Best Quality** uses the default model. **Answer Automatically** answers right after a phrase that ends in a question mark, otherwise after 2.5 seconds without new speech.
- **Hover** to open the full island; click Buddy’s face to keep it open. The full island has icon tabs at the top, a card with Buddy and three steps (listen, hear, answer) with the current one lit, four chips (**Call audio**, **Microphone**, **Answer**, **Snapshot**), and four tabs:
  - **Answer**: the latest answer, earlier answers with the arrows, Copy, and a box to type or paste a question.
  - **Transcript**: what was heard, with times, and **Answer what was just said**. With the live transcript, the sentence being spoken shows at the bottom with a caret and changes as words arrive.
  - **Notes**: talking points. Turn on **Use notes in answers** to send them with your questions.
  - **You**: your target role, skills and real wins. Buddy uses only what you write here and never makes up achievements.
- **Snapshot** a window to send a coding task or a diagram. Buddy takes one image, shows it in the box, and sends it with your next message. On macOS 15 and later, Snapshot opens the macOS window picker, so Screening needs no screen recording access; choose the window within about 10 seconds. On macOS 14 and Windows, Buddy shows its own window list.
- Buddy never takes the keyboard on its own, so Zoom, Meet or Teams keeps it. Buddy takes the keyboard only while you type in one of its fields, and gives it back when you send, press Escape or click elsewhere. Outside the island, clicks pass through to the apps below.
- **Drag Buddy by its top bar** to take it off the notch. It becomes a small window you can leave anywhere, and Screening remembers where. **Snap Buddy to the Notch** in the menu puts it back.
- Floating Buddy, and Buddy on screens narrower than 1400 points, use a compact layout: a narrower island with the face and steps above the chips.
- On Windows, and on Macs without a notch, Buddy hangs from the top edge as a small pill.

## The menu-bar menu

Click the island icon in the menu bar for everything else: start or stop listening, answer, ask, show or hide Buddy, **Float Buddy** or **Snap Buddy to the Notch**, **Answer Speed**, **Allow Microphone and Call Audio…** while either is off, interview type, answer length, automatic answers, notes in answers, speech and answer language, **Transcription** (live with Apple, or Whisper) on macOS 26, **Hide From Screen Sharing**, **Test Screen Sharing Protection**, setup status, **Export Session**, **New Session** and **Quit**. While Screening listens, the icon fills in and the menu bar shows the elapsed time.

| Action                       | Shortcut             |
| ---------------------------- | -------------------- |
| Answer what was just said    | Cmd/Ctrl+Shift+Enter |
| Ask Buddy                    | Cmd/Ctrl+Shift+Space |
| Start or stop listening      | Cmd/Ctrl+Shift+L     |
| Show or hide Buddy           | Cmd/Ctrl+Shift+B     |

Shortcuts work in every app. Cmd+Shift+B replaces Chrome’s bookmarks-bar shortcut while Screening runs.

## Languages

The interface is in English. Speech and answers default to English. You can pick automatic detection or Spanish, Chinese, French, German, Japanese, Russian, Ukrainian, Kazakh or Turkish in the menu. Automatic detection uses Whisper’s language-token logits.

**Speech Model** in the menu chooses between two multilingual Whisper models. We tested both on one interview question per language, spoken by the macOS voices for English, Russian, Spanish, German, Ukrainian, Kazakh, Chinese, Japanese and Turkish, plus a real English recording, on an M3 Pro:

| Model | Download | Time per 8-second chunk | Words wrong, average | Ukrainian | Kazakh |
| --- | --- | --- | --- | --- | --- |
| Accurate: large-v3-turbo, 8-bit encoder | about 1 GB | about 3.5 s | 5% | 9% | 25% |
| Fast: base, 8-bit | 77 MB | about 0.7 s | 17% | 36% | not recognized |

Synthetic voices are cleaner than a real call, so expect more errors in noise and with strong accents. The Accurate model needs a fast CPU to keep up with live speech, which is why it is the default only on Apple Silicon.

When Whisper transcribes, audio reaches it phrase by phrase: Screening cuts it at natural pauses, so a phrase is transcribed about half a second after the speaker stops, and a long stretch of speech is cut every 10 seconds. While Whisper works on one phrase, newer ones wait together, so a slower computer gets longer pieces instead of falling behind. Stop sends the remaining audio through Whisper. A bundled Silero detector skips chunks without speech before Whisper runs; it does not tell speakers apart. Call audio can include sound from other apps. On macOS 14.2 and later it comes from a Core Audio tap, which needs only System Audio Recording; before that it goes through ScreenCaptureKit, which needs screen recording.

## Live transcript

On macOS 26 and later, Screening uses Apple's on-device speech recognition (SpeechAnalyzer) instead of Whisper for most languages. Words appear in Buddy's transcript and its "hear" step while the person is still talking, about half a second behind them. Whisper writes nothing until a phrase ends.

- **What uses it.** English, Spanish, French, German, Chinese and Japanese use Apple's newer SpeechTranscriber model. Russian, Ukrainian and Turkish use DictationTranscriber, the model behind macOS dictation; in our tests it wrote no punctuation. Kazakh and **Detect Automatically** use Whisper, and so do macOS 14 and 15, Windows, and **Transcription → Whisper, Phrase by Phrase** in the menu. If Apple's helper stops during a session, Whisper takes over when it is downloaded; otherwise Buddy says so, and listening again restarts Apple.
- **Words that may still change** show at the bottom of the transcript with a caret. Answers use only settled sentences. Pressing **Answer** in the middle of a sentence asks Apple to settle it first, which takes about a tenth of a second. Apple settles words on its own schedule, often two seconds after the speaker stops, so Screening asks it to settle 0.7 s after a sentence that ends in . ? or !, and 1.6 s after anything else. Settling earlier, in the middle of a sentence, cost Apple context: JFK's pause after "ask not" became "ask not. , you, your country".
- **No new permission.** Apple's transcription runs on the Mac and asks for no Speech Recognition access. While the tests ran, macOS's privacy service logged no Speech Recognition check. Listening still needs the microphone or System Audio Recording, as before.
- **Language downloads.** macOS downloads each language once, for every app. Here that took 17–104 s for Spanish, German and Ukrainian; English and Russian were already installed. Until a language is ready, Whisper listens while Screening downloads it in the background, and the **Transcription** menu shows progress. Without Whisper on disk, Screening starts the download when it opens, and setup shows its progress. Apple lets an app keep five languages; choosing a sixth lets go of another, which macOS keeps on disk until it needs the space.
- **Memory.** Whisper does not load while Apple listens. The helper uses about 18 MB and Apple's speech service about 65 MB, compared with 0.7–2.4 GB for a loaded Whisper model.

We measured both engines in real time on an M3 Pro (18 GB, macOS 27.0.1) with other apps running; ranges cover two runs. Each sample was written in 100 ms chunks, as call audio arrives, followed by 3 s of silence: the public JFK recording and one three-sentence interview question per language, spoken by the macOS voices Samantha, Milena, Mónica, Anna, Lesya and Aru.

| Seconds | Apple live | Whisper Fast | Whisper Accurate |
| --- | --- | --- | --- |
| A word on screen after it is spoken, median per sample | 0.3–0.7 | 2.8–5.4 | 11–17 |
| The first word on screen after it is spoken | 0.1–0.8 | 5–10 | 11–21 |
| Settled text after the speaker stops | 0.8–2.0 | 0.9–2.2 | 8–16 |

| Words wrong | Apple live | Whisper Fast | Whisper Accurate |
| --- | --- | --- | --- |
| English, JFK recording | 0% | 5% | 0% |
| English, Samantha | 0% | 0% | 0% |
| Spanish, Mónica | 0% | 16% | 0% |
| German, Anna | 3% | 3% | 7% |
| Russian, Milena | 13% | 17% | 13% |
| Ukrainian, Lesya | 22% | 26% | 26% |
| Kazakh, Aru | not supported | 100% | 86% |

Apple was as accurate as Whisper Accurate or better on every language it supports (Russian and Ukrainian without punctuation, which the word counts ignore), and its words reached the screen 4 to 16 times sooner than with Whisper Fast and 20 to 50 times sooner than with Whisper Accurate. Two things make Whisper look slower here than in a typical call. The macOS voices pause for less than 0.6 s between sentences, so Screening heard each sample as one phrase of up to 10 s; real speakers pause more often. And Whisper Accurate took about 6 s per phrase with other apps busy, against the 3.5 s in the table above, so phrases queued behind each other. Apple's recognition runs in a macOS service and kept its speed under the same load. Apple's `fastResults` option matters: without it, words lagged 2.3–5.3 s behind speech, with the same accuracy. To measure again, run `node scripts/compare-speech.cjs apple`, then `whisper fast` and `whisper accurate`.

## Account and data

ChatGPT sign-in uses the official, bundled `@openai/codex` CLI. Screening never reads or copies OAuth tokens. It keeps its own Codex sign-in and settings in its app data folder, apart from the Codex CLI and app, so their plugins, MCP servers, hooks and memories never run during an interview; updating from 0.7.1 or earlier asks you to sign in once more. The CLI owns its login storage and browser flow.

Whisper and Apple's speech recognition receive audio on your computer. ChatGPT receives the typed question or what was said in the last 45 seconds (at most 10 phrases), your background from the **You** tab, a bounded recent conversation, and notes only when **Use notes in answers** is on. A window snapshot is sent once, with the next message. The temporary image file is removed after the request or when Screening quits. Window thumbnails in the picker stay on your computer. Nothing watches the active window or captures it on a timer. Answers stream from one long-running Codex app server in ephemeral, read-only threads, with shell, web and app tools turned off; any tool request stops the answer. Answers need internet and count against your Codex allowance. Screening is an independent project, not an OpenAI product.

Whisper runs in its own process at a lower CPU priority, so the meeting app and Buddy stay smooth while it works. It loads into memory when you start listening with Whisper, and unloads 90 seconds after you stop or after the last transcription. A loaded model uses about 0.7 GB (Fast) or 2.4 GB (Accurate); an idle Screening uses about 120 MB in total.

Audio, transcripts, answers, notes and snapshots stay in memory and are not saved automatically. Buddy keeps up to 60 messages and six snapshots; ChatGPT gets the latest 12 messages within a 24,000-character budget. Follow-ups use the text history; older snapshots are not sent again. **Export Session** saves the transcript, the conversation and your notes as text. **New Session** clears them. Preferences persist on your computer. Your background is encrypted with the OS key store when one is available; otherwise it stays in memory. The speech model and the Codex sign-in are stored separately and never ship with the source or the installers.

## Screen sharing protection

Buddy asks the operating system to leave it out of screen capture before it first appears. **Test Screen Sharing Protection** in the menu shows a synthetic card in Buddy and compares a magenta marker with protection off and on, on each capture path the system offers. A missing unprotected marker counts as inconclusive. Always check what the other person sees in your meeting app.

Historical results: version 0.1.0 was tested with Google Meet sharing the whole built-in screen on macOS 27.0.1 and Chrome 155. Two connections joined from the same Mac showed the overlay with protection off and left it out with protection on. That was not a second physical device. Version 0.6.0 ran the A/B check on macOS 27: with protection on, both the Electron and the ScreenCaptureKit paths dropped Buddy’s marker. No private meeting screenshots are included in this repository.

The test captures the screen itself, so it is the one feature that asks for screen recording on macOS 15.

Capture exclusion is not a universal bypass. Electron documents that newer macOS ScreenCaptureKit recorders may ignore the flag, and Windows limits the guarantee to supported capture APIs. Screening does not bypass microphone or screen permissions, app security controls or process inspection.

## Development

Node.js 22+ and npm. Xcode command-line tools compile the macOS helpers: window capture, call audio (a Core Audio tap, and ScreenCaptureKit for macOS before 14.2), notch geometry and live speech (`scripts/live-speech.swift`). The live speech helper needs the macOS 26 SDK from Xcode 26; when the default Xcode is older, `build:native` uses a newer `/Applications/Xcode*.app` if there is one, and otherwise skips the helper, so Screening uses Whisper only.

```sh
npm ci
npm run build:native # macOS; skipped on Windows
npm start
npm test
npm run verify
npm run verify:capture # needs screen permission; shows a synthetic marker
npm run package:mac # Apple Silicon DMG, on macOS
npm run package:mac:x64 # Intel DMG, on macOS with either chip
npm run package:win # x64 NSIS EXE, on Windows
```

The app is three pieces. `src/buddy.*` is the only visible window. `src/engine.html` is a hidden window that owns microphone and Windows call-audio capture. `src/main.cjs` runs the menu-bar icon, shortcuts, notch placement and screen-sharing protection; `src/tray-menu.cjs` builds the menu.

`npm run verify` checks that Buddy is the only visible window, the engine stays hidden, there is no Dock icon, the menu-bar icon exists, and protection, focus hand-off, notch placement, floating and snapping back, the speech step with and without Apple's live transcription, the access step, notes, background, paste and English text all work. It saves screenshots of Buddy’s states in `validation/` using synthetic data; no account request is made.

To test real speech, run `node scripts/prepare-speech-test.cjs`, set `CAPTURE_LAB_TEST_AUDIO` to the absolute `build/jfk.f32` path, and run `npm run verify:audio`. `--interview-test` transcribes the public JFK sample with Apple's live transcription, when the Mac has it, starting as if Whisper were not downloaded, and with real Whisper. `--audio-test` presses Buddy’s Microphone chip and feeds the sample through a synthetic MediaStream and a real AudioWorklet in the hidden engine, hides and shows Buddy while it listens, checks that live words reach Buddy while the sample plays (with Apple), and checks the final transcript; it does not test a physical microphone. `--system-audio-test` on macOS expects speech played on the computer after the `native-audio-ready` marker. `--live-ai-test` and `--vision-test` make real ChatGPT requests: the vision test snapshots a synthetic coding task through the OS picker, asks for a solution and a follow-up, and checks Copy.

The macOS release workflow builds each DMG on a Mac of the same architecture, Apple Silicon and Intel, checks that every bundled binary matches it, checks that it is signed with Screening's certificate, and runs `--verify --interview-test` on the app inside the DMG. onnxruntime-node no longer publishes Intel Mac binaries, so the Intel DMG uses the binary from 1.23.2, the last release that had one.

Each installer carries only its own platform's onnxruntime-node and sharp binaries. The `files` patterns in `package.json` leave out the rest, using the platform of the computer that builds it, which is why each package script runs on its own OS. Both release workflows fail if another platform's binaries end up in the app. onnxruntime-web is left out too: transformers.js depends on it for browsers, but its Node build runs Whisper on onnxruntime-node, and so does the Silero VAD speech gate.

The Windows release workflow builds and installs the EXE, then runs `--verify --interview-test` on the installed app. It does not check a meeting recipient’s view or the sign-in flow on a Windows account.

The Mac app is signed with Screening’s own certificate, not an Apple Developer ID, and it is not notarized. macOS remembers the microphone and call audio permissions by that certificate, so updates keep them. Versions before 0.7.1 were ad-hoc signed, so macOS treated every update as a new app. Gatekeeper may still ask you to confirm a DMG downloaded in a browser, and SmartScreen may ask on Windows; `install.sh` removes the download quarantine so the app opens directly. There is no auto-update; run the install line again to update.

`npm run package:mac` signs with `~/.screening-signing/screening-signing.p12` and the password in `password.txt` next to it, or with the `SCREENING_SIGN_P12` (a file path or base64) and `SCREENING_SIGN_PASSWORD` environment variables. Without a certificate, a local build is ad-hoc signed, and a GitHub Actions build fails rather than ship a release that loses everyone’s access. Keep the certificate backed up: a release signed with a different one makes every user allow access again.

## Sources and licenses

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth) and [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).
- [Transformers.js audio processing](https://huggingface.co/docs/transformers.js/guides/node-audio-processing), [Whisper large-v3-turbo](https://huggingface.co/onnx-community/whisper-large-v3-turbo) and [Whisper base](https://huggingface.co/onnx-community/whisper-base) ONNX models, [OpenAI Whisper](https://github.com/openai/whisper), [Silero VAD](https://github.com/snakers4/silero-vad).
- [Electron window sources](https://www.electronjs.org/docs/latest/api/desktop-capturer), [content protection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable), [audio loopback](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts) and [Tray](https://www.electronjs.org/docs/latest/api/tray).
- Copy reviewed with [Peter Yang’s no-ai-slop skill](https://github.com/petergyang/no-ai-slop); layout follows the locally installed ui-ux-pro-max guidance.

Original application code: MIT. Electron: MIT. OpenAI Codex: Apache-2.0. Transformers.js: Apache-2.0. Silero VAD: MIT. ONNX Runtime: MIT. Whisper weights: Apache-2.0 per the model repository. Dependency license files are kept in the packaged dependencies.
