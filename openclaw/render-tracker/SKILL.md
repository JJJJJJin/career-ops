---
name: render-tracker
description: Regenerate data/applications.md from the SQLite DB. The markdown is a read-only human-readable view of the applications table. Auto-invoked by mark-job, apply-job, daily-pipeline. Invoke directly only if you've manually mutated the DB and want the markdown view refreshed.
---

# render-tracker

## When to use
- After hand-editing the SQLite DB (rare)
- Sanity-rebuild after pulling repo updates that change the renderer

Skip when:
- You did anything via career-ops itself — every state-changing tool already calls this.

## How to invoke
```
career-ops render-tracker
```

## Inputs
- None.

## Outputs
- File: `data/applications.md` rebuilt from `applications` + `jobs` tables.
- Stdout: relative path to the file.

## Note
- `data/applications.md` is gitignored. It's a view, not a source of truth — never hand-edit it (changes will be clobbered).
