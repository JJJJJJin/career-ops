// Synonym-aware text normalization. Two jobs:
//   1. The assembler ALIGNS vocabulary — swapping a library term for the JD's
//      synonym when both denote the same real thing (REST API == RESTful API).
//   2. The traceability check NORMALIZES both sides to a canonical form so an
//      allowed synonym swap does not look like a fabricated line.
//
// Decision (per refactor plan): normalized matching + synonym substitution,
// NOT pure verbatim. We fold case/whitespace/bold, then canonicalize every
// synonym group to its first member, so library "REST API" and output
// "RESTful API" collapse to the same key.
import type { SynonymGroup } from './types.js';

/** Strip inline markdown bold/italic markers but keep the words. */
function stripInlineMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
}

/** Lowercase, strip md, collapse whitespace, drop trailing punctuation noise. */
export function baseNormalize(s: string): string {
  return stripInlineMd(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a canonicalizer that rewrites every synonym-group member to the
 * group's first member (longest-match-first so multi-word terms win).
 */
export function makeCanonicalizer(synonyms: SynonymGroup[]): (s: string) => string {
  // Flatten to {term, canonical} pairs, sorted by descending term length so
  // "domain-driven design" is replaced before "design".
  const pairs: Array<{ term: string; canon: string }> = [];
  for (const group of synonyms) {
    if (group.length < 2) continue;
    const canon = baseNormalize(group[0]);
    for (let i = 1; i < group.length; i++) {
      const term = baseNormalize(group[i]);
      if (!term || term === canon) continue;
      pairs.push({ term, canon });
    }
  }
  pairs.sort((a, b) => b.term.length - a.term.length);
  const compiled = pairs.map((p) => ({
    re: new RegExp(`\\b${escapeRegex(p.term)}\\b`, 'g'),
    canon: p.canon,
  }));
  return (s: string) => {
    let out = baseNormalize(s);
    for (const c of compiled) out = out.replace(c.re, c.canon);
    return out;
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Canonical key for traceability comparison: base-normalized + synonyms folded.
 * Two strings that differ only by case/whitespace/bold or an allowed synonym
 * swap produce the same key.
 */
export function traceKey(s: string, canonicalize: (s: string) => string): string {
  return canonicalize(s);
}
