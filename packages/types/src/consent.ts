import type { Fact } from "./ports.js";

/**
 * Built-in, tiny rule-based consent classifier (§15). Maps a piece of text (optionally with the
 * structured fact it produced) to a coarse personal-data category, or `undefined` when none of the
 * high-precision patterns match. Deliberately conservative — it is better to miss a category (and
 * fall back to the manifest default) than to mis-classify unrelated content.
 *
 * Categories returned (must match the keys callers use in `ConsentManifest.categories`):
 *   - "health"        — medical conditions, diagnoses, medications, mental-health terms.
 *   - "location"      — addresses, "I live in/at", geo-coordinates, postal codes.
 *   - "contact-info"  — email addresses, phone numbers.
 *
 * Override by supplying `ConsentManifest.classify` if you need different categories or precision.
 */
export function defaultConsentClassifier(text: string, fact?: Fact): string | undefined {
  const hay = `${text} ${fact ? `${fact.subject} ${fact.predicate} ${fact.object}` : ""}`.toLowerCase();

  // contact-info: email or phone number (high precision).
  if (/\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/.test(hay)) return "contact-info";
  // Phone: +country / grouped digits, at least 7 digits total.
  if (/(?:\+\d[\d\s().\-]{6,}\d)|(?:\b\d{3}[\s.\-]\d{3,4}[\s.\-]\d{3,4}\b)/.test(hay)) return "contact-info";

  // health: a small high-precision lexicon + fact predicates.
  const healthTerms = [
    "diagnosed", "diagnosis", "disease", "symptom", "prescription", "prescribed",
    "medication", "dosage", "depression", "anxiety", "diabetes", "cancer",
    "asthma", "allergic to", "blood pressure", "therapist", "mental health",
  ];
  if (healthTerms.some((t) => hay.includes(t))) return "health";
  if (fact && /^(diagnosed_with|takes_medication|has_condition|allergic_to)$/.test(fact.predicate)) return "health";

  // location: explicit residence statements, postal codes, lat/long.
  if (/\bi\s+live\s+(?:in|at)\b/.test(hay)) return "location";
  if (/\bmy\s+address\s+is\b/.test(hay)) return "location";
  if (fact && /^(lives_in|lives_at|located_in|home_address)$/.test(fact.predicate)) return "location";
  // lat,long pair
  if (/[-+]?\d{1,3}\.\d+\s*,\s*[-+]?\d{1,3}\.\d+/.test(hay)) return "location";

  return undefined;
}
