# Framewave Studio: project status and roadmap

Framewave Studio is an original browser-based video and audio editor. Its workspace takes inspiration from the broad media-bin, viewer, timeline, and inspector workflow found in professional nonlinear editors such as DaVinci Resolve. It does not use Resolve code, branding, or assets.

## Implemented

### Workstation UI

- Media, Edit, and Audio navigation switches the workspace layout. Edit prioritizes timeline space; Audio focuses the audio tracks and inspector. These are layout modes over the same editing tools, not separate application modules.

### Projects and timeline

- Version 7 `.framewave` projects store sources, positioned/trimmable clips, optional linked audio/video clip groups, per-audio-clip noise reduction and Auto-Tune settings, track mixer settings, sequence settings, color values, styled titles, and explicit cut/fade transitions. Versions 1–6 migrate on open.
- A Tauri Windows desktop package is configured for a per-user NSIS installer. The Windows CI workflow builds the installer, publishes it on version tags, and stages it beside the web bundle so the browser app can show a Windows download link when the installer is deployed. The package skeleton is present, but no installer has yet been built on Windows.
- IndexedDB autosaves project edits and imported media blobs in the current browser profile. Portable project files keep media as references; another device must import matching files to relink them.
- Timeline editing includes clip move/trim, split-at-playhead (S), Ctrl/Cmd multi-selection, link/unlink for video/audio clips, edge/grid snapping, ripple deletion and right trim, track creation/reordering, zoom, playhead seek, J/K/L shuttle playback, arrow-key frame stepping, and up to 60 undo snapshots.
- Sequence playback uses a shared Web Audio clock when the audio mix is available, quantizes transport time and video seek targets to sequence frames, and reports decoder-dropped frames when the browser exposes video-frame callbacks. Audio tracks support decoded waveforms, clip/track gain, fades, live key/scale-based Auto-Tune preview for monophonic sources, noise-reduction settings for export, mute/solo, meters, and a 48 kHz mix context when supported.

### Video and export prototype

- Video sources get generated library thumbnails. Sequence profiles store an even-pixel canvas size, frame rate, and pixel aspect ratio.
- Video clips support brightness, contrast, saturation, hue, styled title overlays (size, typeface, weight, color, position, and optional text box), and fade-from/to-black transitions. Timeline preview and export composite active video clips in track order and apply their clip styles and fades; export also mixes separate audio-track clips.
- Selected video sources can be separated into a silent H.264 MP4 and an AAC M4A audio file from the first embedded audio stream; both outputs are validated and offered as separate downloads in the inspector.
- Export uses a bundled single-thread FFmpeg WebAssembly core, with sequence, web 720p, and high-quality 1080p H.264/AAC MP4 presets, progress, cancellation, user-visible errors, and a decode check of the resulting output.
- Automated tests cover timeline math, project migration/validation, and render-plan generation. A native FFmpeg smoke test verified a generated sample plan and MP4.

## Known limits and next work

- Professional-studio parity is a long-term product goal, not something this browser prototype currently provides. The next major engineering milestone is a robust media/timeline/render architecture before expanding tool count: compositor-backed frame-accurate playback, scalable proxy/cache management, recoverable projects, a shared effect graph for preview/export, and deterministic render validation.
- Timeline time is advanced from the shared audio clock when possible, and each displayed seek target is aligned to the selected frame rate. Browser HTML video decoders still control actual frame presentation, so preview is **not guaranteed frame-accurate**; independent decoders can fall behind on high-resolution or many-layer sequences. Dropped-frame telemetry depends on browser `requestVideoFrameCallback` support; export remains the deterministic composition path.
- Video transitions are limited to fades from/to black; there is no transition library, keyframing, or general effects graph.
- Audio placed on audio tracks is mixed; audio embedded inside video files is currently muted during sequence playback/export. Separate audio imports are required. Audio decode/waveform generation skips files over 80 MiB.
- Audio clip noise reduction uses FFmpeg's `afftdn` filter on export only; timeline playback does not preview the effect. Strong reduction can degrade speech and should be adjusted by listening to exported tests.
- Auto-Tune uses the MIT-licensed Signalsmith Stretch Web Audio/WASM engine and a background pitch-analysis worker. Live preview and export apply detected note corrections to a selected key/scale while preserving clip duration. Export splits the analyzed pitch curve into FFmpeg pitch-shift segments, so its sound can differ from the live preview. It is best suited to a single vocal or other monophonic source; polyphonic material may be corrected unpredictably. Analysis and export are limited to audio files up to 80 MiB; live preview additionally requires localhost or trusted HTTPS.
- Browser export is memory intensive and limited to 256 MiB of source media per sequence. Supported input codecs depend on the bundled FFmpeg core; long, high-resolution exports may exceed browser memory or run slowly. The actual WASM export path still needs browser testing across target browsers and representative codecs.
- The bundled `@ffmpeg/core` package declares GPL-2.0-or-later. Review the exact codec build and source/license obligations before distributing or hosting the renderer; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
- There is no proxy workflow, recovery-point history, content-hash relinking, video-audio routing, arbitrary keyframe automation, or project media packaging.
- Higher-end finishing tools are not implemented: multi-camera editing, advanced transitions/compositing, motion tracking, professional color management and scopes, a title/motion-graphics system, surround/bus routing, plugin hosting, and collaborative review.
- Linked clips must be selected as an aligned video/audio pair using Ctrl/Cmd-click; J/K/L shuttle is video-only, while normal-speed playback uses the audio mix.
- Accessibility, localization, mobile/touch layout, and browser compatibility remain unfinished. Windows installer generation has not yet been run on a Windows host; the package remains unsigned, and a Windows SmartScreen warning is expected until code signing is set up.
- Browser storage is local to one device, browser, and site address. Clearing site data removes autosave and cached media; quota depends on the browser.

## Run on Ubuntu or the LAN

- Install Node.js 22 or newer and Python 3, then run `npm install` once in the project folder.
- Run `npm start`; this builds the browser bundle (including the FFmpeg WASM files) and starts the Python server.
- Open <http://localhost:8765> on Ubuntu. For another computer on the same trusted Wi-Fi/LAN, open `http://<ubuntu-lan-ip>:8765`; find the address with `hostname -I`.
- The built-in LAN server uses HTTP, so Auto-Tune's live preview will not work when opened by LAN IP. Use localhost on the same computer or deploy behind trusted HTTPS to enable it.
- Keep the terminal running; press Ctrl+C to stop the server. The server exposes only the built app assets and roadmap, but has no login or HTTPS. Use only on a trusted private network and do not forward port 8765.
- Imported media and exports stay in the user's browser; the server does not receive media uploads.

## Build the Windows desktop version

- On Windows 10/11, install Node.js 22 or newer, Rust via rustup, and Microsoft C++ Build Tools with the MSVC workload.
- Run `npm ci`, then `npm run desktop:dev` to launch the desktop shell against the local Vite server.
- Run `npm run desktop:build:windows` to create a per-user NSIS installer under `src-tauri/target/release/bundle/nsis/`.
- Pushing a `v*` tag runs `.github/workflows/windows-desktop.yml`, uploads the installer and browser bundle, and attaches the installer to a GitHub Release. Deploy the generated `dist/` bundle alongside the browser site to make its Windows download link appear.
- The desktop app stores its autosave/media cache separately from the browser version. Move edits between them using `.framewave` project files and re-import media when prompted. WebView2 is required; current Windows 10/11 versions generally provide it or the installer can bootstrap it.
- The Windows installer is currently unsigned. Users may see a SmartScreen prompt until a code-signing certificate is configured.

## Reference

- DaVinci Resolve product overview: <https://www.blackmagicdesign.com/products/davinciresolve>
