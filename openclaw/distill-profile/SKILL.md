---
name: distill-profile
description: Convert profile/profile.md (free-form CV markdown) into profile/profile.json (structured StructuredProfile). Hash-cached — no-op when source markdown is unchanged. Use after editing profile.md, or as a prerequisite step before generate-resume / generate-cover-letter.
---

# distill-profile

## When to use
- The user just edited `profile/profile.md`
- The user is about to run `generate-resume` or `generate-cover-letter` for the first time
- A downstream tool fails with "profile.md has changed since last distillation"

## How to invoke
```
career-ops distill-profile [--force] [--json]
```

## Inputs
- `--force` — re-distill even when the markdown hash matches the cached JSON.
- `--json` — emit the full StructuredProfile.

## Outputs
- Stdout: name, hash, counts (experience / projects / skills / education).
- File: `profile/profile.json` (overwritten when source changes).

## Chaining
- All resume/cover-letter generation tools call `ensureProfile()` internally, which auto-distills when needed. You only need to invoke this directly to re-distill after edits or to inspect the structured output.
- Multi-variant project blocks under `### Project Name` (e.g. `#### Variant — Backend focus` + `#### Variant — AI focus`) are preserved as a UNION of highlights — the resume generator picks the best variant per job.

## Profile.md format hint (for new users)

```markdown
# Jane Doe — Software Engineer
contact line · email · linkedin

## Summary
2-3 sentence headline.

## Experience
### Role — Company  · 2022–2025 · Sydney
- highlight 1
- highlight 2

## Projects
### NRF24L01p Wireless Mesh
**Common tech:** C++, RTOS, ...

#### Variant — Embedded / firmware focus
[intro paragraph]
- highlight
- highlight

#### Variant — Backend / IoT platform focus
[intro paragraph]
- highlight

## Skills
**Languages:** TypeScript, Python, ...
**Frameworks:** ...
```
