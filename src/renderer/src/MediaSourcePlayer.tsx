import type { CSSProperties, RefObject, ReactEventHandler, FocusEventHandler } from 'react';
import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import invariant from 'tiny-invariant';
import debounce from 'lodash/debounce.js';
import { FaVideo } from 'react-icons/fa';

import isDev from './isDev';
import type { ChromiumHTMLVideoElement } from './types';
import type { FFprobeStream } from '../../common/ffprobe';
import { getFrameDuration } from './util';
import type { AudioStreamInfo, FfmpegHwAccel } from '../../common/types';

const { compatPlayer: { createMediaSourceStream } } = window.require('@electron/remote').require('./index.js');


async function startPlayback({ path, slaveVideo, masterVideo, videoStreamIndex, audioStreams, leftToBothAudioStreamIndex, seekTo, signal, size, fps, rotate, onCanPlay, onResetNeeded, onWaiting, ffmpegHwaccel }: {
  path: string,
  slaveVideo: ChromiumHTMLVideoElement,
  masterVideo: ChromiumHTMLVideoElement,
  videoStreamIndex?: number | undefined,
  audioStreams: AudioStreamInfo[],
  leftToBothAudioStreamIndex: number | undefined,
  seekTo: number,
  signal: AbortSignal,
  size?: number | undefined,
  fps?: number | undefined,
  rotate: number | undefined,
  onCanPlay: () => void,
  onResetNeeded: () => void,
  onWaiting: () => void,
  ffmpegHwaccel: FfmpegHwAccel,
}) {
  let canPlay = false;
  let bufferEndTime: number | undefined;
  let bufferStartTime = seekTo;
  let mediaSourceProcess: ReturnType<typeof createMediaSourceStream> | undefined;
  let interval: NodeJS.Timeout | undefined;
  let interval2: NodeJS.Timeout | undefined;
  let objectUrl: string | undefined;
  let processChunkTimeout: NodeJS.Timeout;

  signal.addEventListener('abort', () => {
    console.log('Cleanup');
    slaveVideo.pause();
    if (interval != null) clearInterval(interval);
    if (interval2 != null) clearInterval(interval2);
    if (processChunkTimeout != null) clearTimeout(processChunkTimeout);
    mediaSourceProcess?.abort();
    if (objectUrl != null) URL.revokeObjectURL(objectUrl);
    slaveVideo.removeAttribute('src');
  });

  // See chrome://media-internals

  let streamTimestamp: number | undefined;
  let lastRemoveTimestamp = seekTo;

  const setPlaybackRate = (r: number) => {
    const maxAllowedPlaybackRate = 16; // or else we get an error in Chromium
    const newAdjustedRate = Math.min(maxAllowedPlaybackRate, r * masterVideo.playbackRate);
    if (slaveVideo.playbackRate === newAdjustedRate) {
      return false;
    }

    // eslint-disable-next-line no-param-reassign
    slaveVideo.playbackRate = newAdjustedRate;
    return true;
  };

  // A permanent 5% boost accumulates drift and causes periodic backward seeks.
  const setStandardPlaybackRate = () => setPlaybackRate(1);

  setStandardPlaybackRate();

  const codecs: string[] = [];
  if (videoStreamIndex != null) codecs.push('avc1.42C01F');
  if (audioStreams.length > 0) codecs.push('mp4a.40.2');
  const codecTag = codecs.join(', ');

  const mimeCodec = `${videoStreamIndex == null ? 'audio' : 'video'}/mp4; codecs="${codecTag}"`;

  // mp4info sample-file.mp4 | grep Codec
  // https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API/Transcoding_assets_for_MSE
  // https://stackoverflow.com/questions/16363167/html5-video-tag-codecs-attribute
  // https://cconcolato.github.io/media-mime-support/
  // https://github.com/cconcolato/media-mime-support
  // const mimeCodec = 'video/mp4; codecs="avc1.42C01E"'; // Video only
  // const mimeCodec = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'; // Video+audio

  if (!MediaSource.isTypeSupported(mimeCodec)) {
    throw new Error(`Unsupported MIME type or codec: ${mimeCodec}`);
  }

  mediaSourceProcess = createMediaSourceStream({ path, videoStreamIndex, audioStreams, leftToBothAudioStreamIndex, seekTo, size, fps, rotate, ffmpegHwaccel });
  console.log('Waiting for media source process to emit first data...');
  const readChunk = await mediaSourceProcess.promise;
  if (readChunk == null) {
    if (signal.aborted) return;
    throw new Error('Media source process did not initialize');
  }
  if (signal.aborted) return;
  console.log('Media source process emitted first data');

  const mediaSource = new MediaSource();

  // console.log(mediaSource.readyState); // closed
  objectUrl = URL.createObjectURL(mediaSource);
  // eslint-disable-next-line no-param-reassign
  slaveVideo.src = objectUrl;

  await new Promise<void>((resolve) => {
    mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  if (signal.aborted) return;
  // console.log(mediaSource.readyState); // open

  const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
  sourceBuffer.timestampOffset = videoStreamIndex == null ? seekTo : seekTo - getFrameDuration(fps); // subtract 1 frame in order to attempt to avoid this issue: https://github.com/mifi/lossless-cut/issues/2591#issuecomment-3478018458

  signal.addEventListener('abort', () => {
    if (mediaSource.readyState === 'open') {
      try { sourceBuffer.abort(); } catch { /* The buffer may already be detached during a seek. */ }
    }
  });

  const getBufferEndTime = () => {
    if (mediaSource.readyState !== 'open') {
      console.log('mediaSource.readyState was not open, but:', mediaSource.readyState);
      // else we will get: Uncaught DOMException: Failed to execute 'end' on 'TimeRanges': The index provided (0) is greater than or equal to the maximum bound (0).
      return undefined;
    }

    if (sourceBuffer.buffered.length === 0) {
      return undefined;
    }

    // https://developer.mozilla.org/en-US/docs/Web/API/TimeRanges/start
    return sourceBuffer.buffered.end(0);
  };

  let firstChunkReceived = false;

  const processChunk = async () => {
    try {
      const chunk = await readChunk();
      if (chunk == null) {
        console.log('End of stream');
        return;
      }

      if (signal.aborted) return;

      if (!firstChunkReceived) {
        firstChunkReceived = true;
        console.log('First chunk received');
      }

      sourceBuffer.appendBuffer(chunk as BufferSource);
    } catch (err) {
      if (signal.aborted) return;
      console.error('processChunk failed', err);
      processChunkTimeout = setTimeout(processChunk, 1000);
    }
  };

  sourceBuffer.addEventListener('error', (err) => console.error('sourceBuffer error, check DevTools ▶ More Tools ▶ Media', err));

  const handleCanPlay = () => {
    console.log('canplay');
    canPlay = true;
    onCanPlay();
  };
  slaveVideo.addEventListener('canplay', handleCanPlay);

  const handleEnded = () => {
    console.log('ended');
  };
  slaveVideo.addEventListener('ended', handleEnded);

  const handleStalled = () => {
    console.log('stalled');
  };
  slaveVideo.addEventListener('stalled', handleStalled);

  const handleWaiting = () => {
    if (slaveVideo.paused || slaveVideo.ended) return; // we don't care if paused
    console.log('waiting');
    onWaiting();
  };

  slaveVideo.addEventListener('waiting', handleWaiting);

  const handlePlaying = () => {
    console.log('playing');
  };
  slaveVideo.addEventListener('playing', handlePlaying);

  signal.addEventListener('abort', () => {
    slaveVideo.removeEventListener('canplay', handleCanPlay);
    slaveVideo.removeEventListener('ended', handleEnded);
    slaveVideo.removeEventListener('stalled', handleStalled);
    slaveVideo.removeEventListener('waiting', handleWaiting);
    slaveVideo.removeEventListener('playing', handlePlaying);
  });

  sourceBuffer.addEventListener('updateend', ({ timeStamp }) => {
    if (signal.aborted) return;

    streamTimestamp = timeStamp; // apparently this timestamp cannot be trusted much

    const bufferThrottleSec = isDev ? 5 : 10; // how many seconds ahead of playback we want to buffer
    const bufferMaxSec = bufferThrottleSec + (isDev ? 5 : 60); // how many seconds we want to buffer in total (ahead of playback and behind)

    bufferEndTime = getBufferEndTime();

    if (bufferEndTime != null) {
      const bufferedDuration = bufferEndTime - lastRemoveTimestamp;

      if (bufferedDuration > bufferMaxSec && !sourceBuffer.updating) {
        try {
          lastRemoveTimestamp = bufferEndTime;
          const removeTo = bufferEndTime - bufferMaxSec;
          bufferStartTime = removeTo;
          console.log('sourceBuffer remove', 0, removeTo);
          sourceBuffer.remove(0, removeTo); // updateend will be emitted again when this is done
          return;
        } catch (err) {
          console.error('sourceBuffer remove failed', err);
        }
      }

      const bufferAheadSec = bufferEndTime - masterVideo.currentTime;
      if (bufferAheadSec > bufferThrottleSec) {
        console.debug(`buffer ahead by ${bufferAheadSec}, throttling stream read`);
        processChunkTimeout = setTimeout(processChunk, 1000);
        return;
      }
    }

    // make sure we always process the next chunk
    processChunk();
  });

  interval = setInterval(() => {
    if (!canPlay) return;

    if (mediaSource.readyState !== 'open') {
      console.warn('mediaSource.readyState was not open, but:', mediaSource.readyState);
      // else we will get: Uncaught DOMException: Failed to execute 'end' on 'TimeRanges': The index provided (0) is greater than or equal to the maximum bound (0).
      return;
    }

    console.log(`bufferStartTime: ${bufferStartTime}, bufferEndTime: ${bufferEndTime}, master time: ${masterVideo.currentTime}, slave time: ${slaveVideo.currentTime} (diff: ${masterVideo.currentTime - slaveVideo.currentTime}), streamTimestamp: ${streamTimestamp}`);
    // console.log(sourceBuffer.buffered.length, sourceBuffer.buffered.start(0), sourceBuffer.buffered.end(0))

    if (sourceBuffer.buffered.length !== 1) {
      // not sure why this would happen or how to handle this
      console.warn('sourceBuffer.buffered.length was', sourceBuffer.buffered.length);
    }
  }, 1000);

  // Synchronize state between the two video elements
  interval2 = setInterval(async () => {
    try {
      if (signal.aborted) return;
      if (masterVideo.seeking) { slaveVideo.pause(); return; }
      const maxSecAfterBufferToWaitFor = videoStreamIndex == null ? 0.15 : 5;
      if (masterVideo.currentTime < bufferStartTime || (bufferEndTime != null && masterVideo.currentTime - bufferEndTime > maxSecAfterBufferToWaitFor)) {
        console.log('Seeked before/after buffered range, resetting playback');
        onResetNeeded();
        return;
      }

      if (masterVideo.paused || masterVideo.ended) {
        const resolution = 1000;
        if (Math.round(slaveVideo.currentTime * resolution) !== Math.round(masterVideo.currentTime * resolution)) {
          // eslint-disable-next-line no-param-reassign
          slaveVideo.currentTime = masterVideo.currentTime;
        }
      } else { // playing
        // make sure the playback keeps up while playing
        // or when seeking while playing
        // https://stackoverflow.com/questions/23301496/how-to-keep-a-live-mediasource-video-stream-in-sync
        const playbackDiff = masterVideo.currentTime - slaveVideo.currentTime;
        if (Math.abs(playbackDiff) > 1) {
          console.log(`Playback ${playbackDiff > 0 ? 'behind' : 'ahead'} master player time by ${playbackDiff}s, jumping to desired time`);
          // eslint-disable-next-line no-param-reassign
          slaveVideo.currentTime = masterVideo.currentTime;
          setStandardPlaybackRate();
        } else if (playbackDiff != null && playbackDiff > 0.3) {
          // eslint-disable-next-line no-param-reassign
          if (setPlaybackRate(1.5)) {
            console.warn(`Playback behind by ${playbackDiff}s, speeding up playback`);
          }
        } else {
          setStandardPlaybackRate();
        }
      }

      if (slaveVideo.volume !== masterVideo.volume) {
        // eslint-disable-next-line no-param-reassign
        slaveVideo.volume = masterVideo.volume;
      }

      const masterStopped = masterVideo.paused || masterVideo.ended;
      const slaveStopped = slaveVideo.paused || slaveVideo.ended;

      if (slaveStopped && !masterStopped) {
        await slaveVideo.play();
      } else if (!slaveStopped && masterStopped) {
        slaveVideo.pause();
      }
    } catch (err) {
      if (!signal.aborted && !(err instanceof Error && err.name === 'AbortError')) console.error('play/pause failed', err);
    }
  }, 30); // todo requestAnimationFrame?

  // OK, everything initialized and ready to stream!
  processChunk();
}

function MediaSourcePlayer({ rotate, filePath, videoStream, audioStreams, masterVideoRef, mediaSourceQuality, ffmpegHwaccel, leftToBothAudioStreamIndex, nativeVideoPreview }: {
  leftToBothAudioStreamIndex: number | undefined,
  nativeVideoPreview: boolean,
  rotate: number | undefined,
  filePath: string,
  videoStream: FFprobeStream | undefined,
  audioStreams: FFprobeStream[],
  masterVideoRef: RefObject<HTMLVideoElement | null>,
  mediaSourceQuality: number,
  ffmpegHwaccel: FfmpegHwAccel,
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [showCanvas, setShowCanvas] = useState(false);

  const onVideoError = useCallback<ReactEventHandler<HTMLVideoElement>>((error) => {
    console.error('video error', error);
  }, []);

  const audioStreamsForPreview = useMemo(() => audioStreams.map(({ index, channels, channel_layout: channelLayout }) => ({ index, channels, channelLayout })), [audioStreams]);

  useEffect(() => {
    const video = videoRef.current;
    invariant(video != null);

    const masterVideo = masterVideoRef.current;
    invariant(masterVideo != null);

    const canvas = canvasRef.current;
    invariant(canvas != null);

    let abortController: AbortController | undefined;
    let disposed = false;
    let startDebounced: ReturnType<typeof debounce>;
    const restart = () => {
      if (disposed) return;
      abortController?.abort();
      startDebounced();
    };

    const start = async () => {
      if (disposed) return;
      abortController?.abort();
      const controller = new AbortController();
      abortController = controller;

      if (!nativeVideoPreview && video.readyState >= 2 && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      setShowCanvas(!nativeVideoPreview);
      setLoading(true);

      const seekTo = masterVideo.currentTime;

      try {
        let size: number | undefined;
        if (videoStream != null && !nativeVideoPreview) {
          if (mediaSourceQuality === 0) size = 800;
          else if (mediaSourceQuality === 1) size = 420;
        }

        let fps: number | undefined;
        if (!nativeVideoPreview) {
          if (mediaSourceQuality === 0) fps = 30;
          else if (mediaSourceQuality === 1) fps = 15;
        }

        await startPlayback({
          signal: controller.signal,
          path: filePath,
          slaveVideo: video,
          masterVideo,
          videoStreamIndex: nativeVideoPreview ? undefined : videoStream?.index,
          audioStreams: audioStreamsForPreview,
          leftToBothAudioStreamIndex,
          seekTo,
          size,
          fps,
          rotate: nativeVideoPreview ? undefined : rotate,
          onCanPlay: () => {
            if (controller.signal.aborted) return;
            setLoading(false);
            setShowCanvas(false);
          },
          onResetNeeded: restart,
          onWaiting: () => {
            if (!controller.signal.aborted) setLoading(true);
          },
          ffmpegHwaccel,
        });
      } catch (err) {
        if (!controller.signal.aborted) console.error('Preview failed', err);
      }
    };

    startDebounced = debounce(start, nativeVideoPreview ? 120 : 500, { leading: !nativeVideoPreview, trailing: true });
    const onMasterSeeking = () => {
      video.pause();
      const time = masterVideo.currentTime;
      if (!abortController?.signal.aborted) {
        for (let i = 0; i < video.buffered.length; i += 1) {
          if (time >= video.buffered.start(i) && time < video.buffered.end(i) - 0.05) {
            video.currentTime = time;
            return;
          }
        }
      }
      restart();
    };
    const onMasterPlay = () => { startDebounced.flush(); };
    if (nativeVideoPreview) {
      masterVideo.addEventListener('seeking', onMasterSeeking);
      masterVideo.addEventListener('play', onMasterPlay);
    }
    start();
    return () => {
      disposed = true;
      startDebounced.cancel();
      masterVideo.removeEventListener('seeking', onMasterSeeking);
      masterVideo.removeEventListener('play', onMasterPlay);
      abortController?.abort();
    };
  }, [audioStreamsForPreview, ffmpegHwaccel, filePath, masterVideoRef, mediaSourceQuality, rotate, videoStream, leftToBothAudioStreamIndex, nativeVideoPreview]);

  const onFocus = useCallback<FocusEventHandler<HTMLVideoElement>>((e) => {
    // prevent video element from stealing focus in fullscreen mode https://github.com/mifi/lossless-cut/issues/543#issuecomment-1868167775
    e.target.blur();
  }, []);

  const videoStyle = useMemo<CSSProperties>(() => ({
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, display: 'block', width: '100%', height: '100%', objectFit: 'contain', transform: rotate ? `rotate(${rotate}deg)` : undefined,
  }), [rotate]);

  return (
    <div data-native-video-preview={nativeVideoPreview ? 'true' : 'false'} style={{ display: nativeVideoPreview ? 'none' : undefined, width: '100%', height: '100%', left: 0, right: 0, top: 0, bottom: 0, position: 'absolute', overflow: 'hidden', background: 'black', pointerEvents: 'none' }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video style={{ ...videoStyle, visibility: showCanvas ? 'hidden' : 'initial' }} ref={videoRef} playsInline onError={onVideoError} tabIndex={-1} onFocusCapture={onFocus} />
      <canvas style={{ ...videoStyle, display: showCanvas ? 'initial' : 'none' }} ref={canvasRef} />

      {loading && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <FaVideo className="loading-animation" style={{ padding: '1em', background: 'rgba(0,0,0,0.2)', borderRadius: '50%' }} />
        </div>
      )}
    </div>
  );
}

export default memo(MediaSourcePlayer);
