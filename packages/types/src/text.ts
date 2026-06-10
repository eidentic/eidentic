/** Tokenize text into lowercased unicode word tokens (letters/digits/marks). Shared by lexical search. */
export function tokenize(text: string): string[] {
  return [...text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((m) => m[0].toLowerCase());
}
