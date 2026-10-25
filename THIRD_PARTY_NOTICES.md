# Third-party notices

Framewave uses these packages for browser bundling and video export:

| Package | Version | Declared license | Use |
|---|---:|---|---|
| `@ffmpeg/ffmpeg` | 0.12.15 | MIT | Web Worker interface to FFmpeg |
| `@ffmpeg/util` | 0.12.2 | MIT | Browser helpers for the FFmpeg worker |
| `@ffmpeg/core` | 0.12.10 | GPL-2.0-or-later | FFmpeg WebAssembly core |
| `signalsmith-stretch` | 1.3.2 | MIT | Real-time pitch-preserving audio processing for Auto-Tune preview |
| `@tauri-apps/cli` | 2.12.4 | Apache-2.0 OR MIT | Desktop packaging and Windows installer generation |
| `tauri` / `tauri-build` | 2.x | Apache-2.0 OR MIT | Native desktop shell and build integration |
| `vite` | 8.3.4 | MIT | Production asset bundling |

The FFmpeg core is GPL-licensed. Serving its WebAssembly binary to other computers or distributing a packaged build can create source-availability, attribution, and license-compatibility obligations. Review the exact FFmpeg build configuration, linked codecs, and distribution model before shipping; do not assume every codec is covered by the same license. The dependency sources and license files are present in `node_modules` after `npm install`.

All imported media is processed in the user's browser. It is not uploaded to the Framewave server.
