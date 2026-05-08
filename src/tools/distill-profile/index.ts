// distill-profile — convert profile/profile.md into structured JSON.
// Hash-cached: re-running with no changes is a no-op.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, profileMarkdownPath, profileJsonPath } from '../../shared/config.js';
import { callJson } from '../../shared/llm/client.js';
import { createLogger } from '../../shared/logger.js';
import type { StructuredProfile } from './types.js';

const log = createLogger('distill-profile');

const SYSTEM_PROMPT = `You convert a candidate's free-form profile (markdown) into a structured JSON profile so future automation can cite specific facts. Be FAITHFUL to the input — never invent experience, technologies, dates, or metrics the candidate did not write. Use null or empty arrays when something is unknown.

PRESERVE VARIANTS. The candidate may write multiple framings of the same project for different role targets (e.g. a "Backend version" and an "AI Engineer version" of the same project). When you detect this:
- Emit ONE project entry per real-world project (deduplicate by project name).
- UNION every distinct highlight across all variants into the project's highlights array — do NOT drop or merge highlights that emphasize different aspects (backend, AI, data, embedded). Phrase each highlight as the candidate wrote it; near-duplicates with different emphasis should both be kept.
- UNION the technologies arrays similarly.
- Use the most descriptive description text; if variants have different intro paragraphs, prefer the one that most concretely describes what the project does.

The downstream resume generator will pick the right subset of highlights based on the target job, so your job is to preserve raw material, not to compress it.`;

const SCHEMA_HINT = `Return strict JSON in this shape:
{
  "name": string,
  "headline": string,
  "contact": { "email": string|null, "phone": string|null, "location": string|null, "linkedin": string|null, "github": string|null, "website": string|null },
  "summary": string,
  "skills": [ { "category": string, "items": string[] } ],
  "experience": [ { "role": string, "company": string, "period": string, "location": string|null, "highlights": string[], "technologies": string[] } ],
  "projects": [ { "name": string, "description": string, "highlights": string[], "technologies": string[], "link": string|null } ],
  "education": [ { "degree": string, "institution": string, "period": string, "details": string|null } ],
  "certifications": string[],
  "languages": string[]
}`;

export function hashMarkdown(md: string): string {
  return createHash('sha256').update(md).digest('hex').slice(0, 16);
}

async function distillFromMarkdown(markdown: string): Promise<StructuredProfile> {
  const hash = hashMarkdown(markdown);
  log.info({ chars: markdown.length, hash, model: config.llm.model }, 'distill-profile: distilling');

  const parsed = await callJson<Partial<StructuredProfile>>({
    step: 'distill-profile',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `${SCHEMA_HINT}\n\nCANDIDATE MARKDOWN:\n${markdown}`,
    maxTokens: 8192,
  });

  return {
    name: parsed.name ?? '',
    headline: parsed.headline ?? '',
    contact: {
      email: parsed.contact?.email ?? null,
      phone: parsed.contact?.phone ?? null,
      location: parsed.contact?.location ?? null,
      linkedin: parsed.contact?.linkedin ?? null,
      github: parsed.contact?.github ?? null,
      website: parsed.contact?.website ?? null,
    },
    summary: parsed.summary ?? '',
    skills: parsed.skills ?? [],
    experience: parsed.experience ?? [],
    projects: parsed.projects ?? [],
    education: parsed.education ?? [],
    certifications: parsed.certifications ?? [],
    languages: parsed.languages ?? [],
    distilledAt: new Date().toISOString(),
    sourceMarkdownHash: hash,
  };
}

export type DistillOptions = {
  /** Force re-distill even if hash matches. */
  force?: boolean;
};

export async function distillProfile(opts: DistillOptions = {}): Promise<{ profile: StructuredProfile; markdown: string; cached: boolean }> {
  const mdPath = profileMarkdownPath();
  const jsonPath = profileJsonPath();

  if (!fs.existsSync(mdPath)) {
    throw new Error(
      `profile.md not found at ${mdPath}. Create it before running distill-profile (see README for format).`,
    );
  }

  const markdown = fs.readFileSync(mdPath, 'utf-8');
  const hash = hashMarkdown(markdown);

  if (!opts.force && fs.existsSync(jsonPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as StructuredProfile;
      if (cached.sourceMarkdownHash === hash) {
        log.info({ hash }, 'distill-profile: cached profile.json hash matches, skipping LLM');
        return { profile: cached, markdown, cached: true };
      }
    } catch {
      // Stale or corrupt cache — fall through to re-distill.
    }
  }

  const profile = await distillFromMarkdown(markdown);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2), 'utf-8');
  log.info(
    {
      name: profile.name,
      experience: profile.experience.length,
      projects: profile.projects.length,
      out: jsonPath,
    },
    'distill-profile: wrote profile.json',
  );
  return { profile, markdown, cached: false };
}

/**
 * Read the cached profile.json without distilling (errors if missing or stale).
 * For tools that should fail loudly if the user hasn't run `distill-profile`.
 */
export function loadProfileFromCache(): { profile: StructuredProfile; markdown: string } {
  const mdPath = profileMarkdownPath();
  const jsonPath = profileJsonPath();
  if (!fs.existsSync(mdPath)) {
    throw new Error(`profile.md not found at ${mdPath}.`);
  }
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`profile.json not found at ${jsonPath}. Run: career-ops distill-profile`);
  }
  const markdown = fs.readFileSync(mdPath, 'utf-8');
  const profile = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as StructuredProfile;
  if (profile.sourceMarkdownHash !== hashMarkdown(markdown)) {
    throw new Error(
      'profile.md has changed since last distillation. Run: career-ops distill-profile',
    );
  }
  return { profile, markdown };
}

/**
 * Idempotent helper used by downstream tools: distills if needed, returns
 * profile + raw markdown.
 */
export async function ensureProfile(): Promise<{ profile: StructuredProfile; markdown: string }> {
  const { profile, markdown } = await distillProfile();
  return { profile, markdown };
}
