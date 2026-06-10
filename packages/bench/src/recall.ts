/**
 * Deterministic recall metric for the memory benchmark harness (§6.10).
 *
 * recallAtK: fraction of gold facts whose text appears (normalized substring match) in the top-K
 * retrieved context snippets. No model required — fully deterministic.
 */

/**
 * Normalize a string for comparison: lowercase, collapse whitespace, strip leading/trailing
 * punctuation from each word so that "Alice's" and "Alice" both match. This is intentionally
 * lenient — the point is to detect whether the semantic content was retrieved, not to penalize
 * minor formatting differences.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[''`]/g, "") // strip apostrophes so "alice's" → "alices"
    .replace(/[^\w\s]/g, " ") // replace other punctuation with space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check whether `needle` appears in `haystack` after normalization.
 * Uses substring matching so partial matches count (e.g. "TypeScript" found in a longer sentence).
 */
export function normalizedIncludes(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

/**
 * Compute recall@K: the fraction of gold facts that appear as substrings in the retrieved context.
 *
 * @param retrievedSnippets - The text of the top-K retrieved memory snippets.
 * @param goldFacts - The gold evidence substrings that must be found in the retrieved context.
 * @returns A value in [0, 1]. Returns 1.0 when goldFacts is empty (vacuously true).
 */
export function recallAtK(retrievedSnippets: string[], goldFacts: string[]): number {
  // Filter blank gold facts from BOTH numerator and denominator so empty strings
  // don't distort the metric (vacuously found in numerator but count in denominator).
  const nonEmptyGold = goldFacts.filter((f) => f.trim().length > 0);
  if (nonEmptyGold.length === 0) return 1.0;
  // Join all retrieved snippets into one searchable corpus.
  const corpus = retrievedSnippets.join(" ");
  let found = 0;
  for (const fact of nonEmptyGold) {
    if (normalizedIncludes(corpus, fact)) found += 1;
  }
  return found / nonEmptyGold.length;
}

/**
 * Compute fact recall against an asserted knowledge graph (KG).
 *
 * Given a set of expected (subject, predicate, object) triples as plain text strings (e.g.
 * "Alice lives in London"), checks how many appear in the provided fact texts. Useful when the
 * benchmark asserts facts into the temporal KG and queries them back.
 *
 * @param factTexts - Texts of facts retrieved from the KG (e.g. "subject predicate object" strings).
 * @param goldFacts - Expected fact substrings.
 * @returns Fraction found in [0, 1].
 */
export function factRecall(factTexts: string[], goldFacts: string[]): number {
  return recallAtK(factTexts, goldFacts);
}
