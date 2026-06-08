import {
  BufferTarget,
  CanvasSource,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  MpegTsOutputFormat,
  Output,
  WebMOutputFormat,
  canEncodeVideo,
} from "mediabunny";

const CODEC_LABELS = {
  av1: "AV1",
  avc: "H.264",
  hevc: "H.265",
  vp8: "VP8",
  vp9: "VP9",
};

const CODEC_BITRATES = {
  av1: 8_000_000,
  avc: 8_000_000,
  hevc: 8_000_000,
  vp8: 6_000_000,
  vp9: 8_000_000,
};

const CONTAINERS = {
  mp4: {
    label: "MP4",
    extension: "mp4",
    format: () => new Mp4OutputFormat(),
    codecs: ["avc", "hevc", "vp9", "av1", "vp8"],
  },
  mov: {
    label: "MOV",
    extension: "mov",
    format: () => new MovOutputFormat(),
    codecs: ["avc", "hevc", "vp9", "av1", "vp8"],
  },
  webm: {
    label: "WebM",
    extension: "webm",
    format: () => new WebMOutputFormat(),
    codecs: ["vp9", "av1", "vp8"],
  },
  mkv: {
    label: "MKV",
    extension: "mkv",
    format: () => new MkvOutputFormat(),
    codecs: ["avc", "hevc", "vp9", "av1", "vp8"],
  },
  ts: {
    label: "MPEG-TS",
    extension: "ts",
    format: () => new MpegTsOutputFormat(),
    codecs: ["avc", "hevc"],
  },
};

export const VIDEO_EXPORT_PRESETS = Object.entries(CONTAINERS).flatMap(([containerId, container]) => (
  container.codecs.map((codec) => ({
    id: `${containerId}-${codec}`,
    container: containerId,
    containerLabel: container.label,
    codec,
    codecLabel: CODEC_LABELS[codec],
    label: `${container.label} ${CODEC_LABELS[codec]}`,
    bitrate: CODEC_BITRATES[codec],
    extension: container.extension,
    filename: `caption-render-${containerId}-${codec}.${container.extension}`,
    format: container.format,
  }))
));

const PRESETS_BY_ID = Object.fromEntries(VIDEO_EXPORT_PRESETS.map((preset) => [preset.id, preset]));
const LEGACY_PRESETS = {
  h264: "mp4-avc",
  h265: "mp4-hevc",
  vp8: "webm-vp8",
  vp9: "webm-vp9",
};

export function getVideoExportPreset(name) {
  return PRESETS_BY_ID[name] ?? PRESETS_BY_ID[LEGACY_PRESETS[name]] ?? PRESETS_BY_ID["mp4-avc"];
}

export async function canUseVideoExportPreset(name, options = {}) {
  const preset = getVideoExportPreset(name);
  return canEncodeVideo(preset.codec, {
    width: options.width,
    height: options.height,
    bitrate: preset.bitrate,
  }).catch(() => false);
}

export function getBestVideoExportPresetId(supportedPresetIds) {
  const preferred = [
    "mp4-avc",
    "webm-vp9",
    "mp4-vp9",
    "webm-av1",
    "mp4-av1",
    "mov-avc",
    "mkv-avc",
    "webm-vp8",
  ];

  const supported = new Set(supportedPresetIds);
  return preferred.find((id) => supported.has(id)) ?? supportedPresetIds[0] ?? "mp4-avc";
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function encodeCanvasVideo({
  canvas,
  durationMs,
  fps = 30,
  encoder = "vp9",
  renderFrame,
}) {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("Video export requires a browser with WebCodecs support.");
  }

  const preset = getVideoExportPreset(encoder);
  const canEncode = await canUseVideoExportPreset(preset.id, {
    width: canvas.width,
    height: canvas.height,
  });

  if (!canEncode) {
    throw new Error(`${preset.label} export is not supported by this browser.`);
  }

  const target = new BufferTarget();
  const output = new Output({
    format: preset.format(),
    target,
  });
  const videoSource = new CanvasSource(canvas, {
    codec: preset.codec,
    bitrate: preset.bitrate,
    keyFrameInterval: 2,
  });

  output.addVideoTrack(videoSource);
  await output.start();

  const frameDurationMs = 1000 / fps;
  const frameDurationSeconds = 1 / fps;
  const frameCount = Math.max(1, Math.ceil(durationMs / frameDurationMs));

  for (let frameIndex = 0; frameIndex <= frameCount; frameIndex += 1) {
    const timeMs = Math.min(durationMs, frameIndex * frameDurationMs);
    renderFrame(canvas, timeMs);
    await videoSource.add(timeMs / 1000, frameDurationSeconds, {
      keyFrame: frameIndex % (fps * 2) === 0,
    });
  }

  videoSource.close();
  await output.finalize();

  return {
    blob: new Blob([target.buffer], { type: await output.getMimeType() }),
    filename: preset.filename,
    extension: preset.extension,
  };
}
