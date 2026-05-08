---
name: mark-job
description: Set the application status for one job — new / interested / applied / interview / rejected / offer / skip. Optionally attach notes. Use when the user reports an action they took ("I applied to <jobId>", "got rejected from Acme", "interview booked"). Auto-regenerates data/applications.md.
---

# mark-job

## When to use
- "I applied to <jobId>"
- "Mark Acme as rejected"
- "Got an interview at Beta"
- "Skip this one"

Skip when:
- The user wants automated processing → `daily-pipeline` doesn't change status; humans do.

## How to invoke
```
career-ops mark-job <jobId> <status> [--notes "free text"]
```

## Inputs
- `<jobId>` (required)
- `<status>` (required) — one of: `new`, `interested`, `applied`, `interview`, `rejected`, `offer`, `skip`
- `--notes` / `-n` — optional free text stored in `applications.notes`

## Outputs
- Stdout: confirmation
- DB: `applications.status` (and `notes` if provided)
- File: `data/applications.md` regenerated

## Status semantics
- `new` — default; never been touched by the human
- `interested` — read but not acted on
- `applied` — submitted (the user did this manually; we don't auto-submit)
- `interview` — in the interview process
- `rejected` — rejected by the company
- `offer` — offer received
- `skip` — explicitly decided not to apply (overrides recommendation)
