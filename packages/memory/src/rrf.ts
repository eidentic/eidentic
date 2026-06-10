import type { MemorySnippet } from "@eidentic/types";

/** Reciprocal Rank Fusion over ranked snippet lists. Items in multiple lists are boosted. */
export function reciprocalRankFusion(lists: MemorySnippet[][], k = 60): MemorySnippet[] {
  const acc = new Map<string, { snippet: MemorySnippet; score: number }>();
  for (const list of lists) {
    list.forEach((s, rank) => {
      const add = 1 / (k + rank + 1);
      const cur = acc.get(s.id);
      if (cur) cur.score += add;
      else acc.set(s.id, { snippet: s, score: add });
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => ({ ...e.snippet, score: e.score }));
}
