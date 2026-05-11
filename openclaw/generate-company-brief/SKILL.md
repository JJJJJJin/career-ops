---
name: generate-company-brief
description: Generate a concise company + role briefing — what they do, products, industry, culture, position context, plus a "things to verify" checklist for any unverified claims. Optionally grounded by web-distill on a company website URL. Use before applying or interviewing.
---

# generate-company-brief

## When to use
- User asks "what does this company do?", "give me a brief on Acme", "interview prep for this role"
- Sub-step inside `apply-job`

Skip when:
- The user only wants resume + cover letter → `apply-job --skip-brief`

## How to invoke
```
career-ops generate-company-brief <jobId> [--company-website <url>] [--force]
```

## Inputs
- `<jobId>` (required) — job must be in DB.
- `--company-website <url>` — if set, runs `web-distill` on the URL and feeds the markdown into the LLM prompt as authoritative context for "what they do" / "products". Strongly recommended for companies the model may not know.
- `--force` — regenerate even if cached.

## Outputs
(`<slug>` = `<company-slug>-<role-slug>`; artefact filenames are prefixed with it.)
- File: `output/<slug>/<slug>-company_brief.md` (with sections: One-liner, What they do, Products/services, Industry & market, Culture & values, This role in context, Things to verify).
- File: `output/<slug>/<slug>-company_brief.json` (structured form).
- DB: `applications.company_brief_md`.

## Honesty contract
- Anything the LLM is unsure about goes into `thingsToVerify` (rendered as a checkbox list) — funding, headcount, founders, recent news. The user verifies before relying on these in an interview.

## Chaining
- Standalone tool — no PDF render step (markdown is the deliverable, since briefs are read on-screen).
- Often invoked with `--company-website` after the user pastes the company's homepage URL.
