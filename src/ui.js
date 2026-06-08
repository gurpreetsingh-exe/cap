import { sampleSrt } from "./sample-srt.js";
import { SRTParser } from "./srt-parser.js";
import { drawPreviewFrame, renderSubtitleFrame } from "./subtitle-renderer.js";
import {
  VIDEO_EXPORT_PRESETS,
  canUseVideoExportPreset,
  downloadBlob,
  encodeCanvasVideo,
  getBestVideoExportPresetId,
} from "./video-export.js";

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

export function initSrtUi() {
  const editor = document.querySelector(".editor");
  const input = document.getElementById("srtInput");
  const fileInput = document.getElementById("fileInput");
  const parseBtn = document.getElementById("parseBtn");
  const sampleBtn = document.getElementById("sampleBtn");
  const clearBtn = document.getElementById("clearBtn");
  const copyJsonBtn = document.getElementById("copyJsonBtn");
  const copySrtBtn = document.getElementById("copySrtBtn");
  const exportSubtitlePngBtn = document.getElementById("exportSubtitlePngBtn");
  const exportVideoBtn = document.getElementById("exportVideoBtn");
  const cueCount = document.getElementById("cueCount");
  const totalDuration = document.getElementById("totalDuration");
  const issueCount = document.getElementById("issueCount");
  const messages = document.getElementById("messages");
  const cueList = document.getElementById("cueList");
  const toastRegion = document.getElementById("toastRegion");
  const previewCanvas = document.getElementById("previewCanvas");
  const stageArea = document.getElementById("stageArea");
  const videoStage = document.getElementById("videoStage");
  const subtitleCanvas = document.getElementById("subtitleCanvas");
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
  const encoderSelect = document.getElementById("encoderSelect");

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
  let exportPresetRefreshId = 0;
  let captionFontsReady = false;
  let captionFontsPromise = null;
  let timelineScrubbing = false;

  function updateFontDependentActions() {
    playPreviewBtn.disabled = !captionFontsReady || parsedCues.length === 0;
    exportSubtitlePngBtn.disabled = !captionFontsReady || parsedCues.length === 0;
    exportVideoBtn.disabled = !captionFontsReady || parsedCues.length === 0 || encoderSelect?.disabled;
  }

  function waitForCaptionFonts() {
    if (!document.fonts) {
      captionFontsReady = true;
      updateFontDependentActions();
      return Promise.resolve();
    }

    if (!captionFontsPromise) {
      captionFontsPromise = Promise.all([
        document.fonts.load("800 34px Manrope"),
        document.fonts.load("italic 400 38px \"DM Serif Display\""),
      ])
        .then(() => document.fonts.ready)
        .catch(() => undefined)
        .then(() => {
          captionFontsReady = true;
          updateFontDependentActions();
          renderPreview();
        });
    }

    return captionFontsPromise;
  }

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

  function getTimelineTime(clientX) {
    const rect = timelineTrack.getBoundingClientRect();
    const progress = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.max(0, Math.min(1, progress)) * previewDurationMs;
  }

  function scrubTimeline(clientX) {
    seekPreview(getTimelineTime(clientX));
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
    renderPreview();
  }

  function getCaptionRenderOptions() {
    return {
      background: document.documentElement.style.getPropertyValue("--caption-bg").trim(),
      color: document.documentElement.style.getPropertyValue("--caption-color").trim(),
      fontSize: Math.max(18, Math.min(96, Number(captionSizeInput?.value) || 34)),
    };
  }

  async function refreshVideoExportPresets() {
    if (!encoderSelect || !resolutionSelect) {
      return;
    }

    const refreshId = ++exportPresetRefreshId;
    const previousValue = encoderSelect.value;
    const resolution = parseResolution(resolutionSelect.value);
    encoderSelect.disabled = true;

    const supportEntries = await Promise.all(VIDEO_EXPORT_PRESETS.map(async (preset) => ({
      preset,
      supported: await canUseVideoExportPreset(preset.id, resolution),
    })));

    if (refreshId !== exportPresetRefreshId) {
      return;
    }

    const supportedIds = supportEntries
      .filter((entry) => entry.supported)
      .map((entry) => entry.preset.id);
    const nextValue = supportedIds.includes(previousValue)
      ? previousValue
      : getBestVideoExportPresetId(supportedIds);
    const groups = new Map();

    supportEntries.forEach((entry) => {
      const group = groups.get(entry.preset.containerLabel) ?? [];
      group.push(entry);
      groups.set(entry.preset.containerLabel, group);
    });

    const children = [];
    groups.forEach((entries, label) => {
      const group = document.createElement("optgroup");
      group.label = label;

      entries.forEach(({ preset, supported }) => {
        const option = document.createElement("option");
        option.value = preset.id;
        option.textContent = supported ? preset.codecLabel : `${preset.codecLabel} (unsupported)`;
        option.disabled = !supported;
        group.append(option);
      });

      children.push(group);
    });

    encoderSelect.replaceChildren(...children);
    encoderSelect.value = nextValue;
    encoderSelect.disabled = supportedIds.length === 0;

    if (exportVideoBtn) {
      exportVideoBtn.disabled = !captionFontsReady || parsedCues.length === 0 || supportedIds.length === 0;
    }
  }

  function renderCompositedFrame(targetCanvas, timeMs) {
    const scratchSubtitleCanvas = document.createElement("canvas");
    scratchSubtitleCanvas.width = targetCanvas.width;
    scratchSubtitleCanvas.height = targetCanvas.height;

    drawPreviewFrame(targetCanvas, timeMs);

    const activeCues = SRTParser.atTime(parsedCues, timeMs);
    const activeText = activeCues
      .map((cue) => cue.text)
      .filter(Boolean)
      .join("\n");
    const primaryCue = activeCues[0];

    renderSubtitleFrame(scratchSubtitleCanvas, activeText, {
      ...getCaptionRenderOptions(),
      progress: primaryCue ? (timeMs - primaryCue.startMs) / Math.max(1, primaryCue.durationMs) : 0,
    });
    targetCanvas.getContext("2d").drawImage(scratchSubtitleCanvas, 0, 0);
  }

  async function exportSubtitlePng() {
    if (!subtitleCanvas || parsedCues.length === 0) {
      return;
    }

    await waitForCaptionFonts();
    renderPreview();

    subtitleCanvas.toBlob((blob) => {
      if (!blob) {
        showToast(toastRegion, "Could not render subtitle PNG.", "error");
        return;
      }

      downloadBlob(blob, `subtitle-${SRTParser.formatTimestamp(previewTimeMs).replaceAll(":", "-").replace(",", "-")}.png`);
      showToast(toastRegion, "Exported transparent subtitle PNG.");
    }, "image/png");
  }

  async function exportVideo() {
    if (parsedCues.length === 0 || !resolutionSelect) {
      return;
    }

    const resolution = parseResolution(resolutionSelect.value);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = resolution.width;
    exportCanvas.height = resolution.height;

    try {
      stopPreview();
      await waitForCaptionFonts();
      exportVideoBtn.disabled = true;
      exportVideoBtn.textContent = "Encoding...";
      showToast(toastRegion, "Encoding video export.");

      const result = await encodeCanvasVideo({
        canvas: exportCanvas,
        durationMs: previewDurationMs,
        fps: 30,
        encoder: encoderSelect?.value ?? "vp9",
        renderFrame: renderCompositedFrame,
      });

      downloadBlob(result.blob, result.filename);
      showToast(toastRegion, `Exported ${result.extension.toUpperCase()} video.`);
    } catch (error) {
      showToast(toastRegion, error.message || "Video export failed.", "error");
    } finally {
      exportVideoBtn.textContent = "Export Video";
      updateFontDependentActions();
    }
  }

  function updatePreviewResolution() {
    if (!previewCanvas || !subtitleCanvas || !resolutionSelect) {
      return;
    }

    const resolution = parseResolution(resolutionSelect.value);
    previewCanvas.width = resolution.width;
    previewCanvas.height = resolution.height;
    subtitleCanvas.width = resolution.width;
    subtitleCanvas.height = resolution.height;

    if (videoStage) {
      videoStage.style.aspectRatio = `${resolution.width} / ${resolution.height}`;
    }

    if (resolutionMeta) {
      resolutionMeta.textContent = `${resolution.width} x ${resolution.height}`;
    }

    schedulePreviewFit();
    refreshVideoExportPresets();
  }

  function renderPreview() {
    if (!previewCanvas || !subtitleCanvas) {
      return;
    }

    drawPreviewFrame(previewCanvas, previewTimeMs);
    const subtitleContext = subtitleCanvas.getContext("2d");

    if (!captionFontsReady) {
      subtitleContext.clearRect(0, 0, subtitleCanvas.width, subtitleCanvas.height);
    }

    const activeCues = SRTParser.atTime(parsedCues, previewTimeMs);
    const activeText = activeCues.map((cue) => cue.text).filter(Boolean).join("\n");
    const primaryCue = activeCues[0];

    if (captionFontsReady) {
      renderSubtitleFrame(subtitleCanvas, activeText, {
        ...getCaptionRenderOptions(),
        progress: primaryCue ? (previewTimeMs - primaryCue.startMs) / Math.max(1, primaryCue.durationMs) : 0,
      });
    }

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

  async function playPreview() {
    if (parsedCues.length === 0) {
      showToast(toastRegion, "Parse subtitles before previewing.", "error");
      return;
    }

    playPreviewBtn.disabled = true;
    await waitForCaptionFonts();
    playPreviewBtn.disabled = false;

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
    updateFontDependentActions();
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

  timelineTrack.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    timelineScrubbing = true;
    timelineTrack.setPointerCapture(event.pointerId);
    timelineTrack.classList.add("scrubbing");
    scrubTimeline(event.clientX);
  });

  timelineTrack.addEventListener("pointermove", (event) => {
    if (!timelineScrubbing) {
      return;
    }

    event.preventDefault();
    scrubTimeline(event.clientX);
  });

  function stopTimelineScrub(event) {
    if (!timelineScrubbing) {
      return;
    }

    timelineScrubbing = false;
    timelineTrack.classList.remove("scrubbing");

    if (timelineTrack.hasPointerCapture(event.pointerId)) {
      timelineTrack.releasePointerCapture(event.pointerId);
    }
  }

  timelineTrack.addEventListener("pointerup", stopTimelineScrub);
  timelineTrack.addEventListener("pointercancel", stopTimelineScrub);
  timelineTrack.addEventListener("lostpointercapture", () => {
    timelineScrubbing = false;
    timelineTrack.classList.remove("scrubbing");
  });

  captionSizeInput.addEventListener("input", applyCaptionStyle);
  captionColorInput.addEventListener("input", applyCaptionStyle);
  captionBgSelect.addEventListener("change", applyCaptionStyle);

  exportSubtitlePngBtn.addEventListener("click", exportSubtitlePng);
  exportVideoBtn.addEventListener("click", exportVideo);

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
  updateFontDependentActions();
  waitForCaptionFonts();
  refreshVideoExportPresets();
  updatePreviewResolution();
  parseInput();
  schedulePreviewFit();
}
