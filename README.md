# Capture Lab

Desktop interview workspace for macOS and Windows: local multilingual Whisper transcription, answers through a signed-in ChatGPT account, candidate context and a floating notes window.

![Workspace with synthetic test text](assets/workspace.png)

## Use

1. Install the DMG (Apple Silicon) or EXE (Windows x64) from this repository’s Releases.
2. Open **Settings → Sign in with ChatGPT**. The bundled official Codex CLI opens a browser. An existing Codex ChatGPT sign-in is reused. Plan eligibility, model availability and account limits apply; this does not turn a ChatGPT subscription into an OpenAI API key.
3. Select **Set up Whisper**. The first run downloads the multilingual `onnx-community/whisper-base` q8 model (about 75 MB of weights plus small tokenizer files). Later transcription runs locally without an internet connection. The model loads again when the app starts.
4. Choose **System audio** for the interviewer’s voice, or **Microphone** for your own voice. Grant the requested operating-system audio/screen permissions, then start recording.
5. Select **Answer**, type a question, or press Cmd/Ctrl+Shift+Enter. Automatic answers are optional. Add your actual experience in **My context** to make behavioral answers relevant.
6. Use **Open compact view** when sharing your desktop. This hides the large workspace and opens the floating window. The main workspace is visible in screen captures.

Interface languages: Russian, English and Kazakh. Speech and answer selectors include automatic language selection and Russian, English, Kazakh, Spanish, French, German, Chinese, Japanese, Ukrainian and Turkish. Automatic speech language detection uses Whisper’s language-token logits. Language availability does not imply equal recognition accuracy; small models can mishear words, especially in noise and weaker-supported languages.

Audio is processed in roughly eight-second chunks. The local queue is bounded; if the device cannot keep up, the app reports an error instead of growing an unlimited buffer. It does not identify speakers. System audio can include sounds from other applications.

## Account and data

ChatGPT sign-in uses the official, bundled `@openai/codex` CLI. Capture Lab never reads or copies OAuth tokens into its UI. Authentication is shared with the local Codex CLI. Sign-in from this app may change the account used by other Codex clients. The CLI owns its login storage and browser flow.

Whisper receives PCM audio locally. The assistant receives the typed question or the latest four transcript chunks, plus candidate context, only when an answer is requested (including optional automatic mode). Requests use ephemeral, read-only Codex execution, ignore user config/plugins/MCP, and disable shell and web tools. No repository is attached. Assistant requests require internet and consume the signed-in account’s Codex allowance. This is an independent prototype, not an OpenAI product.

Raw audio and transcripts are held in memory, not automatically saved. You can export transcript and latest answer as text. Preferences persist locally. Candidate context is encrypted with Electron safeStorage when the OS key store is available; otherwise it remains in memory. Model files and official CLI authentication persist separately. Credentials and models are never distributed with the source or installers.

## Screen capture

The compact window requests native content protection. The workspace does not. The capture experiment compares a magenta marker with protection off and on; a missing unprotected marker is inconclusive. Always check the actual recipient view for your meeting app and recorder.

Historical verification: version 0.1.0 was tested with Google Meet entire built-in-screen sharing on macOS 27.0.1 / Chrome 155. Two independently joined connections on the same Mac showed the overlay with protection off and omitted it with protection on. This was not a second physical device. The 0.2.0 local regression checks cover Electron desktop capture and Apple ScreenCaptureKit; the historical Meet check does not establish every version or capture path. No private meeting screenshots are included in this repository.

Hotkeys:

| Action | Shortcut |
|---|---|
| Show/hide compact window | Cmd/Ctrl+Shift+Space |
| Recover mouse control | Cmd/Ctrl+Shift+R |
| Show workspace | Cmd/Ctrl+Shift+L |
| Answer recent transcript | Cmd/Ctrl+Shift+Enter |

## Development

Node.js 22+, npm. Xcode command-line tools are required to compile the macOS audio/capture helpers.

```sh
npm ci
npm run build:native # macOS; harmless skip on Windows
npm start
npm test
npm run verify
npm run verify:capture # requires screen permission; shows a synthetic marker
npm run package:mac # Apple Silicon DMG, on macOS
npm run package:win # x64 NSIS EXE, on Windows
```

`npm run verify` exercises native protection flags, recovery, IPC validation, editable notes, renderer isolation and interface language switching. To exercise real speech recognition, run `node scripts/prepare-speech-test.cjs`, set `CAPTURE_LAB_TEST_AUDIO` to the absolute `build/jfk.f32` path, and run `npm run verify:interview`. `--live-ai-test` additionally makes one real account-backed request; it requires ChatGPT sign-in.

The Windows release workflow builds a native Windows installer, launches the packaged application and checks actual Whisper transcription of the public JFK sample. It does not establish a Windows meeting-recipient capture result or test the interactive OAuth flow on a Windows user’s account.

Installers are currently unsigned by a publisher certificate; the Mac bundle is ad-hoc signed. macOS Gatekeeper and Windows SmartScreen may require an explicit open/install decision. No auto-update service is enabled.

## Sources and licenses

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth) and [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).
- [Transformers.js audio processing](https://huggingface.co/docs/transformers.js/guides/node-audio-processing), [Whisper base model](https://huggingface.co/onnx-community/whisper-base), [OpenAI Whisper](https://github.com/openai/whisper).
- [Electron content protection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable) and [audio loopback](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts).
- UI copy reviewed with [Peter Yang’s no-ai-slop skill](https://github.com/petergyang/no-ai-slop); workspace layout follows the locally installed ui-ux-pro-max guidance.

Original application code: MIT. Electron: MIT. OpenAI Codex: Apache-2.0. Transformers.js: Apache-2.0. ONNX Runtime: MIT. Whisper weights: Apache-2.0 per the model repository. Dependency license files are retained in the packaged dependencies. No Cluely source, assets or proprietary binaries are included.
