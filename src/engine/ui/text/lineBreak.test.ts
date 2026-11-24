// ADR 0356 §5: where UI text may break a line, and greedy wrapping, shared by measuring and drawing.
import { describe, expect, it } from "vitest";
import { lineSegments, wrapLine, wrapText } from "./lineBreak";

/** One unit per character (a monospaced measure). */
const mono = (s: string) => [...s].length;
const lines = (text: string, width: number, mode?: "normal" | "anywhere") => wrapText(text, width, mono, mode).map((l) => l.text);

describe("line breaking: Latin text (unchanged)", () => {
  it("breaks after spaces and drops the spaces a line ends with", () => {
    expect(lineSegments("Hello big world")).toEqual(["Hello ", "big ", "world"]);
    expect(lines("Hello big world", 9)).toEqual(["Hello big", "world"]);
    expect(wrapLine("Hello big world", 9, mono)).toEqual([{ text: "Hello big", width: 9 }, { text: "world", width: 5 }]);
  });

  it("lets a word wider than the line overflow, and keeps paragraphs", () => {
    expect(lines("Supercalifragilistic is long", 10)).toEqual(["Supercalifragilistic", "is long"]);
    expect(lines("a b\nc", 10)).toEqual(["a b", "c"]);
    expect(lines("", 10)).toEqual([""]);
    expect(lines("no wrap at all", Infinity)).toEqual(["no wrap at all"]);
  });

  it("keeps leading spaces with the first word, giving no empty first line", () => {
    expect(lineSegments("  Hello world")).toEqual(["  Hello ", "world"]);
    expect(lines("  Hello world", 8)).toEqual(["  Hello", "world"]);
    expect(lines("   ", 2)).toEqual([""]);
  });

  it("breaks between any two graphemes for break-all, never inside one", () => {
    expect(lineSegments("ab", "anywhere")).toEqual(["a", "b"]);
    expect(lineSegments("éx", "anywhere")).toEqual(["é", "x"]);
    expect(lines("abcdef", 4, "anywhere")).toEqual(["abcd", "ef"]);
  });
});

describe("line breaking: CJK and kinsoku", () => {
  it("breaks between ideographs, kana and Hangul syllables, and next to Latin words", () => {
    expect(lineSegments("日本語")).toEqual(["日", "本", "語"]);
    expect(lineSegments("안녕하세요")).toEqual(["안", "녕", "하", "세", "요"]);
    expect(lineSegments("Myco引擎")).toEqual(["Myco", "引", "擎"]);
    expect(lines("中文文本没有空格", 3)).toEqual(["中文文", "本没有", "空格"]);
  });

  it("starts no line with closing punctuation, small kana or the prolonged sound mark", () => {
    expect(lineSegments("チョコレート")).toEqual(["チョ", "コ", "レー", "ト"]);
    expect(lineSegments("はい。")).toEqual(["は", "い。"]);
    expect(lineSegments("本当！？")).toEqual(["本", "当！？"]);
    expect(lineSegments("日本、中国")).toEqual(["日", "本、", "中", "国"]);
    // Eight characters fit, but "。" may not start the next line: "す" goes down with it.
    expect(lines("これはテストです。", 8)).toEqual(["これはテストで", "す。"]);
  });

  it("ends no line with an opening bracket", () => {
    expect(lineSegments("あ「い」う")).toEqual(["あ", "「い」", "う"]);
    expect(lineSegments("言った「はい」と")).toEqual(["言っ", "た", "「は", "い」", "と"]); // っ (small kana) can't start a line either
    expect(lines("言った「はい」と", 3)).toEqual(["言った", "「は", "い」と"]);
  });
});

describe("line breaking: Thai and other scripts without spaces", () => {
  it("breaks between Thai words, which Intl.Segmenter finds", () => {
    expect(lineSegments("สวัสดีครับ")).toEqual(["สวัสดี", "ครับ"]);
    expect(lines("สวัสดีครับ", 7)).toEqual(["สวัสดี", "ครับ"]);
    // Grapheme clusters (a consonant with its vowel and tone marks) are never split.
    expect(lineSegments("ภาษาไทย").join("")).toBe("ภาษาไทย");
    expect(lineSegments("ภาษาไทย")).toEqual(["ภาษา", "ไทย"]);
  });
});
