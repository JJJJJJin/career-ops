---
name: parse-library
description: Parse and validate the résumé content library (profile/profile_v3.md). Prints what was extracted (contact, summary variants, skills, tagged experience/project bullets, synonyms) and self-tests that each archetype (backend / full-stack / ai-agent) assembles into a fully traceable résumé. Run this after editing profile_v3.md.
---

# parse-library

## When to use
- After editing `profile/profile_v3.md`, to confirm it still parses and every archetype assembles cleanly.
- To inspect what the assembler sees.

## How to invoke
```
career-ops parse-library
```

## Outputs
- Console: parsed counts + per-entry bullet/conditional counts + a per-archetype self-test (✓/✗).
- Exit code 1 if any archetype fails the traceability self-test.

## Notes
- `profile_v3.md` is the SINGLE source of truth for résumé content. The old `profile.md` / `profile.json` / `distill-profile` path has been removed.
