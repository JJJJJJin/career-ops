# openclaw — Claude Code skills for career-ops

A skill manifest per tool. Your Claude Code instance reads these
markdown files (frontmatter + body) and uses them to route natural-
language asks to the right `career-ops` subcommand.

## Install

```bash
./scripts/install-skills.sh
# → symlinks every openclaw/<tool>/SKILL.md into ~/.claude/skills/career-ops/
```

Re-run after pulling repo updates or moving the repo (the install script
is idempotent and bakes in the absolute repo path).

To install into a different skills directory:

```bash
./scripts/install-skills.sh /path/to/skills
```

## Catalog

### Discovery & ingestion
- **[seek-search](seek-search/SKILL.md)** — keyword search across SEEK, ingests stubs into the DB
- **[seek-extract](seek-extract/SKILL.md)** — fetch one SEEK URL → full SeekJob row
- **[linkedin-search](linkedin-search/SKILL.md)** — keyword search across LinkedIn (public guest endpoint)
- **[linkedin-extract](linkedin-extract/SKILL.md)** — fetch one LinkedIn URL → full Job row (`linkedin:<id>`)
- **[indeed-search](indeed-search/SKILL.md)** — keyword search across Indeed Australia
- **[indeed-extract](indeed-extract/SKILL.md)** — fetch one Indeed URL → full Job row (`indeed:<jk>`)
- **[builtin-search](builtin-search/SKILL.md)** — keyword search across Built In (builtin.com); US/remote-centric, location advisory
- **[builtin-extract](builtin-extract/SKILL.md)** — fetch one Built In URL → full Job row (`builtin:<id>`)
- **[web-distill](web-distill/SKILL.md)** — any URL → clean markdown (Mozilla Readability)

### Profile
- **[distill-profile](distill-profile/SKILL.md)** — `profile/profile.md` → `profile.json` (hash-cached)

### Evaluation
- **[flag-eligibility](flag-eligibility/SKILL.md)** — AU citizenship/PR/clearance/sponsorship regex scan
- **[summarize-job](summarize-job/SKILL.md)** — JD → must-haves / nice-to-haves / tech / seniority
- **[match-job](match-job/SKILL.md)** — profile + summary → fit score + recommendation
- **[evaluate-job](evaluate-job/SKILL.md)** ⭐ — composite "should I apply?" entry point

### Generation
- **[generate-resume](generate-resume/SKILL.md)** — TailoredResume JSON + markdown view
- **[generate-cover-letter](generate-cover-letter/SKILL.md)** — 3-paragraph TailoredCoverLetter
- **[generate-company-brief](generate-company-brief/SKILL.md)** — company + role context, optional web grounding

### Rendering
- **[render-resume-pdf](render-resume-pdf/SKILL.md)** — `<slug>-resume.json` → `<slug>-resume.pdf`
- **[render-cover-letter-pdf](render-cover-letter-pdf/SKILL.md)** — `<slug>-cover_letter.json` → `<slug>-cover_letter.pdf`
- **[render-company-brief-pdf](render-company-brief-pdf/SKILL.md)** — `<slug>-company_brief.json` → `<slug>-company_brief.pdf`

### Delivery
- **[send-files](send-files/SKILL.md)** — push one or more local files to a group chat via webhook (WeChat Work today; pluggable)

### Tracking
- **[query-jobs](query-jobs/SKILL.md)** — composable DB filters
- **[show-job](show-job/SKILL.md)** — drill into one record
- **[mark-job](mark-job/SKILL.md)** — set application status
- **[job-stats](job-stats/SKILL.md)** — totals & breakdowns
- **[render-tracker](render-tracker/SKILL.md)** — regenerate `data/applications.md` view

### Workflows
- **[apply-job](apply-job/SKILL.md)** ⭐ — single-job full pipeline (evaluate + generate + render)
- **[daily-pipeline](daily-pipeline/SKILL.md)** — scan + evaluate every new job, auto-apply top STRONG matches

⭐ = the two main entry points for natural-language routing.

## Composition examples

| User says | openclaw chains |
|---|---|
| "find me python grad jobs this week" | `seek-search -q python --days 7` → `query-jobs --since-days 7 --eligible-only` |
| "find remote engineer roles on Built In" | `builtin-search -q "software engineer" --location remote` → `query-jobs --since-days 7 --eligible-only` |
| "should I apply to https://seek.com.au/job/12345" | `evaluate-job 12345` |
| "yes, apply" | `apply-job 12345` |
| "what did I apply to last month?" | `query-jobs --status applied --since-days 30` |
| "regenerate the resume PDF" | `render-resume-pdf <jobId>` |
| "morning brief" | `daily-pipeline --auto-apply-top 3` |
