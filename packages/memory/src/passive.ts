export interface PassiveFact { subject: string; predicate: string; object: string }

const MAX_OBJ = 80;

function cap(s: string): string {
  return s.length > MAX_OBJ ? s.slice(0, MAX_OBJ).trimEnd() : s;
}

// Stop at sentence punctuation OR a clause/preposition boundary word.
const BOUNDARY = /\b(?:as|at|in|on|for|and|or|but|because|who|which|that|over|with|while)\b/i;

/** Stop capture at sentence-ending punctuation or a clause/preposition boundary word. */
function stopAtPunct(s: string): string {
  const m = s.match(/^([^.!?,;]+)/);
  let out = m ? m[1]! : "";
  const b = out.search(BOUNDARY);
  if (b > 0) out = out.slice(0, b);
  return out.trim();
}

/**
 * Rule-based subject-predicate-object extraction — NO LLM (design §6.8, robust on weak/local models).
 * Conservative: prefers precision over recall. Returns [] when nothing matches.
 * Each rule runs case-insensitively; objects are trimmed + capped at 80 chars; identical triples are deduped.
 */
export function passiveExtract(text: string, subject = "user"): PassiveFact[] {
  const facts: PassiveFact[] = [];

  const add = (predicate: string, object: string) => {
    const obj = cap(object.trim());
    if (!obj) return;
    // Dedupe: skip if an identical triple already in list
    const dup = facts.some(
      (f) => f.subject === subject && f.predicate === predicate && f.object === obj,
    );
    if (!dup) facts.push({ subject, predicate, object: obj });
  };

  // Rule 1: "my name is <Name>" — capture a capitalized name token
  for (const m of text.matchAll(/my name is ([A-Z][a-zA-Z\-']+)/gi)) {
    // Re-match with correct case sensitivity for the captured name
    const raw = m[1]!;
    // Capitalize first letter of actual capture
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    add("name", name);
  }

  // Rule 2: "I (love|like|prefer|enjoy) <thing>" — stop at sentence punctuation
  for (const m of text.matchAll(/\bI\s+(?:love|like|prefer|enjoy)\s+([^.!?,;]+)/gi)) {
    const obj = stopAtPunct(m[1]!.trim());
    if (obj) add("likes", obj);
  }

  // Rule 3: "I work (at|for) <Company>"
  for (const m of text.matchAll(/\bI\s+work\s+(?:at|for)\s+([^.!?,;]+)/gi)) {
    const obj = stopAtPunct(m[1]!.trim());
    if (obj) add("works_at", obj);
  }

  // Rule 4a: "I work as (a|an)? <role>"
  for (const m of text.matchAll(/\bI\s+work\s+as\s+(?:a|an)?\s+([^.!?,;]+)/gi)) {
    const obj = stopAtPunct(m[1]!.trim());
    if (obj) add("role", obj);
  }

  // Rule 4b: "I'm a|an <role>" or "I am a|an <role>"
  for (const m of text.matchAll(/\bI(?:'m|\s+am)\s+(?:a|an)\s+([^.!?,;]+)/gi)) {
    const obj = stopAtPunct(m[1]!.trim());
    if (obj) add("is", obj);
  }

  return facts;
}
