// Fuzzy keyword matching that handles typos, emojis, and mixed-language comments

import { loadKeywordRules, MAX_TYPO_DISTANCE } from "../config.js";

// Strip emojis and special characters, keep letters/numbers/spaces
function stripEmojis(text) {
  return text
    .replace(
      /[\u{1F600}-\u{1F9FF}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{FE0F}]/gu,
      ""
    )
    .trim();
}

// Levenshtein distance for typo tolerance
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Check if a comment text matches any keyword rule.
 * Returns the matched rule or null.
 */
export function matchKeyword(commentText, mediaId = null, rulesOverride = null) {
  const rules = rulesOverride || loadKeywordRules();
  const cleaned = stripEmojis(commentText);
  // Insert spaces at CJK/Latin boundaries so keywords get split out
  const spaced = cleaned
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, "$1 $2")
    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, "$1 $2");
  const words = spaced
    .split(/[\s,;:.!?]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

  for (const rule of rules) {
    if (rule.enabled === false) continue;

    // If postIds is specified and non-empty, only match on those posts
    if (rule.postIds?.length > 0 && mediaId && !rule.postIds.includes(mediaId)) {
      continue;
    }

    const keyword = rule.keyword.toUpperCase();
    const keywordParts = keyword.split(/\s+/);

    if (keywordParts.length > 1) {
      // Multi-word keyword: check if all parts appear as a contiguous sequence
      const normalizedText = spaced.toUpperCase();
      if (normalizedText.includes(keyword)) {
        return rule;
      }
      // Fuzzy: check contiguous word sequences of the same length
      for (let i = 0; i <= words.length - keywordParts.length; i++) {
        const slice = words.slice(i, i + keywordParts.length).map(w => w.toUpperCase());
        const totalDist = slice.reduce((sum, w, j) => sum + editDistance(w, keywordParts[j]), 0);
        if (totalDist <= MAX_TYPO_DISTANCE) {
          return rule;
        }
      }
    } else {
      // Single-word keyword: check each word
      for (const word of words) {
        const upper = word.toUpperCase();

        if (upper === keyword) {
          return rule;
        }

        if (
          Math.abs(upper.length - keyword.length) <= MAX_TYPO_DISTANCE &&
          editDistance(upper, keyword) <= MAX_TYPO_DISTANCE
        ) {
          return rule;
        }
      }
    }
  }

  return null;
}
