---
name: classify-jd
description: Classify a job posting into exactly one résumé archetype — backend, full-stack, or ai-agent — and list the emphasis tags it stresses. Selects the summary variant and default bullet ordering used by assemble-resume. LLM with a deterministic keyword fallback when no API key is set.
---

# classify-jd

## When to use
- Inspect how a JD will be targeted before assembling.
- Auto-invoked by `assemble-resume`.

## How to invoke
```
career-ops classify-jd <jobId>
```

## Outputs
- Console: `archetype`, ordered `emphasis` tags, and a short rationale.
