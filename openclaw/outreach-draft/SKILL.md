---
name: outreach-draft
description: For a go-worthy job, draft a short, specific, personalized LinkedIn message or email for each contact the user supplies (hiring manager, engineering lead, University of Melbourne alumni). Drafting is the LLM's job, grounded only in library facts; drafts go to a review queue and are NEVER sent automatically. Contacts are supplied manually.
---

# outreach-draft

## When to use
- After a job passes `go-no-go`, to prepare outreach the user will personally review and send.

## How to invoke
```
career-ops outreach-draft <jobId> --contact "Name|Role|linkedin|note" [--contact ...]
career-ops outreach-draft <jobId> --contacts contacts.json
```
`contacts.json`: `[ { "name": "...", "role": "...", "channel": "linkedin", "note": "UoM alumnus" } ]`

## Outputs
- `output/<source>/<slug>/<slug>-outreach.md` (review queue, human-readable).
- DB: rows in `outreach_drafts` (status `pending` until you mark otherwise).

## Guarantees
- **Never auto-sends.** The user reviews, edits, and sends. The LLM only drafts, grounded in library facts.
