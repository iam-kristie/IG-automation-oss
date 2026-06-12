import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchKeyword } from "../lib/keyword-matcher.js";

// Test rules (independent of data/keyword-rules.json)
const RULES = [
  { keyword: "SLIDE", postIds: [], message: "slide msg", enabled: true },
  { keyword: "CRON", postIds: [], message: "cron msg", enabled: true },
  { keyword: "TEST AUTOMATION", postIds: [], message: "test msg", enabled: true },
];

const match = (text, mediaId = null) => matchKeyword(text, mediaId, RULES);

describe("matchKeyword", () => {
  // --- Exact matches ---
  it("matches exact keyword", () => {
    assert.equal(match("SLIDE").keyword, "SLIDE");
    assert.equal(match("CRON").keyword, "CRON");
  });

  it("matches case-insensitive", () => {
    assert.equal(match("slide").keyword, "SLIDE");
    assert.equal(match("Slide").keyword, "SLIDE");
    assert.equal(match("cron").keyword, "CRON");
  });

  // --- With emojis ---
  it("matches with emojis around keyword", () => {
    assert.equal(match("SLIDE 🙏").keyword, "SLIDE");
    assert.equal(match("🔥SLIDE").keyword, "SLIDE");
    assert.equal(match("🙋‍♀️ CRON 🙏🙏").keyword, "CRON");
    assert.equal(match("✨slide✨").keyword, "SLIDE");
  });

  // --- With surrounding text ---
  it("matches keyword within longer comment", () => {
    assert.equal(match("I want SLIDE please").keyword, "SLIDE");
    assert.equal(match("想要CRON").keyword, "CRON");
    assert.equal(match("please send me SLIDE thanks!").keyword, "SLIDE");
  });

  // --- Typos (edit distance = 1) ---
  it("matches common typos", () => {
    assert.equal(match("SLIDEE").keyword, "SLIDE");  // extra letter
    assert.equal(match("SLDE").keyword, "SLIDE");     // missing letter
    assert.equal(match("CRON!").keyword, "CRON");     // punctuation handled
  });

  it("does not match transpositions (edit distance 2 in Levenshtein)", () => {
    assert.equal(match("SLDIE"), null);
  });

  // --- Should NOT match ---
  it("does not match unrelated comments", () => {
    assert.equal(match("Great post!"), null);
    assert.equal(match("Love this 🔥"), null);
    assert.equal(match("awesome"), null);
    assert.equal(match(""), null);
  });

  it("matches close typos (edit distance 1)", () => {
    assert.equal(match("SLIDES").keyword, "SLIDE");
    assert.equal(match("SLIDER").keyword, "SLIDE");
  });

  it("does not match words with edit distance > 1", () => {
    assert.equal(match("SLUDGE"), null);
    assert.equal(match("CLONE"), null);
    assert.equal(match("SLIDING"), null);
  });

  // --- Multi-word keywords ---
  it("matches multi-word keyword exactly", () => {
    assert.equal(match("TEST AUTOMATION").keyword, "TEST AUTOMATION");
    assert.equal(match("test automation").keyword, "TEST AUTOMATION");
  });

  it("matches multi-word keyword with emojis", () => {
    assert.equal(match("Test automation 🙌").keyword, "TEST AUTOMATION");
    assert.equal(match("🔥 test automation").keyword, "TEST AUTOMATION");
  });

  it("matches multi-word keyword within longer text", () => {
    assert.equal(match("I want test automation please").keyword, "TEST AUTOMATION");
  });

  it("does not match partial multi-word keyword", () => {
    assert.equal(match("test"), null);
    assert.equal(match("automation"), null);
  });

  // --- Disabled rules ---
  it("skips disabled rules", () => {
    const rules = [{ keyword: "SKIP", postIds: [], message: "msg", enabled: false }];
    assert.equal(matchKeyword("SKIP", null, rules), null);
  });
});
