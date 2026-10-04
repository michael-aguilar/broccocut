// Broccocut: "Export for Discord" re-encodes the selected segments into a small,
// widely playable MP4 (H.264 + AAC), downscaled and with all enabled audio tracks mixed into one.
import sum from 'lodash/sum';

import type { FFprobeStream } from '../../common/ffprobe';
import type { DiscordExportSettings, FfmpegHwAccel } from '../../common/types';
import { formatFfmpegNumber, getHwaccelArgs } from '../../common/util';
import { runFfmpeg, runFfmpegWithProgress } from './ffmpeg';
import { maybeMkDeepOutDir } from './hooks/useFfmpegOperations';
import mainApi from './mainApi';

const { extname } = window.require('node:path');
const { stat } = window.require('node:fs/promises');

export interface DiscordRange { start: number, end: number }

export const discordQualities = {
  high: { label: 'High', crf: 20 },
  balanced: { label: 'Balanced', crf: 23 },
  small: { label: 'Small', crf: 27 },
} as const satisfies Record<DiscordExportSettings['quality'], { label: string, crf: number }>;

// Limits the short side of the picture, so portrait clips are handled like landscape ones.
export const discordResolutions = {
  '480p': { label: '480p', shortSide: 480 },
  '720p': { label: '720p', shortSide: 720 },
  '1080p': { label: '1080p', shortSide: 1080 },
  original: { label: 'Original', shortSide: undefined },
} as const satisfies Record<DiscordExportSettings['resolution'], { label: string, shortSide: number | undefined }>;

const audioBitrate = '160k';

export const bytesPerMb = 1024 * 1024;

export const getRangesDuration = (ranges: DiscordRange[]) => sum(ranges.map(({ start, end }) => end - start));

export interface DiscordEncodeParams {
  filePath: string,
  videoStream: Pick<FFprobeStream, 'index'> | undefined,
  audioStreams: Pick<FFprobeStream, 'index'>[],
  /** Same as the player's "left channel to both" option, e.g. for a mic recorded only in the left channel */
  leftToBothAudioStreamIndex: number | undefined,
  rotation: number | undefined,
  ffmpegHwaccel: FfmpegHwAccel,
  settings: Pick<DiscordExportSettings, 'quality' | 'resolution'>,
}

function getScaleFilter(shortSide: number | undefined) {
  // x264 with yuv420p needs even dimensions, so always round down to even, and never upscale.
  const factor = shortSide != null ? `min(1,${shortSide}/min(iw,ih))` : '1';
  return `scale=w='trunc(iw*${factor}/2)*2':h='trunc(ih*${factor}/2)*2'`;
}

export function getDiscordFfmpegArgs({ filePath, videoStream, audioStreams, leftToBothAudioStreamIndex, rotation, ffmpegHwaccel, settings, ranges, outputArgs }: DiscordEncodeParams & {
  ranges: DiscordRange[],
  outputArgs: string[],
}) {
  const hasVideo = videoStream != null;
  const hasAudio = audioStreams.length > 0;
  const { shortSide } = discordResolutions[settings.resolution];

  // Each range is its own (seeked) input, so we can trim, mix and join everything in one pass.
  const inputArgs = ranges.flatMap(({ start, end }) => [
    ...(hasVideo ? getHwaccelArgs(ffmpegHwaccel) : []),
    ...(hasVideo && rotation != null ? [`-display_rotation:${videoStream.index}`, String(360 - rotation)] : []),
    '-ss', formatFfmpegNumber(start),
    '-t', formatFfmpegNumber(end - start),
    '-i', filePath,
  ]);

  const filters: string[] = [];
  const concatInputs: string[] = [];
  ranges.forEach((_range, i) => {
    if (hasVideo) {
      filters.push(`[${i}:${videoStream.index}]${getScaleFilter(shortSide)},format=yuv420p,setsar=1[v${i}]`);
      concatInputs.push(`[v${i}]`);
    }
    if (hasAudio) {
      const audioInputs = audioStreams.map((stream) => {
        if (stream.index !== leftToBothAudioStreamIndex) return `[${i}:${stream.index}]`;
        filters.push(`[${i}:${stream.index}]pan=stereo|c0=c0|c1=c0[lr${i}]`);
        return `[lr${i}]`;
      }).join('');
      // normalize=0 keeps each track at its original volume (e.g. game + mic), instead of dividing by the number of tracks
      filters.push(audioStreams.length > 1
        ? `${audioInputs}amix=inputs=${audioStreams.length}:normalize=0:duration=longest[a${i}]`
        : `${audioInputs}anull[a${i}]`);
      concatInputs.push(`[a${i}]`);
    }
  });
  filters.push(`${concatInputs.join('')}concat=n=${ranges.length}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${hasVideo ? '[v]' : ''}${hasAudio ? '[a]' : ''}`);

  return [
    '-hide_banner',
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    ...(hasVideo ? ['-map', '[v]', '-c:v', 'libx264', '-preset', 'medium', '-crf', String(discordQualities[settings.quality].crf), '-profile:v', 'high'] : []),
    ...(hasAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2'] : []),
    '-map_chapters', '-1',
    ...outputArgs,
  ];
}

export function getDiscordExportArgs(params: DiscordEncodeParams & { ranges: DiscordRange[], outPath: string }) {
  return getDiscordFfmpegArgs({ ...params, outputArgs: ['-movflags', '+faststart', '-f', 'mp4', '-y', params.outPath] });
}

const sampleCount = 5;
const sampleDuration = 3;

// Spread a few short samples evenly over the whole (joined) clip. Short clips are encoded in full.
export function getSampleRanges(ranges: DiscordRange[]) {
  const total = getRangesDuration(ranges);
  if (total <= sampleCount * sampleDuration) return ranges;

  const samples: DiscordRange[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    let t = (total * (i + 0.5)) / sampleCount;
    const range = ranges.find((r) => {
      if (t <= r.end - r.start) return true;
      t -= r.end - r.start;
      return false;
    }) ?? ranges.at(-1)!;
    const start = Math.max(range.start, Math.min(range.start + t - (sampleDuration / 2), range.end - sampleDuration));
    samples.push({ start, end: Math.min(range.end, start + sampleDuration) });
  }
  return samples;
}

/**
 * Encodes a few samples with the real settings and measures them.
 * Returns the expected output size in bytes per second of clip.
 */
export async function estimateDiscordBytesPerSecond({ ranges, signal, ...params }: DiscordEncodeParams & { ranges: DiscordRange[], signal: AbortSignal }) {
  const samples = getSampleRanges(ranges);
  const args = getDiscordFfmpegArgs({ ...params, ranges: samples, outputArgs: ['-f', 'matroska', '-'] });
  const { stdout } = await runFfmpeg(args, { cancelSignal: signal }, { logCli: false });
  return stdout.length / getRangesDuration(samples);
}

// Keep the user's output file name template, but make it obvious which file is the Discord one.
export const getDiscordFileName = (fileName: string) => `${fileName.slice(0, fileName.length - extname(fileName).length)}-discord.mp4`;

export async function runDiscordExport({ outputs, outPaths, outputDir, encodeParams, enableOverwriteOutput, appendFfmpegCommandLog, onProgress }: {
  outputs: DiscordRange[][],
  outPaths: string[],
  outputDir: string,
  encodeParams: DiscordEncodeParams,
  enableOverwriteOutput: boolean,
  appendFfmpegCommandLog: (args: string[]) => void,
  onProgress: (progress: number) => void,
}) {
  const totalDuration = sum(outputs.map((ranges) => getRangesDuration(ranges)));
  let doneDuration = 0;
  const files: { path: string, size: number }[] = [];
  const skippedPaths: string[] = [];

  for (const [i, ranges] of outputs.entries()) {
    const outPath = outPaths[i]!;
    const duration = getRangesDuration(ranges);

    /* eslint-disable no-await-in-loop */
    if (!enableOverwriteOutput && await mainApi.pathExists(outPath)) {
      skippedPaths.push(outPath);
    } else {
      await maybeMkDeepOutDir({ outputDir, fileOutPath: outPath });
      const ffmpegArgs = getDiscordExportArgs({ ...encodeParams, ranges, outPath });
      appendFfmpegCommandLog(ffmpegArgs);
      const progressOffset = doneDuration;
      await runFfmpegWithProgress({ ffmpegArgs, duration, onProgress: (p: number) => onProgress((progressOffset + (p * duration)) / totalDuration) });
      files.push({ path: outPath, size: (await stat(outPath)).size });
    }
    /* eslint-enable no-await-in-loop */

    doneDuration += duration;
  }

  return { files, skippedPaths };
}
