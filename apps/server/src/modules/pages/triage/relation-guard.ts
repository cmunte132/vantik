/**
 * This function tells if two entries differ in a way that prevents a
 * duplicate, whatever a model says about them.
 *
 * "The cache holds sessions for 30 minutes" and "… for 60 minutes" read as
 * near duplicates to an embedding, and often to a model too. If triage folds
 * one into the other, it loses the only part that is important. So a
 * difference in a number, a date, a negation or a condition stops triage from
 * calling the pair a duplicate.
 *
 * The difference does not make the pair unrelated. A correction and a
 * contradiction usually differ in exactly these words. The judges still
 * decide if one entry contradicts, replaces or refines the other.
 */

// "May" is left out: it is far more often the verb, and a date in May
// carries its day, which the number check sees.
const MONTHS =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow)\b/g;

const NEGATIONS =
  /\b(?:not|no|never|none|nothing|nobody|nowhere|neither|nor|without|cannot)\b|n't\b/g;

const CONDITIONS =
  /\b(?:if|unless|when|whenever|only|except|until|before|after|while|provided|once|otherwise)\b/g;

/** Numbers as written, with decimal and version separators kept. */
const NUMBERS = /\d+(?:[.,:/-]\d+)*/g;

/** What sets the two apart, or null when nothing in code does. */
export function factualDifference(a: string, b: string): string | null {
  const left = (a ?? '').toLowerCase();
  const right = (b ?? '').toLowerCase();

  if (!sameSet(left, right, NUMBERS)) {
    return 'they differ in a number';
  }

  if (!sameSet(left, right, MONTHS)) {
    return 'they differ in a date';
  }

  // Counted rather than compared as sets: "not" once and "not" twice are a
  // negation and a double negation, and parity is what flips the meaning.
  if (count(left, NEGATIONS) % 2 !== count(right, NEGATIONS) % 2) {
    return 'one is negated and the other is not';
  }

  if (!sameSet(left, right, CONDITIONS)) {
    return 'they differ in a condition';
  }

  return null;
}

function sameSet(a: string, b: string, pattern: RegExp): boolean {
  const left = new Set(a.match(pattern) ?? []);
  const right = new Set(b.match(pattern) ?? []);

  return left.size === right.size && [...left].every((item) => right.has(item));
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}
