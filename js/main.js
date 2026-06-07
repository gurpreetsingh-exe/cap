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

  context.fillStyle = "#111";
  context.fillRect(0, 0, width, height);

  context.fillStyle = "rgba(255, 255, 255, 0.72)";
  context.font = `${Math.max(14, Math.round(width * 0.018))}px sans-serif`;
  context.fillText(SRTParser.formatTimestamp(timeMs), width * 0.035, height * 0.07);
}

function wrapSubtitleLine(context, line, maxWidth) {
  const words = line.split(/\s+/);
  const lines = [];
  let current = "";

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      return;
    }

    lines.push(current);
    current = word;
  });

  if (current) {
    lines.push(current);
  }

  return lines;
}

function roundRectPath(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function parseSubtitleTokens(text) {
  const rawWords = text.split(/\s+/).filter(Boolean);
  const normalizedWords = rawWords.map((word) => normalizeEmphasisWord(word));
  const emphasizedIndexes = findEmphasisWordIndexes(normalizedWords);

  return rawWords
    .map((rawWord, index) => {
      const explicit = /^(?:\*\*|__|<b>|<strong>)/i.test(rawWord)
        || /(?:\*\*|__|<\/b>|<\/strong>)$/i.test(rawWord);
      const clean = rawWord
        .replace(/<\/?(?:b|strong|i|em)>/gi, "")
        .replace(/^[*_]+|[*_]+$/g, "")
        .trim();

      return {
        text: clean,
        emphasis: explicit || emphasizedIndexes.has(index),
      };
    })
    .filter((token) => token.text);
}

function normalizeEmphasisWord(word) {
  return word
    .replace(/<\/?(?:b|strong|i|em)>/gi, "")
    .replace(/^[*_]+|[*_]+$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%$€£¥]/g, "");
}

function findEmphasisWordIndexes(words) {
  const stopwords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for",
    "from", "how", "i", "if", "in", "is", "it", "its", "just", "of", "on", "or",
    "our", "so", "that", "the", "their", "this", "to", "true", "was", "we", "you",
    "your", "with",
  ]);
  const suffixes = ["ful", "less", "ous", "ive", "al", "ic", "ing", "ed"];
  const candidates = words
    .map((word, index) => {
      if (!word || stopwords.has(word)) {
        return { index, score: -Infinity };
      }

      let score = 0;

      if (/[\d%$€£¥]/.test(word)) score += 5;
      if (word.length >= 8) score += 4;
      if (word.length >= 6) score += 2;
      if (suffixes.some((suffix) => word.endsWith(suffix))) score += 2;
      if (index === words.length - 1) score += 2;
      if (index > 0 && stopwords.has(words[index - 1])) score += 1;
      if (!stopwords.has(word)) score += 1;

      return { index, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);

  const maxHighlights = words.length <= 4 ? 1 : 2;
  return new Set(candidates.slice(0, maxHighlights).map((candidate) => candidate.index));
}

function buildKellySubtitleLines(context, tokens, maxWidth) {
  const lines = [];
  let line = [];

  tokens.forEach((token, index) => {
    const candidate = [...line, { ...token, index }];
    const candidateText = candidate.map((item) => item.text).join(" ");

    if (candidate.length <= 3 && context.measureText(candidateText).width <= maxWidth) {
      line = candidate;
      return;
    }

    if (line.length > 0) {
      lines.push(line);
    }

    line = [{ ...token, index }];
  });

  if (line.length > 0) {
    lines.push(line);
  }

  return lines.map((items) => {
    const parts = [];
    items.forEach((item, index) => {
      if (index > 0) {
        parts.push({ text: " ", spacer: true });
      }
      parts.push({
        text: item.text,
        wordIndex: item.index,
        highlight: item.emphasis,
      });
    });
    return parts;
  });
}

function visibleKellyParts(parts, activeWordIndex) {
  return parts.filter((part, index) => {
    if (!part.spacer) {
      return part.wordIndex <= activeWordIndex;
    }

    const previous = parts[index - 1];
    const next = parts[index + 1];
    return previous?.wordIndex <= activeWordIndex && next?.wordIndex <= activeWordIndex;
  });
}

function measureKellyParts(context, parts, baseFont, highlightFont) {
  return parts.reduce((sum, part) => {
    context.font = part.highlight ? highlightFont : baseFont;
    return sum + context.measureText(part.text).width;
  }, 0);
}

function getKelly2Style(width, height, options) {
  const fontSize = options.fontSize ?? Math.round(height * 0.075);
  return {
    fontSize,
    lineHeight: Math.round(fontSize * 0.98),
    maxTextWidth: width * 0.68,
    bottom: height * 0.28,
    baseFont: `800 ${fontSize}px Manrope, "Avenir Next", "Inter Tight", "Helvetica Neue", Arial, sans-serif`,
    highlightFont: `italic 400 ${Math.round(fontSize * 1.1)}px "DM Serif Display", Georgia, serif`,
    outlineWidth: Math.max(3, Math.min(5, fontSize * 0.075)),
    shadowBlur: 7,
    shadowOffsetY: 3,
    shadowOpacity: 0.55,
    highlightColor: options.highlightColor || "#11d9e6",
    baseColor: options.color || "#ffffff",
  };
}

function renderSubtitleFrame(canvas, text, options = {}) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const style = getKelly2Style(width, height, options);

  context.clearRect(0, 0, width, height);

  if (!text.trim()) {
    return;
  }

  context.font = style.baseFont;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";

  const tokens = parseSubtitleTokens(text);
  const cueProgress = Number.isFinite(options.progress) ? Math.max(0, Math.min(0.999, options.progress)) : 0;
  const revealPosition = cueProgress * Math.max(1, tokens.length);
  const activeWordIndex = Math.min(tokens.length - 1, Math.floor(revealPosition));
  const lines = buildKellySubtitleLines(context, tokens, style.maxTextWidth);

  const blockHeight = lines.length * style.lineHeight;
  const yStart = height - style.bottom - blockHeight / 2 + style.lineHeight / 2;
  const visibleLines = lines
    .map((line) => visibleKellyParts(line, activeWordIndex))
    .filter((line) => line.length > 0);

  if (visibleLines.length > 0 && options.background && options.background !== "rgba(0, 0, 0, 0)") {
    const widest = Math.min(
      style.maxTextWidth,
      Math.max(...visibleLines.map((line) => measureKellyParts(context, line, style.baseFont, style.highlightFont))),
    );
    const paddingX = style.fontSize * 0.58;
    const paddingY = style.fontSize * 0.28;
    const boxWidth = widest + paddingX * 2;
    const boxHeight = visibleLines.length * style.lineHeight + paddingY * 2;
    const boxX = (width - boxWidth) / 2;
    const boxY = height - style.bottom - visibleLines.length * style.lineHeight - paddingY;

    context.fillStyle = options.background;
    roundRectPath(context, boxX, boxY, boxWidth, boxHeight, Math.max(2, style.fontSize * 0.08));
    context.fill();
  }

  lines.forEach((line, index) => {
    const visibleLine = visibleKellyParts(line, activeWordIndex);
    if (visibleLine.length === 0) {
      return;
    }

    const y = yStart + index * style.lineHeight;
    const lineWidth = measureKellyParts(context, line, style.baseFont, style.highlightFont);
    let x = (width - lineWidth) / 2;

    line.forEach((part) => {
      context.font = part.highlight ? style.highlightFont : style.baseFont;
      const partWidth = context.measureText(part.text).width;
      const centerX = x + partWidth / 2;
      const partY = part.highlight ? y + style.fontSize * 0.03 : y;

      const revealAlpha = Math.max(0, Math.min(1, (revealPosition - part.wordIndex) / 0.18));

      if (part.spacer || revealAlpha <= 0) {
        x += partWidth;
        return;
      }

      context.save();
      context.globalAlpha = revealAlpha;
      context.font = part.highlight ? style.highlightFont : style.baseFont;
      context.shadowColor = `rgba(0, 0, 0, ${style.shadowOpacity})`;
      context.shadowBlur = style.shadowBlur;
      context.shadowOffsetY = style.shadowOffsetY;
      context.fillStyle = part.highlight ? style.highlightColor : style.baseColor;
      context.fillText(part.text, centerX, partY);
      context.restore();

      context.save();
      context.globalAlpha = revealAlpha;
      context.strokeStyle = "#000000";
      context.lineWidth = part.highlight ? Math.max(2, style.outlineWidth * 0.72) : style.outlineWidth;
      context.font = part.highlight ? style.highlightFont : style.baseFont;
      context.strokeText(part.text, centerX, partY);
      context.fillStyle = part.highlight ? style.highlightColor : style.baseColor;
      context.fillText(part.text, centerX, partY);
      context.restore();
      x += partWidth;
    });
  });
}

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });

  return result;
}

function ebmlId(hex) {
  const clean = hex.replaceAll(" ", "");
  const bytes = [];

  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }

  return new Uint8Array(bytes);
}

function ebmlSize(size) {
  for (let length = 1; length <= 8; length += 1) {
    const max = 2 ** (7 * length) - 1;
    if (size <= max) {
      const bytes = new Uint8Array(length);
      let value = size;

      for (let i = length - 1; i >= 0; i -= 1) {
        bytes[i] = value & 0xff;
        value = Math.floor(value / 256);
      }

      bytes[0] |= 1 << (8 - length);
      return bytes;
    }
  }

  throw new Error("EBML element is too large");
}

function ebmlUInt(value) {
  let length = 1;
  while (value >= 2 ** (8 * length) && length < 8) {
    length += 1;
  }

  const bytes = new Uint8Array(length);
  let next = value;

  for (let i = length - 1; i >= 0; i -= 1) {
    bytes[i] = next & 0xff;
    next = Math.floor(next / 256);
  }

  return bytes;
}

function ebmlFloat64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

function ebmlString(value) {
  return new TextEncoder().encode(value);
}

function ebmlElement(id, payload) {
  const body = Array.isArray(payload) ? concatBytes(payload) : payload;
  return concatBytes([ebmlId(id), ebmlSize(body.length), body]);
}

function ebmlMaster(id, children) {
  return ebmlElement(id, children);
}

function webmSimpleBlock(chunk, clusterTimecodeMs) {
  const relativeTime = Math.round(chunk.timecodeMs - clusterTimecodeMs);
  const header = new Uint8Array(4);
  header[0] = 0x81;
  new DataView(header.buffer).setInt16(1, relativeTime, false);
  header[3] = chunk.keyFrame ? 0x80 : 0x00;
  return ebmlElement("A3", [header, chunk.data]);
}

function muxWebM({ chunks, codec, width, height, durationMs, fps }) {
  const codecId = codec.startsWith("vp09") ? "V_VP9" : "V_VP8";
  const timecodeScale = 1_000_000;
  const defaultDuration = Math.round(1_000_000_000 / fps);
  const ebmlHeader = ebmlMaster("1A45DFA3", [
    ebmlElement("4286", ebmlUInt(1)),
    ebmlElement("42F7", ebmlUInt(1)),
    ebmlElement("42F2", ebmlUInt(4)),
    ebmlElement("42F3", ebmlUInt(8)),
    ebmlElement("4282", ebmlString("webm")),
    ebmlElement("4287", ebmlUInt(4)),
    ebmlElement("4285", ebmlUInt(2)),
  ]);

  const info = ebmlMaster("1549A966", [
    ebmlElement("2AD7B1", ebmlUInt(timecodeScale)),
    ebmlElement("4D80", ebmlString("Caption Editor")),
    ebmlElement("5741", ebmlString("Caption Editor")),
    ebmlElement("4489", ebmlFloat64(durationMs)),
  ]);

  const video = ebmlMaster("E0", [
    ebmlElement("B0", ebmlUInt(width)),
    ebmlElement("BA", ebmlUInt(height)),
  ]);

  const track = ebmlMaster("AE", [
    ebmlElement("D7", ebmlUInt(1)),
    ebmlElement("73C5", ebmlUInt(1)),
    ebmlElement("83", ebmlUInt(1)),
    ebmlElement("23E383", ebmlUInt(defaultDuration)),
    ebmlElement("86", ebmlString(codecId)),
    video,
  ]);

  const tracks = ebmlMaster("1654AE6B", [track]);
  const clusters = [];
  let clusterTimecodeMs = -1;
  let clusterBlocks = [];

  chunks.forEach((chunk) => {
    if (clusterTimecodeMs < 0 || chunk.timecodeMs - clusterTimecodeMs >= 5000) {
      if (clusterBlocks.length > 0) {
        clusters.push(ebmlMaster("1F43B675", [
          ebmlElement("E7", ebmlUInt(clusterTimecodeMs)),
          ...clusterBlocks,
        ]));
      }

      clusterTimecodeMs = Math.round(chunk.timecodeMs);
      clusterBlocks = [];
    }

    clusterBlocks.push(webmSimpleBlock(chunk, clusterTimecodeMs));
  });

  if (clusterBlocks.length > 0) {
    clusters.push(ebmlMaster("1F43B675", [
      ebmlElement("E7", ebmlUInt(clusterTimecodeMs)),
      ...clusterBlocks,
    ]));
  }

  const segment = ebmlMaster("18538067", [info, tracks, ...clusters]);
  return new Blob([concatBytes([ebmlHeader, segment])], { type: "video/webm" });
}

function asciiBytes(value) {
  return new TextEncoder().encode(value);
}

function mp4U8(value) {
  return new Uint8Array([value & 0xff]);
}

function mp4U16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

function mp4U24(value) {
  return new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function mp4U32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function mp4Fixed16(value) {
  return mp4U32(Math.round(value * 65536));
}

function mp4Box(type, parts = []) {
  const body = concatBytes(parts);
  return concatBytes([mp4U32(body.length + 8), asciiBytes(type), body]);
}

function mp4FullBox(type, version, flags, parts = []) {
  return mp4Box(type, [mp4U8(version), mp4U24(flags), ...parts]);
}

function mp4Matrix() {
  return concatBytes([
    mp4Fixed16(1), mp4U32(0), mp4U32(0),
    mp4U32(0), mp4Fixed16(1), mp4U32(0),
    mp4U32(0), mp4U32(0), mp4U32(0x40000000),
  ]);
}

function mp4VisualSampleEntry(codecBoxType, codecConfigBoxType, codecConfig, width, height) {
  const compressorName = new Uint8Array(32);
  return mp4Box(codecBoxType, [
    new Uint8Array(6),
    mp4U16(1),
    new Uint8Array(16),
    mp4U16(width),
    mp4U16(height),
    mp4Fixed16(72),
    mp4Fixed16(72),
    mp4U32(0),
    mp4U16(1),
    compressorName,
    mp4U16(0x18),
    mp4U16(0xffff),
    mp4Box(codecConfigBoxType, [codecConfig]),
  ]);
}

function muxMP4({ chunks, codec, codecConfig, width, height, fps }) {
  if (!codecConfig) {
    throw new Error("MP4 export requires codec configuration metadata.");
  }

  const sampleCount = chunks.length;
  const mediaTimescale = 90_000;
  const movieTimescale = 1000;
  const sampleDelta = Math.round(mediaTimescale / fps);
  const mediaDuration = sampleCount * sampleDelta;
  const movieDuration = Math.round((mediaDuration / mediaTimescale) * movieTimescale);
  const sampleSizes = chunks.map((chunk) => chunk.data.length);
  const sampleData = concatBytes(chunks.map((chunk) => chunk.data));
  const ftyp = mp4Box("ftyp", [
    asciiBytes("isom"),
    mp4U32(0x200),
    asciiBytes("isom"),
    asciiBytes("iso2"),
    asciiBytes(codec.startsWith("avc1") ? "avc1" : codec.slice(0, 4)),
    asciiBytes("mp41"),
  ]);
  const mdatHeaderSize = 8;
  const mdat = mp4Box("mdat", [sampleData]);
  let sampleOffset = ftyp.length + mdatHeaderSize;
  const chunkOffsets = sampleSizes.map((size) => {
    const offset = sampleOffset;
    sampleOffset += size;
    return offset;
  });
  const codecBoxType = codec.startsWith("avc1") ? "avc1" : codec.slice(0, 4);
  const codecConfigBoxType = codec.startsWith("avc1") ? "avcC" : "hvcC";
  const syncSamples = chunks
    .map((chunk, index) => (chunk.keyFrame ? index + 1 : 0))
    .filter(Boolean);

  const mvhd = mp4FullBox("mvhd", 0, 0, [
    mp4U32(0), mp4U32(0), mp4U32(movieTimescale), mp4U32(movieDuration),
    mp4Fixed16(1), mp4U16(0x0100), mp4U16(0), new Uint8Array(8),
    mp4Matrix(), new Uint8Array(24), mp4U32(2),
  ]);
  const tkhd = mp4FullBox("tkhd", 0, 0x000007, [
    mp4U32(0), mp4U32(0), mp4U32(1), mp4U32(0), mp4U32(movieDuration),
    new Uint8Array(8), mp4U16(0), mp4U16(0), mp4U16(0), mp4U16(0),
    mp4Matrix(), mp4Fixed16(width), mp4Fixed16(height),
  ]);
  const mdhd = mp4FullBox("mdhd", 0, 0, [
    mp4U32(0), mp4U32(0), mp4U32(mediaTimescale), mp4U32(mediaDuration),
    mp4U16(0x55c4), mp4U16(0),
  ]);
  const hdlr = mp4FullBox("hdlr", 0, 0, [
    mp4U32(0), asciiBytes("vide"), new Uint8Array(12), asciiBytes("VideoHandler\0"),
  ]);
  const vmhd = mp4FullBox("vmhd", 0, 1, [mp4U16(0), mp4U16(0), mp4U16(0), mp4U16(0)]);
  const dref = mp4FullBox("dref", 0, 0, [mp4U32(1), mp4FullBox("url ", 0, 1)]);
  const dinf = mp4Box("dinf", [dref]);
  const stsd = mp4FullBox("stsd", 0, 0, [
    mp4U32(1),
    mp4VisualSampleEntry(codecBoxType, codecConfigBoxType, codecConfig, width, height),
  ]);
  const stts = mp4FullBox("stts", 0, 0, [mp4U32(1), mp4U32(sampleCount), mp4U32(sampleDelta)]);
  const stss = mp4FullBox("stss", 0, 0, [mp4U32(syncSamples.length), ...syncSamples.map(mp4U32)]);
  const stsc = mp4FullBox("stsc", 0, 0, [mp4U32(1), mp4U32(1), mp4U32(1), mp4U32(1)]);
  const stsz = mp4FullBox("stsz", 0, 0, [mp4U32(0), mp4U32(sampleCount), ...sampleSizes.map(mp4U32)]);
  const stco = mp4FullBox("stco", 0, 0, [mp4U32(chunkOffsets.length), ...chunkOffsets.map(mp4U32)]);
  const stbl = mp4Box("stbl", [stsd, stts, stss, stsc, stsz, stco]);
  const minf = mp4Box("minf", [vmhd, dinf, stbl]);
  const mdia = mp4Box("mdia", [mdhd, hdlr, minf]);
  const trak = mp4Box("trak", [tkhd, mdia]);
  const moov = mp4Box("moov", [mvhd, trak]);

  return new Blob([ftyp, mdat, moov], { type: "video/mp4" });
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
    renderPreview();
  }

  function getCaptionRenderOptions() {
    return {
      background: document.documentElement.style.getPropertyValue("--caption-bg").trim(),
      color: document.documentElement.style.getPropertyValue("--caption-color").trim(),
      fontSize: Math.max(18, Math.min(96, Number(captionSizeInput?.value) || 34)),
    };
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

  async function pickVideoEncoderConfig(width, height, fps, encoder) {
    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
      return null;
    }

    const candidatesByEncoder = {
      vp9: [{
        codec: "vp09.00.10.08",
        width,
        height,
        bitrate: 8_000_000,
        framerate: fps,
      }],
      vp8: [{
        codec: "vp8",
        width,
        height,
        bitrate: 6_000_000,
        framerate: fps,
      }],
      h264: [
        {
          codec: "avc1.640028",
          width,
          height,
          bitrate: 8_000_000,
          framerate: fps,
          avc: { format: "avc" },
        },
        {
          codec: "avc1.42E01E",
          width,
          height,
          bitrate: 6_000_000,
          framerate: fps,
          avc: { format: "avc" },
        },
      ],
      h265: [
        {
          codec: "hvc1.1.6.L120.B0",
          width,
          height,
          bitrate: 8_000_000,
          framerate: fps,
          hevc: { format: "hevc" },
        },
        {
          codec: "hev1.1.6.L120.B0",
          width,
          height,
          bitrate: 8_000_000,
          framerate: fps,
          hevc: { format: "hevc" },
        },
      ],
    };
    const candidates = candidatesByEncoder[encoder] ?? candidatesByEncoder.vp9;

    for (const config of candidates) {
      const support = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (support.supported) {
        return support.config;
      }
    }

    return null;
  }

  function exportSubtitlePng() {
    if (!subtitleCanvas || parsedCues.length === 0) {
      return;
    }

    subtitleCanvas.toBlob((blob) => {
      if (!blob) {
        showToast(toastRegion, "Could not render subtitle PNG.", "error");
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `subtitle-${SRTParser.formatTimestamp(previewTimeMs).replaceAll(":", "-").replace(",", "-")}.png`;
      link.click();
      URL.revokeObjectURL(url);
      showToast(toastRegion, "Exported transparent subtitle PNG.");
    }, "image/png");
  }

  async function exportVideoWithMediaRecorder() {
    if (parsedCues.length === 0 || !resolutionSelect) {
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      showToast(toastRegion, "Video export is not supported in this browser.", "error");
      return;
    }

    const resolution = parseResolution(resolutionSelect.value);
    const fps = 30;
    const frameDurationMs = 1000 / fps;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = resolution.width;
    exportCanvas.height = resolution.height;

    const stream = exportCanvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
    const chunks = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    const done = new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
    });

    stopPreview();
    exportVideoBtn.disabled = true;
    exportVideoBtn.textContent = "Rendering...";
    showToast(toastRegion, "Rendering video export.");

    recorder.start();

    for (let timeMs = 0; timeMs <= previewDurationMs; timeMs += frameDurationMs) {
      renderCompositedFrame(exportCanvas, timeMs);
      await new Promise((resolve) => window.setTimeout(resolve, frameDurationMs));
    }

    recorder.stop();
    await done;

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "caption-render.webm";
    link.click();
    URL.revokeObjectURL(url);

    exportVideoBtn.textContent = "Export Video";
    exportVideoBtn.disabled = parsedCues.length === 0;
    showToast(toastRegion, "Exported video with rendered subtitles.");
  }

  async function exportVideoWithWebCodecs() {
    if (parsedCues.length === 0 || !resolutionSelect) {
      return false;
    }

    const resolution = parseResolution(resolutionSelect.value);
    const fps = 30;
    const frameDurationMs = 1000 / fps;
    const frameDurationUs = Math.round(frameDurationMs * 1000);
    const selectedEncoder = encoderSelect?.value ?? "vp9";
    const config = await pickVideoEncoderConfig(resolution.width, resolution.height, fps, selectedEncoder);

    if (!config) {
      return false;
    }

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = resolution.width;
    exportCanvas.height = resolution.height;

    const chunks = [];
    let codecConfig = null;
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);

        if (metadata?.decoderConfig?.description) {
          codecConfig = new Uint8Array(metadata.decoderConfig.description);
        }

        chunks.push({
          data,
          keyFrame: chunk.type === "key",
          timecodeMs: chunk.timestamp / 1000,
        });
      },
      error: (error) => {
        throw error;
      },
    });

    stopPreview();
    exportVideoBtn.disabled = true;
    exportVideoBtn.textContent = "Encoding...";
    showToast(toastRegion, "Encoding video with WebCodecs.");

    encoder.configure(config);

    const frameCount = Math.max(1, Math.ceil(previewDurationMs / frameDurationMs));

    for (let frameIndex = 0; frameIndex <= frameCount; frameIndex += 1) {
      const timeMs = Math.min(previewDurationMs, frameIndex * frameDurationMs);
      renderCompositedFrame(exportCanvas, timeMs);

      const frame = new VideoFrame(exportCanvas, {
        timestamp: Math.round(timeMs * 1000),
        duration: frameDurationUs,
      });

      encoder.encode(frame, { keyFrame: frameIndex % (fps * 2) === 0 });
      frame.close();

      if (encoder.encodeQueueSize > 8) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    await encoder.flush();
    encoder.close();

    const isWebM = config.codec === "vp8" || config.codec.startsWith("vp09");
    const blob = isWebM
      ? muxWebM({
        chunks,
        codec: config.codec,
        width: resolution.width,
        height: resolution.height,
        durationMs: previewDurationMs,
        fps,
      })
      : muxMP4({
        chunks,
        codec: config.codec,
        codecConfig,
        width: resolution.width,
        height: resolution.height,
        fps,
      });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = isWebM
      ? "caption-render-fast.webm"
      : "caption-render-fast.mp4";
    link.click();
    URL.revokeObjectURL(url);

    exportVideoBtn.textContent = "Export Video";
    exportVideoBtn.disabled = parsedCues.length === 0;
    showToast(toastRegion, isWebM
      ? "Exported fast WebM video."
      : "Exported fast MP4 video.");
    return true;
  }

  async function exportVideo() {
    try {
      const exported = await exportVideoWithWebCodecs();
      if (!exported) {
        await exportVideoWithMediaRecorder();
      }
    } catch (error) {
      exportVideoBtn.textContent = "Export Video";
      exportVideoBtn.disabled = parsedCues.length === 0;
      showToast(toastRegion, error.message || "Video export failed.", "error");
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
  }

  function renderPreview() {
    if (!previewCanvas || !subtitleCanvas) {
      return;
    }

    drawPreviewFrame(previewCanvas, previewTimeMs);

    const activeCues = SRTParser.atTime(parsedCues, previewTimeMs);
    const activeText = activeCues.map((cue) => cue.text).filter(Boolean).join("\n");
    const primaryCue = activeCues[0];
    renderSubtitleFrame(subtitleCanvas, activeText, {
      ...getCaptionRenderOptions(),
      progress: primaryCue ? (previewTimeMs - primaryCue.startMs) / Math.max(1, primaryCue.durationMs) : 0,
    });

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
    exportSubtitlePngBtn.disabled = cues.length === 0;
    exportVideoBtn.disabled = cues.length === 0;
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
  updatePreviewResolution();
  parseInput();
  schedulePreviewFit();

  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      renderPreview();
    });
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSrtUi);
  } else {
    initSrtUi();
  }
}
