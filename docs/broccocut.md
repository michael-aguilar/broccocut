# Broccocut workflow customizations

This fork carries the playback changes originally tested in a local LosslessCut 3.69.0 installation. The changes now live in the TypeScript/React source and are included by the normal build. The upstream application name and license are retained.

## Playback behavior

- Every embedded audio track is selected when a file opens. Tracks can still be switched individually in the playback menu.
- With multiple audio tracks, the last track defaults to **Left → both ears** when it has two channels. This is a ShadowPlay microphone convention, not automatic microphone detection. Turn it off or select another track in the playback menu if a recording differs.
- The microphone channel mapping also works when that track is played alone. Other tracks retain their normal channel handling, including upstream's channel-layout repair.
- Mixing retains upstream's `normalize=0` behavior, so adding tracks does not divide their volume. Summed loud tracks can still clip; this feature does not add a limiter.
- Supported original video uses native playback and seeking while a hidden audio-only preview mixes the selected tracks. Large jumps can briefly interrupt audio while a new mix starts. Rotation, proxy files, and unsupported video retain the full compatibility preview.
- The preview follows the requested playback speed instead of permanently running at 105%. This prevents accumulating drift and recurring backward corrections.
- Pending preview restarts are cancelled when files or settings change. Buffered audio is reused when seeking within its range; other seeks restart after a short debounce.
- Update checks default to off. An existing profile can retain its saved setting; check Settings when using an older profile. Official release packages do not contain these customizations.

These changes affect preview playback only. Source recordings and lossless export behavior are unchanged, including separate audio tracks in exported clips.

## Source map

| File | Custom behavior |
| --- | --- |
| `src/renderer/src/App.tsx` | Track defaults, mic selection state, native video eligibility, playback labels |
| `src/renderer/src/components/PlaybackStreamSelector.tsx` | Per-track microphone routing control |
| `src/renderer/src/MediaSourcePlayer.tsx` | Audio-only preview, synchronization, seeking, cancellation |
| `src/main/ffmpeg.ts` | Preview channel mapping and short audio-only MP4 fragments |
| `src/main/configStore.ts` | Update-check default |

## Windows development

Use Node.js 24 and the Yarn version checked into this repository. From the repository folder:

```powershell
node .yarn/releases/yarn-4.18.0.cjs install --immutable
node node_modules/electron/install.js
```

The explicit Electron installation is needed because this repository disables dependency install scripts. Put FFmpeg, ffprobe, and their accompanying shared DLLs in `ffmpeg/win32-x64/lib`. The existing Windows development checkout has these copied from the working installation; binaries are ignored by Git. On another computer, use the upstream download command in `CONTRIBUTING.md` or the custom FFmpeg directory setting.

Run the app during development:

```powershell
node .yarn/releases/yarn-4.18.0.cjs dev
```

Check and build the source:

```powershell
node .yarn/releases/yarn-4.18.0.cjs tsc
node .yarn/releases/yarn-4.18.0.cjs lint
node .yarn/releases/yarn-4.18.0.cjs test run
node .yarn/releases/yarn-4.18.0.cjs build
```

Windows checkouts must use LF line endings for source files to satisfy the upstream lint rules. Configure `git config core.autocrlf input` before subsequent checkouts. Do not commit mass line-ending changes.

## Updating from upstream

`origin` is `https://github.com/michael-aguilar/broccocut.git`; `upstream` is `https://github.com/mifi/lossless-cut.git`. A fresh clone only sets up `origin`, so add `upstream` once if needed:

```powershell
git remote add upstream https://github.com/mifi/lossless-cut.git
git fetch upstream --tags
```

Start from a clean working tree, create an update branch, and merge the chosen stable release tag into it. Review any overlapping changes in the five files above, run the checks, and exercise the playback checklist below before merging the update into your working branch. A merge without text conflicts still needs behavioral testing. Keep the last known-good application build until the new one is verified.

## Playback regression checklist

Use a separate test profile and sample recordings. Keep project autosave off during automated checks.

1. Open recordings with zero, one, three, and eight audio tracks; confirm defaults reset on each file change.
2. With a stereo game track and a left-only stereo mic track, confirm game stereo is preserved and the mic is heard in both ears. Solo the mic, disable its routing, and select another track for routing.
3. Scrub rapidly forward and backward, both inside and outside the audio buffer. Confirm the final video/audio position matches the requested position and old previews do not restart.
4. Play continuously for at least 30 seconds after seeking; check for drifting audio or periodic backward jumps.
5. Change playback speed and pause/resume; verify the preview follows the main video.
6. Enable rotation and confirm the full compatibility preview appears; restore the original rotation and confirm native playback returns.
7. Export a lossless sample clip with all source audio tracks selected and confirm the separate tracks remain in the output.

The installed application and generated binaries are not source backups. Commit source changes and push them to the fork when ready.
