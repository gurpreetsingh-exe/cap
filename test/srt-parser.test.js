import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SRTParser } from "../src/srt-parser.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parses the bundled example file", () => {
  const input = fs.readFileSync(path.join(root, "example.srt"), "utf8");
  const result = SRTParser.parse(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.cues.length, 9);
  assert.equal(result.cues[0].index, 1);
  assert.equal(result.cues[0].startMs, 0);
  assert.equal(result.cues[0].endMs, 2500);
  assert.equal(result.cues[8].text, "Enjoy adding subtitles to your videos!");
});

test("round-trips parsed cues back into valid SRT", () => {
  const input = fs.readFileSync(path.join(root, "example.srt"), "utf8");
  const first = SRTParser.parse(input);
  const output = SRTParser.stringify(first.cues);
  const second = SRTParser.parse(output);

  assert.equal(second.errors.length, 0);
  assert.equal(second.cues.length, first.cues.length);
  assert.deepEqual(
    second.cues.map((cue) => [cue.index, cue.startMs, cue.endMs, cue.text]),
    first.cues.map((cue) => [cue.index, cue.startMs, cue.endMs, cue.text]),
  );
});

test("parses multilingual subtitle text from the commented sample", () => {
  const input = `1
00:00:33,843 --> 00:00:38,097
Only 3% of the water on our planet is fresh.
地球上只有3%的水是淡水

2
00:00:40,641 --> 00:00:44,687
Yet, these precious waters are rich with surprise.
可是这些珍贵的淡水中却充满了惊奇`;

  const result = SRTParser.parse(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].startMs, 33843);
  assert.equal(result.cues[0].endMs, 38097);
  assert.deepEqual(result.cues[0].lines, [
    "Only 3% of the water on our planet is fresh.",
    "地球上只有3%的水是淡水",
  ]);
  assert.equal(result.cues[1].text.includes("珍贵"), true);
});

test("supports cue IDs, settings, CRLF, and dot millisecond separators", () => {
  const input = [
    "intro",
    "00:00:01.250 --> 00:00:03.500 align:center position:50%",
    "Hello",
    "",
    "2",
    "00:00:04,000 --> 00:00:05,000",
    "World",
  ].join("\r\n");

  const result = SRTParser.parse(input);

  assert.equal(result.errors.length, 0);
  assert.equal(result.cues[0].id, "intro");
  assert.equal(result.cues[0].index, 1);
  assert.equal(result.cues[0].settings, "align:center position:50%");
  assert.equal(result.cues[0].startMs, 1250);
  assert.equal(result.cues[1].index, 2);
});

test("collects malformed cues in non-strict mode", () => {
  const input = `1
00:00:00,000 --> 00:00:01,000
Good

2
bad timing
Broken`;

  const result = SRTParser.parse(input);

  assert.equal(result.cues.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Invalid cue timing/);
});

test("throws on malformed cues in strict mode", () => {
  assert.throws(
    () => SRTParser.parse("1\nbad timing\nBroken", { strict: true }),
    /Invalid cue timing/,
  );
});

test("validates empty text and overlaps", () => {
  const input = `1
00:00:00,000 --> 00:00:02,000
First

2
00:00:01,500 --> 00:00:03,000
`;

  const result = SRTParser.validate(input, { requirePositiveDuration: false });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.equal(result.warnings.some((warning) => warning.message.includes("overlaps")), true);
  assert.equal(result.warnings.some((warning) => warning.message.includes("no text")), true);
});

test("formats, shifts, scales, and finds cues by time", () => {
  const cues = SRTParser.parse(`1
00:00:01,000 --> 00:00:03,000
Alpha

2
00:00:04,000 --> 00:00:06,000
Beta`).cues;

  assert.equal(SRTParser.parseTimestamp("01:02:03,004"), 3723004);
  assert.equal(SRTParser.formatTimestamp(3723004), "01:02:03,004");
  assert.equal(SRTParser.formatTimestamp(1500, { decimalSeparator: "." }), "00:00:01.500");

  const shifted = SRTParser.shift(cues, 500);
  assert.equal(shifted[0].startMs, 1500);
  assert.equal(shifted[0].end, "00:00:03,500");

  const scaled = SRTParser.scale(cues, 2);
  assert.equal(scaled[1].startMs, 8000);
  assert.equal(scaled[1].endMs, 12000);

  assert.equal(SRTParser.atTime(cues, "00:00:04,500")[0].text, "Beta");
  assert.equal(SRTParser.between(cues, 2500, 4500).length, 2);
});

test("builds cues from plain text", () => {
  const cues = SRTParser.fromPlainText(["One", "Two"], {
    startMs: 1000,
    durationMs: 1500,
    gapMs: 500,
  });

  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, "00:00:01,000");
  assert.equal(cues[0].end, "00:00:02,500");
  assert.equal(cues[1].startMs, 3000);
  assert.equal(SRTParser.toPlainText(cues, { separator: " / " }), "One / Two");
});
