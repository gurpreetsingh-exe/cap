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

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function initSrtUi() {
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

  if (!input || !parseBtn || !cueList) {
    return;
  }

  let parsedCues = [];

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

  copyJsonBtn.addEventListener("click", async () => {
    await copyText(JSON.stringify(parsedCues, null, 2));
  });

  copySrtBtn.addEventListener("click", async () => {
    await copyText(SRTParser.stringify(parsedCues));
  });

  input.value = sampleSrt;
  parseInput();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSrtUi);
  } else {
    initSrtUi();
  }
}
