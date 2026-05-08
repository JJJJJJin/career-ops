---
name: web-distill
description: Fetch any URL and return clean markdown + plain text using Mozilla Readability. Strips chrome, nav, sidebars, footers — leaves the article content. Use when you need to read a web page's content with minimal token cost (company website, blog post, docs page). Not SEEK-specific.
---

# web-distill

## When to use
- Read a company's "About" page before generating a brief
- Pull article text for grounding without burning tokens on chrome/nav DOM
- Quick "what's on this page?" lookup

Skip when:
- The URL is a SEEK job posting → use `seek-extract`
- The page is a SPA that requires JS rendering — pass `--js` to use Playwright

## How to invoke
```
career-ops web-distill <url> [--js] [--text|--markdown|--json]
```

## Inputs
- `<url>` (required) — the page to fetch.
- `--js` — render with Playwright (handles SPAs). Default: plain `fetch()`.
- `--text` — output plain text (no formatting).
- `--markdown` (default) — output markdown.
- `--json` — output `{url, title, byline, excerpt, text, markdown, isReaderable}`.

## Outputs
- Stdout: title (as `# heading`) + cleaned content in the chosen format.

## Chaining
- This tool is most often invoked indirectly by `generate-company-brief --company-website <url>`, which calls it under the hood and feeds the markdown into the LLM prompt.
- For ad-hoc research, pipe to a file: `career-ops web-distill <url> > /tmp/page.md`.
