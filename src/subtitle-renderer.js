export function drawPreviewFrame(canvas) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  context.fillStyle = "#111";
  context.fillRect(0, 0, width, height);
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

export function renderSubtitleFrame(canvas, text, options = {}) {
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
