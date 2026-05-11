---
name: send-files
description: Push one or more local files (PDF, DOCX, images, …) to a group chat via webhook. Pluggable across providers (currently WeChat Work / 企业微信). Use to deliver application bundles, share an artefact ad-hoc, or notify a chat with files attached. Webhook URL comes from $WEBHOOK_URL (override with --webhook).
---

# send-files

## When to use
- After `apply-job` finished and you want to re-send the bundle (apply-job already auto-sends when WEBHOOK_URL is set)
- Ad-hoc: share any file from disk to the configured group chat
- Forwarding a specific PDF, a screenshot, or a doc to the team

Skip when:
- The user just wants the artefacts on disk — don't notify them out
- No webhook is configured (`$WEBHOOK_URL` unset and no `--webhook`)

## How to invoke
```
# Explicit files
career-ops send-files <file...> [--webhook <url>] [--provider <name>] [--text <msg>] [--markdown] [--no-fail]

# Auto-collect all PDFs in output/<slug>/ for a job
career-ops send-files --job <jobId> [--ext .pdf,.docx] [--webhook <url>] [--text <msg>]
```

## Inputs
- `<file...>` — one or more local file paths (absolute or relative to cwd).
- `--job <jobId>` — auto-collect files from `output/<company-slug>-<role-slug>/`.
- `--ext <list>` — comma-separated extension filter when `--job` is used (default: `.pdf`).
- `--webhook <url>` — webhook URL (default: `$WEBHOOK_URL`).
- `--provider <name>` — provider key (default: `$WEBHOOK_PROVIDER` or `wecom`).
- `--text <msg>` — optional prelude message sent before the attachments.
- `--markdown` — treat `--text` as markdown (where the provider supports it).
- `--no-fail` — exit 0 even if some files failed to send.

## Provider notes — WeChat Work (wecom)
- Files: 5KB ≤ size ≤ 20MB. Smaller/larger files are skipped with a clear error.
- Images (.png/.jpg/.jpeg/.gif/.bmp/.webp): inline-sent, max 2MB.
- Voice (.amr): treated as voice message.
- Anything else: uploaded as `file` (media upload + send by media_id).

## Outputs
- Stdout: per-file ✓/✘ summary.
- Logs: structured info on each upload + send.

## Composition examples
- `apply-job 12345` — auto-sends bundle when WEBHOOK_URL is set.
- `apply-job 12345 --no-send` — generate but don't notify.
- `send-files --job 12345` — manually push that job's PDFs.
- `send-files /tmp/screenshot.png --text "look at this"` — ad-hoc share.
- `send-files output/acme-engineer/resume.pdf output/acme-engineer/cover_letter.pdf` — explicit list.

## Adding a new provider
1. Implement `NotifyProvider` in `src/shared/notify/<provider>.ts`.
2. Register it in `PROVIDERS` in `src/shared/notify/index.ts`.
3. Document any provider-specific limits here.
