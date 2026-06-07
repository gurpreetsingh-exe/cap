const TIMING_SEPARATOR = "-->";
const TIMESTAMP_RE = /^(\d{1,2}:)?(\d{2}):(\d{2})([,.])(\d{1,3})$/;
const TIMING_LINE_RE = /^(?<start>\d{1,2}:?\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(?<end>\d{1,2}:?\d{2}:\d{2}[,.]\d{1,3})(?<settings>.*)$/;

function normalizeSource(source) {
  return String(source ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

function parseTimestamp(timestamp) {
  const value = String(timestamp ?? "").trim();
  const match = value.match(TIMESTAMP_RE);

  if (!match) {
    throw new Error(`Invalid SRT timestamp: ${timestamp}`);
  }

  const hours = match[1] ? Number(match[1].slice(0, -1)) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[5].padEnd(3, "0"));

  if (minutes > 59 || seconds > 59) {
    throw new Error(`Invalid SRT timestamp range: ${timestamp}`);
  }

  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function formatTimestamp(milliseconds, options = {}) {
  const separator = options.decimalSeparator ?? ",";
  const clamped = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const ms = clamped % 1000;

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(ms, 3)}`;
}

function splitBlocks(source) {
  const lines = normalizeSource(source).split("\n");
  const blocks = [];
  let current = [];
  let startLine = 1;

  lines.forEach((line, index) => {
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push({ lines: current, startLine });
        current = [];
      }
      startLine = index + 2;
      return;
    }

    if (current.length === 0) {
      startLine = index + 1;
    }
    current.push(line);
  });

  if (current.length > 0) {
    blocks.push({ lines: current, startLine });
  }

  return blocks;
}

function parseCueBlock(block, position, options) {
  let cursor = 0;
  let index = null;
  let id = null;
  const firstLine = block.lines[0]?.trim() ?? "";

  if (!firstLine.includes(TIMING_SEPARATOR)) {
    if (/^\d+$/.test(firstLine)) {
      index = Number(firstLine);
    } else if (options.allowCueIds) {
      id = firstLine;
    } else {
      throw new Error(`Expected cue index or timing at line ${block.startLine}`);
    }
    cursor = 1;
  }

  const timingLine = block.lines[cursor]?.trim() ?? "";
  const timingMatch = timingLine.match(TIMING_LINE_RE);

  if (!timingMatch?.groups) {
    throw new Error(`Invalid cue timing at line ${block.startLine + cursor}: ${timingLine}`);
  }

  const startMs = parseTimestamp(timingMatch.groups.start);
  const endMs = parseTimestamp(timingMatch.groups.end);
  const textLines = block.lines.slice(cursor + 1);
  const text = textLines.join("\n");
  const settings = timingMatch.groups.settings.trim();

  if (options.requirePositiveDuration && endMs <= startMs) {
    throw new Error(`Cue ${index ?? position} must end after it starts`);
  }

  return {
    index: index ?? position,
    id,
    start: timingMatch.groups.start,
    end: timingMatch.groups.end,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    settings,
    text,
    lines: textLines,
    raw: block.lines.join("\n"),
    startLine: block.startLine,
  };
}

function cueToString(cue, position, options) {
  const index = options.renumber ? position : cue.index ?? position;
  const startMs = cue.startMs ?? parseTimestamp(cue.start);
  const endMs = cue.endMs ?? parseTimestamp(cue.end);
  const settings = options.includeSettings === false || !cue.settings ? "" : ` ${cue.settings}`;
  const text = Array.isArray(cue.lines) ? cue.lines.join(options.eol) : String(cue.text ?? "");

  return [
    String(index),
    `${formatTimestamp(startMs, options)} ${TIMING_SEPARATOR} ${formatTimestamp(endMs, options)}${settings}`,
    text,
  ].join(options.eol);
}

class SRTParser {
  static parse(source, options = {}) {
    const settings = {
      allowCueIds: true,
      requirePositiveDuration: true,
      strict: false,
      sort: false,
      ...options,
    };
    const cues = [];
    const errors = [];

    splitBlocks(source).forEach((block, index) => {
      try {
        cues.push(parseCueBlock(block, index + 1, settings));
      } catch (error) {
        if (settings.strict) {
          throw error;
        }
        errors.push({
          message: error.message,
          startLine: block.startLine,
          raw: block.lines.join("\n"),
        });
      }
    });

    if (settings.sort) {
      cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    }

    return { cues, errors };
  }

  static stringify(cues, options = {}) {
    const settings = {
      decimalSeparator: ",",
      eol: "\n",
      includeSettings: true,
      renumber: true,
      ...options,
    };

    return cues
      .map((cue, index) => cueToString(cue, index + 1, settings))
      .join(`${settings.eol}${settings.eol}`);
  }

  static parseTimestamp(timestamp) {
    return parseTimestamp(timestamp);
  }

  static formatTimestamp(milliseconds, options) {
    return formatTimestamp(milliseconds, options);
  }

  static validate(source, options = {}) {
    const result = SRTParser.parse(source, { ...options, strict: false });
    const warnings = [];

    result.cues.forEach((cue, index, cues) => {
      if (cue.endMs <= cue.startMs) {
        warnings.push({ cue: cue.index, message: "Cue ends before or at its start time" });
      }

      const previous = cues[index - 1];
      if (previous && cue.startMs < previous.endMs) {
        warnings.push({ cue: cue.index, message: `Cue overlaps cue ${previous.index}` });
      }

      if (!cue.text.trim()) {
        warnings.push({ cue: cue.index, message: "Cue has no text" });
      }
    });

    return {
      ok: result.errors.length === 0 && warnings.length === 0,
      cues: result.cues,
      errors: result.errors,
      warnings,
    };
  }

  static shift(cues, offsetMs) {
    return cues.map((cue) => {
      const startMs = Math.max(0, cue.startMs + offsetMs);
      const endMs = Math.max(startMs, cue.endMs + offsetMs);

      return {
        ...cue,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        start: formatTimestamp(startMs),
        end: formatTimestamp(endMs),
      };
    });
  }

  static scale(cues, factor) {
    const value = Number(factor);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("Scale factor must be a positive number");
    }

    return cues.map((cue) => {
      const startMs = Math.round(cue.startMs * value);
      const endMs = Math.round(cue.endMs * value);

      return {
        ...cue,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        start: formatTimestamp(startMs),
        end: formatTimestamp(endMs),
      };
    });
  }

  static atTime(cues, time) {
    const timeMs = typeof time === "string" ? parseTimestamp(time) : Number(time);
    return cues.filter((cue) => cue.startMs <= timeMs && timeMs < cue.endMs);
  }

  static between(cues, start, end) {
    const startMs = typeof start === "string" ? parseTimestamp(start) : Number(start);
    const endMs = typeof end === "string" ? parseTimestamp(end) : Number(end);
    return cues.filter((cue) => cue.endMs > startMs && cue.startMs < endMs);
  }

  static toPlainText(cues, options = {}) {
    const separator = options.separator ?? "\n";
    return cues.map((cue) => cue.text).join(separator);
  }

  static fromPlainText(lines, options = {}) {
    const durationMs = options.durationMs ?? 2_000;
    const gapMs = options.gapMs ?? 250;
    const startMs = options.startMs ?? 0;
    const entries = Array.isArray(lines) ? lines : String(lines ?? "").split(/\r?\n/);

    return entries
      .filter((line) => line.trim() !== "")
      .map((line, index) => {
        const cueStart = startMs + index * (durationMs + gapMs);
        const cueEnd = cueStart + durationMs;

        return {
          index: index + 1,
          id: null,
          start: formatTimestamp(cueStart),
          end: formatTimestamp(cueEnd),
          startMs: cueStart,
          endMs: cueEnd,
          durationMs,
          settings: "",
          text: line,
          lines: [line],
          raw: "",
          startLine: null,
        };
      });
  }
}

globalThis.SRTParser = SRTParser;

// 1
// 00:00:33,843 --> 00:00:38,097
// Only 3% of the water on our planet is fresh.
// 地球上只有3%的水是淡水
//
// 2
// 00:00:40,641 --> 00:00:44,687
// Yet, these precious waters are rich with surprise.
// 可是这些珍贵的淡水中却充满了惊奇

const sampleSrt = `1
00:00:00,000 --> 00:00:02,500
Welcome to the Example Subtitle File!

2
00:00:03,000 --> 00:00:06,000
This is a demonstration of SRT subtitles.

3
00:00:07,000 --> 00:00:10,500
You can use SRT files to add subtitles to your videos.`;

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function createMessage(message, type = "") {
  const element = document.createElement("div");
  element.className = type ? `message ${type}` : "message";
  element.textContent = message;
  return element;
}

function createCueElement(cue) {
  const row = document.createElement("article");
  row.className = "cue";
  row.dataset.cueIndex = String(cue.index);
  row.tabIndex = 0;

  const index = document.createElement("div");
  index.className = "cue-index";
  index.textContent = cue.index;

  const body = document.createElement("div");

  const time = document.createElement("div");
  time.className = "cue-time";

  const range = document.createElement("span");
  range.className = "pill";
  range.textContent = `${SRTParser.formatTimestamp(cue.startMs)} -> ${SRTParser.formatTimestamp(cue.endMs)}`;

  const duration = document.createElement("span");
  duration.textContent = formatDuration(cue.durationMs);

  time.append(range, duration);

  if (cue.settings) {
    const settings = document.createElement("span");
    settings.className = "pill";
    settings.textContent = cue.settings;
    time.append(settings);
  }

  const text = document.createElement("div");
  text.className = cue.text.trim() ? "cue-text" : "cue-text empty-text";
  text.textContent = cue.text.trim() ? cue.text : "Empty subtitle text";

  body.append(time, text);
  row.append(index, body);
  return row;
}

function createTimelineCue(cue, durationMs) {
  const element = document.createElement("button");
  const left = durationMs > 0 ? (cue.startMs / durationMs) * 100 : 0;
  const width = durationMs > 0 ? Math.max(1.4, (cue.durationMs / durationMs) * 100) : 1.4;

  element.type = "button";
  element.className = "timeline-cue";
  element.dataset.cueIndex = String(cue.index);
  element.dataset.startMs = String(cue.startMs);
  element.style.left = `${Math.min(99, left)}%`;
  element.style.width = `${Math.min(100 - left, width)}%`;
  element.title = cue.text;
  element.textContent = cue.text.split("\n")[0] || `Cue ${cue.index}`;
  return element;
}

async function copyText(value) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard copy is not available in this browser context.");
  }

  await navigator.clipboard.writeText(value);
}

function showToast(region, message, type = "") {
  if (!region) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = type ? `toast ${type}` : "toast";
  toast.textContent = message;
  region.append(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 2900);
}

function parseResolution(value) {
  const [width, height] = String(value).split("x").map(Number);
  return {
    width: Number.isFinite(width) ? width : 1280,
    height: Number.isFinite(height) ? height : 720,
  };
}

function drawPreviewFrame(canvas, timeMs) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const seconds = timeMs / 1000;

  const sky = context.createLinearGradient(0, 0, width, height);
  sky.addColorStop(0, `hsl(${205 + Math.sin(seconds * 0.25) * 18}, 70%, 26%)`);
  sky.addColorStop(0.48, "#171c27");
  sky.addColorStop(1, "#080a0f");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  const sunX = width * (0.18 + (seconds * 0.035) % 0.72);
  const sunY = height * (0.24 + Math.sin(seconds * 0.4) * 0.05);
  const sun = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, width * 0.18);
  sun.addColorStop(0, "rgba(255, 221, 135, 0.95)");
  sun.addColorStop(1, "rgba(255, 221, 135, 0)");
  context.fillStyle = sun;
  context.fillRect(0, 0, width, height);

  context.fillStyle = "rgba(255, 255, 255, 0.12)";
  for (let i = 0; i < 8; i += 1) {
    const x = ((seconds * (18 + i * 6) + i * width * 0.19) % (width + 180)) - 120;
    const y = height * (0.18 + (i % 4) * 0.08);
    context.beginPath();
    context.ellipse(x, y, width * 0.045, height * 0.012, 0, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = "#111722";
  context.beginPath();
  context.moveTo(0, height * 0.7);
  for (let x = 0; x <= width; x += width / 8) {
    const y = height * (0.62 + Math.sin(seconds * 0.5 + x * 0.01) * 0.035);
    context.lineTo(x, y);
  }
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  context.fill();

  const road = context.createLinearGradient(0, height * 0.64, 0, height);
  road.addColorStop(0, "#222936");
  road.addColorStop(1, "#0c0f15");
  context.fillStyle = road;
  context.beginPath();
  context.moveTo(width * 0.42, height * 0.66);
  context.lineTo(width * 0.58, height * 0.66);
  context.lineTo(width * 0.82, height);
  context.lineTo(width * 0.18, height);
  context.closePath();
  context.fill();

  context.strokeStyle = "rgba(255, 255, 255, 0.55)";
  context.lineWidth = Math.max(2, width * 0.003);
  context.setLineDash([height * 0.055, height * 0.05]);
  context.lineDashOffset = -seconds * height * 0.12;
  context.beginPath();
  context.moveTo(width * 0.5, height * 0.68);
  context.lineTo(width * 0.5, height);
  context.stroke();
  context.setLineDash([]);

  context.fillStyle = "rgba(255, 255, 255, 0.72)";
  context.font = `${Math.max(14, Math.round(width * 0.018))}px sans-serif`;
  context.fillText(SRTParser.formatTimestamp(timeMs), width * 0.035, height * 0.07);
}

function initSrtUi() {
  const editor = document.querySelector(".editor");
  const input = document.getElementById("srtInput");
  const fileInput = document.getElementById("fileInput");
  const parseBtn = document.getElementById("parseBtn");
  const sampleBtn = document.getElementById("sampleBtn");
  const clearBtn = document.getElementById("clearBtn");
  const copyJsonBtn = document.getElementById("copyJsonBtn");
  const copySrtBtn = document.getElementById("copySrtBtn");
  const cueCount = document.getElementById("cueCount");
  const totalDuration = document.getElementById("totalDuration");
  const issueCount = document.getElementById("issueCount");
  const messages = document.getElementById("messages");
  const cueList = document.getElementById("cueList");
  const toastRegion = document.getElementById("toastRegion");
  const previewCanvas = document.getElementById("previewCanvas");
  const stageArea = document.getElementById("stageArea");
  const videoStage = document.getElementById("videoStage");
  const captionOverlay = document.getElementById("captionOverlay");
  const playPreviewBtn = document.getElementById("playPreviewBtn");
  const previewScrubber = document.getElementById("previewScrubber");
  const previewTime = document.getElementById("previewTime");
  const resolutionSelect = document.getElementById("resolutionSelect");
  const activeCaptionMeta = document.getElementById("activeCaptionMeta");
  const resolutionMeta = document.getElementById("resolutionMeta");
  const renderLengthMeta = document.getElementById("renderLengthMeta");
  const timelineTrack = document.getElementById("timelineTrack");
  const timelinePlayhead = document.getElementById("timelinePlayhead");
  const timelineDuration = document.getElementById("timelineDuration");
  const timelineEndLabel = document.getElementById("timelineEndLabel");
  const captionSizeInput = document.getElementById("captionSizeInput");
  const captionColorInput = document.getElementById("captionColorInput");
  const captionBgSelect = document.getElementById("captionBgSelect");

  if (!input || !parseBtn || !cueList) {
    return;
  }

  let parsedCues = [];
  let previewTimeMs = 0;
  let previewDurationMs = 1;
  let previewPlaying = false;
  let previewStartedAt = 0;
  let previewStartedTime = 0;
  let previewAnimation = null;
  let previewFitAnimation = null;

  function fitPreviewStage() {
    if (!stageArea || !videoStage || !previewCanvas) {
      return;
    }

    const ratio = previewCanvas.width / previewCanvas.height;
    const styles = window.getComputedStyle(stageArea);
    const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const availableWidth = Math.max(1, stageArea.clientWidth - horizontalPadding);
    const availableHeight = Math.max(1, stageArea.clientHeight - verticalPadding);
    let width = availableWidth;
    let height = width / ratio;

    if (height > availableHeight) {
      height = availableHeight;
      width = height * ratio;
    }

    videoStage.style.width = `${Math.max(1, Math.floor(width))}px`;
    videoStage.style.height = `${Math.max(1, Math.floor(height))}px`;
  }

  function schedulePreviewFit() {
    if (previewFitAnimation !== null) {
      window.cancelAnimationFrame(previewFitAnimation);
    }

    previewFitAnimation = window.requestAnimationFrame(() => {
      previewFitAnimation = null;
      fitPreviewStage();
      renderPreview();
    });
  }

  function initPanelResizers() {
    if (!editor) {
      return;
    }

    const splitters = editor.querySelectorAll("[data-splitter]");
    splitters.forEach((splitter) => {
      splitter.addEventListener("pointerdown", (event) => {
        if (window.matchMedia("(max-width: 1120px)").matches) {
          return;
        }

        event.preventDefault();
        splitter.setPointerCapture(event.pointerId);
        splitter.classList.add("active");
        document.body.classList.add("resizing");

        const startX = event.clientX;
        const startY = event.clientY;
        const startCaptions = document.querySelector(".caption-panel")?.getBoundingClientRect().width ?? 340;
        const startProperties = document.querySelector(".properties-panel")?.getBoundingClientRect().width ?? 300;
        const startTimeline = document.querySelector(".timeline-panel")?.getBoundingClientRect().height ?? 178;
        const editorRect = editor.getBoundingClientRect();

        function clamp(value, min, max) {
          return Math.max(min, Math.min(max, value));
        }

        function onPointerMove(moveEvent) {
          const kind = splitter.dataset.splitter;

          if (kind === "left") {
            const next = clamp(startCaptions + moveEvent.clientX - startX, 240, editorRect.width * 0.45);
            editor.style.setProperty("--captions-width", `${Math.round(next)}px`);
          }

          if (kind === "right") {
            const next = clamp(startProperties - (moveEvent.clientX - startX), 230, editorRect.width * 0.42);
            editor.style.setProperty("--properties-width", `${Math.round(next)}px`);
          }

          if (kind === "timeline") {
            const next = clamp(startTimeline - (moveEvent.clientY - startY), 120, editorRect.height * 0.48);
            editor.style.setProperty("--timeline-height", `${Math.round(next)}px`);
          }

          schedulePreviewFit();
        }

        function onPointerUp() {
          splitter.classList.remove("active");
          document.body.classList.remove("resizing");
          splitter.removeEventListener("pointermove", onPointerMove);
          splitter.removeEventListener("pointerup", onPointerUp);
          splitter.removeEventListener("pointercancel", onPointerUp);
        }

        splitter.addEventListener("pointermove", onPointerMove);
        splitter.addEventListener("pointerup", onPointerUp);
        splitter.addEventListener("pointercancel", onPointerUp);
      });
    });
  }

  function setActiveCue(activeCues) {
    const activeIndexes = new Set(activeCues.map((cue) => String(cue.index)));
    document.querySelectorAll(".cue, .timeline-cue").forEach((element) => {
      element.classList.toggle("active", activeIndexes.has(element.dataset.cueIndex));
    });
  }

  function updatePlayhead() {
    if (!timelinePlayhead) {
      return;
    }

    const progress = previewDurationMs > 0 ? previewTimeMs / previewDurationMs : 0;
    timelinePlayhead.style.left = `${Math.max(0, Math.min(100, progress * 100))}%`;
  }

  function seekPreview(timeMs) {
    previewTimeMs = Math.max(0, Math.min(previewDurationMs, timeMs));

    if (previewPlaying) {
      previewStartedAt = performance.now();
      previewStartedTime = previewTimeMs;
    }

    renderPreview();
  }

  function renderTimeline(cues) {
    if (!timelineTrack || !timelinePlayhead) {
      return;
    }

    const items = cues.map((cue) => createTimelineCue(cue, previewDurationMs));
    timelineTrack.replaceChildren(...items, timelinePlayhead);
    updatePlayhead();
  }

  function applyCaptionStyle() {
    const size = Math.max(14, Math.min(96, Number(captionSizeInput?.value) || 30));
    const color = captionColorInput?.value || "#ffffff";
    const background = {
      none: "rgba(0, 0, 0, 0)",
      soft: "rgba(0, 0, 0, 0.42)",
      solid: "rgba(0, 0, 0, 0.72)",
    }[captionBgSelect?.value || "none"];

    document.documentElement.style.setProperty("--caption-size", `${size}px`);
    document.documentElement.style.setProperty("--caption-color", color);
    document.documentElement.style.setProperty("--caption-bg", background);
  }

  function updatePreviewResolution() {
    if (!previewCanvas || !resolutionSelect) {
      return;
    }

    const resolution = parseResolution(resolutionSelect.value);
    previewCanvas.width = resolution.width;
    previewCanvas.height = resolution.height;

    if (videoStage) {
      videoStage.style.aspectRatio = `${resolution.width} / ${resolution.height}`;
    }

    if (resolutionMeta) {
      resolutionMeta.textContent = `${resolution.width} x ${resolution.height}`;
    }

    schedulePreviewFit();
  }

  function renderPreview() {
    if (!previewCanvas || !captionOverlay) {
      return;
    }

    drawPreviewFrame(previewCanvas, previewTimeMs);

    const activeCues = SRTParser.atTime(parsedCues, previewTimeMs);
    const activeText = activeCues.map((cue) => cue.text).filter(Boolean).join("\n");
    captionOverlay.textContent = activeText;

    if (activeCaptionMeta) {
      activeCaptionMeta.textContent = activeCues.length > 0 ? `Cue ${activeCues[0].index}` : "None";
    }

    setActiveCue(activeCues);
    updatePlayhead();

    if (previewScrubber) {
      previewScrubber.max = String(Math.max(1, previewDurationMs));
      previewScrubber.value = String(Math.min(previewTimeMs, previewDurationMs));
    }

    if (previewTime) {
      previewTime.textContent = SRTParser.formatTimestamp(previewTimeMs);
    }
  }

  function stopPreview() {
    previewPlaying = false;
    playPreviewBtn.textContent = "Play";

    if (previewAnimation !== null) {
      window.cancelAnimationFrame(previewAnimation);
      previewAnimation = null;
    }
  }

  function tickPreview(now) {
    previewTimeMs = previewStartedTime + (now - previewStartedAt);

    if (previewTimeMs >= previewDurationMs) {
      previewTimeMs = previewDurationMs;
      renderPreview();
      stopPreview();
      return;
    }

    renderPreview();
    previewAnimation = window.requestAnimationFrame(tickPreview);
  }

  function playPreview() {
    if (parsedCues.length === 0) {
      showToast(toastRegion, "Parse subtitles before previewing.", "error");
      return;
    }

    if (previewTimeMs >= previewDurationMs) {
      previewTimeMs = 0;
    }

    previewPlaying = true;
    previewStartedAt = performance.now();
    previewStartedTime = previewTimeMs;
    playPreviewBtn.textContent = "Pause";
    previewAnimation = window.requestAnimationFrame(tickPreview);
  }

  function updatePreviewDuration(cues) {
    previewDurationMs = Math.max(1, cues.reduce((last, cue) => Math.max(last, cue.endMs), 0));
    previewTimeMs = Math.min(previewTimeMs, previewDurationMs);
    const displayDurationMs = cues.length > 0 ? previewDurationMs : 0;

    if (previewScrubber) {
      previewScrubber.max = String(previewDurationMs);
    }

    if (renderLengthMeta) {
      renderLengthMeta.textContent = formatDuration(displayDurationMs);
    }

    if (timelineDuration) {
      timelineDuration.textContent = SRTParser.formatTimestamp(displayDurationMs);
    }

    if (timelineEndLabel) {
      timelineEndLabel.textContent = SRTParser.formatTimestamp(displayDurationMs);
    }

    renderTimeline(cues);
    renderPreview();
  }

  function setParsed(cues, errors = [], warnings = []) {
    parsedCues = cues;
    cueList.replaceChildren(...cues.map(createCueElement));
    messages.replaceChildren();

    cues.forEach((cue) => {
      if (cue.id) {
        messages.append(createMessage(`Cue ${cue.index} has ID "${cue.id}".`));
      }
    });

    errors.forEach((error) => {
      messages.append(createMessage(`Line ${error.startLine}: ${error.message}`, "error"));
    });

    warnings.forEach((warning) => {
      messages.append(createMessage(`Cue ${warning.cue}: ${warning.message}`, "warning"));
    });

    if (cues.length > 0 && errors.length === 0 && warnings.length === 0) {
      messages.append(createMessage("Parsed successfully with no validation issues."));
    }

    const lastCue = cues.reduce((last, cue) => Math.max(last, cue.endMs), 0);
    cueCount.textContent = String(cues.length);
    totalDuration.textContent = formatDuration(lastCue);
    issueCount.textContent = String(errors.length + warnings.length);
    copyJsonBtn.disabled = cues.length === 0;
    copySrtBtn.disabled = cues.length === 0;
    updatePreviewDuration(cues);
  }

  function parseInput() {
    const source = input.value.trim();

    if (!source) {
      setParsed([]);
      messages.replaceChildren(createMessage("Paste subtitles or load an SRT file to begin."));
      return;
    }

    const validation = SRTParser.validate(source, { sort: false });
    setParsed(validation.cues, validation.errors, validation.warnings);
  }

  parseBtn.addEventListener("click", parseInput);

  sampleBtn.addEventListener("click", () => {
    input.value = sampleSrt;
    parseInput();
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    fileInput.value = "";
    setParsed([]);
    messages.replaceChildren();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      return;
    }

    input.value = await file.text();
    parseInput();
  });

  playPreviewBtn.addEventListener("click", () => {
    if (previewPlaying) {
      stopPreview();
      return;
    }

    playPreview();
  });

  previewScrubber.addEventListener("input", () => {
    previewTimeMs = Number(previewScrubber.value);

    if (previewPlaying) {
      previewStartedAt = performance.now();
      previewStartedTime = previewTimeMs;
    }

    renderPreview();
  });

  resolutionSelect.addEventListener("change", updatePreviewResolution);

  window.addEventListener("resize", () => {
    schedulePreviewFit();
  });

  if (typeof ResizeObserver !== "undefined" && stageArea) {
    const previewResizeObserver = new ResizeObserver(schedulePreviewFit);
    previewResizeObserver.observe(stageArea);
  }

  cueList.addEventListener("click", (event) => {
    const cueElement = event.target.closest(".cue");
    if (!cueElement) {
      return;
    }

    const cue = parsedCues.find((item) => String(item.index) === cueElement.dataset.cueIndex);
    if (cue) {
      seekPreview(cue.startMs);
    }
  });

  cueList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const cueElement = event.target.closest(".cue");
    if (!cueElement) {
      return;
    }

    event.preventDefault();
    const cue = parsedCues.find((item) => String(item.index) === cueElement.dataset.cueIndex);
    if (cue) {
      seekPreview(cue.startMs);
    }
  });

  timelineTrack.addEventListener("click", (event) => {
    const cueElement = event.target.closest(".timeline-cue");
    if (cueElement) {
      seekPreview(Number(cueElement.dataset.startMs));
      return;
    }

    const rect = timelineTrack.getBoundingClientRect();
    const progress = (event.clientX - rect.left) / rect.width;
    seekPreview(progress * previewDurationMs);
  });

  captionSizeInput.addEventListener("input", applyCaptionStyle);
  captionColorInput.addEventListener("input", applyCaptionStyle);
  captionBgSelect.addEventListener("change", applyCaptionStyle);

  copyJsonBtn.addEventListener("click", async () => {
    try {
      await copyText(JSON.stringify(parsedCues, null, 2));
      showToast(toastRegion, "Copied parsed JSON to clipboard.");
    } catch (error) {
      showToast(toastRegion, error.message, "error");
    }
  });

  copySrtBtn.addEventListener("click", async () => {
    try {
      await copyText(SRTParser.stringify(parsedCues));
      showToast(toastRegion, "Copied normalized SRT to clipboard.");
    } catch (error) {
      showToast(toastRegion, error.message, "error");
    }
  });

  input.value = sampleSrt;
  applyCaptionStyle();
  initPanelResizers();
  updatePreviewResolution();
  parseInput();
  schedulePreviewFit();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSrtUi);
  } else {
    initSrtUi();
  }
}
