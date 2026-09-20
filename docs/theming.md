# Broccocut theme

The renderer uses the Broccowav visual theme: Outfit body text, Quicksand headings and controls, forest and cream surfaces, mint actions, and the shared broccoli mark.

- `src/renderer/src/theme.css` owns the light/dark palette, font faces, radii, and focus styling. It maps the editor's existing Radix gray and cyan scales onto the theme so legacy controls inherit the palette.
- `src/renderer/src/colors.ts` exposes shared semantic colors. Primary action backgrounds must be paired with `primaryInkColor` for readable contrast.
- Component CSS modules own layout and interaction states. Keep editor controls compact; preserve monospace timecodes and distinct segment colors. The first segment uses the brand green.
- Fonts and their OFL licenses are bundled in `src/renderer/src/assets/fonts`. The fonts and broccoli mark were copied from the local Broccowav project.

The existing light/dark setting is retained. The opening screen uses a keyboard-accessible Open file button and no longer loads the upstream promotional iframe. Upstream attribution remains in place.

`script/generateIcon.ts` generates macOS, Windows, and Linux application icons from `assets/app-icon.png`, the complete Broccowav icon with its mint rounded-square background (extracted from the installed Broccowav icon). The transparent `broccocolon3.png` remains the in-app mark. Packaged desktop apps use the `broccocut` product name and `com.broccocut.app` application ID. Development launches set the broccoli Dock icon, but macOS still identifies the raw development runtime as Electron; use a packaged `.app` for the native app name.

The source `app-icon.png` is intentionally unpadded. The macOS ICNS and runtime Dock PNG add 100px of transparent space per side at 1024px (an 824px visible tile), matching the measured proportions of the system Calculator icon. Windows and Linux keep their existing sizing. Keep the macOS runtime PNG and ICNS padding in sync so launching the app does not change its Dock size.

For visual checks, inspect the opening screen, a loaded clip, settings, and export options in both themes. Also check the compact window layout and keyboard focus visibility.

For a local macOS app, install dependencies and download the matching FFmpeg binaries, run `yarn build`, then `yarn electron-builder --dir --mac -c.mac.identity=- -c.mac.notarize=false`. This produces a locally signed app under `dist/mac-<architecture>/`; distribution signing and notarization are separate from this local build.
