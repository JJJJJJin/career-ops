// Deterministic parser: profile_v3.md → ContentLibrary. NO LLM. This is the
// trust boundary — everything downstream selects from what this produces, so
// the parse must be faithful and lossless for the fields it extracts.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { profileLibraryPath } from '../config.js';
import { createLogger } from '../logger.js';
import type {
  Archetype,
  ContentLibrary,
  LibraryBullet,
  LibraryEntry,
  SynonymGroup,
} from './types.js';

const log = createLogger('library');

function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Split markdown into top-level `## SECTION` blocks. */
function sectionize(md: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  let buf: string[] = [];
  for (const raw of md.split('\n')) {
    const m = raw.match(/^##\s+(.+?)\s*$/);
    if (m && !raw.startsWith('###')) {
      if (current) out.set(current, buf);
      current = m[1].trim().toUpperCase();
      buf = [];
    } else if (current) {
      buf.push(raw);
    }
  }
  if (current) out.set(current, buf);
  return out;
}

/** `- Key: value` → ['Key', 'value']; returns null if not that shape. */
function kv(line: string): [string, string] | null {
  const m = line.match(/^\s*-\s*([^:]+):\s*(.*)$/);
  if (!m) return null;
  return [m[1].trim(), m[2].trim()];
}

function parseContact(lines: string[]): ContentLibrary['contact'] {
  const c: ContentLibrary['contact'] = {
    name: '', email: null, phone: null, location: null,
    linkedin: null, github: null, workRights: null,
  };
  for (const line of lines) {
    const pair = kv(line);
    if (!pair) continue;
    const [k, v] = pair;
    const key = k.toLowerCase();
    if (key === 'name') c.name = v;
    else if (key === 'email') c.email = v;
    else if (key === 'phone') c.phone = v;
    else if (key === 'location') c.location = v;
    else if (key === 'linkedin') c.linkedin = v;
    else if (key === 'github') c.github = v;
    else if (key.startsWith('work')) c.workRights = v;
  }
  return c;
}

function parseSummaryVariants(lines: string[]): Record<Archetype, string> {
  const out: Record<Archetype, string> = { backend: '', 'full-stack': '', 'ai-agent': '' };
  let key: Archetype | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key) out[key] = buf.join(' ').replace(/\s+/g, ' ').trim();
    buf = [];
  };
  for (const raw of lines) {
    const h = raw.match(/^\*\*Summary variant:\s*([a-z-]+)\*\*\s*$/i);
    if (h) {
      flush();
      const name = h[1].toLowerCase();
      key = (name === 'fullstack' ? 'full-stack' : name) as Archetype;
      continue;
    }
    if (key) buf.push(raw.trim());
  }
  flush();
  return out;
}

function parseSkills(lines: string[]): Array<{ category: string; items: string[] }> {
  const out: Array<{ category: string; items: string[] }> = [];
  for (const line of lines) {
    const pair = kv(line);
    if (!pair) continue;
    const [category, rest] = pair;
    const items = rest.split(',').map((s) => s.trim()).filter(Boolean);
    if (items.length) out.push({ category, items });
  }
  return out;
}

/** Parse a `- [tag] [tag] text` bullet. */
function parseBullet(line: string): LibraryBullet | null {
  let s = line.replace(/^\s*-\s*/, '');
  if (!s) return null;
  const tags: string[] = [];
  let m: RegExpMatchArray | null;
  while ((m = s.match(/^\[([^\]]+)\]\s*/))) {
    tags.push(m[1].trim().toLowerCase());
    s = s.slice(m[0].length);
  }
  if (!tags.length) return null; // not a tagged bullet (e.g. a meta line)
  // Strip a leading conditional instruction parenthetical, e.g.
  // "(supplementary, junior/IT-leaning roles only) Also supported …".
  let conditional = false;
  const cond = s.match(/^\(([^)]*(?:supplementary|roles only)[^)]*)\)\s*/i);
  if (cond) {
    conditional = true;
    s = s.slice(cond[0].length);
  }
  return { text: s.trim(), tags, conditional };
}

/** Parse EXPERIENCE or PROJECTS section into entries. */
function parseEntries(lines: string[], kind: LibraryEntry['kind']): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  let cur: LibraryEntry | null = null;
  let inBullets = false;
  const push = () => { if (cur) entries.push(cur); };

  for (const raw of lines) {
    const head = raw.match(/^###\s+(.+?)\s*$/);
    if (head) {
      push();
      const titleLine = head[1].trim();
      let title = titleLine;
      let org: string | null = null;
      if (kind === 'experience') {
        const comma = titleLine.indexOf(',');
        if (comma !== -1) {
          title = titleLine.slice(0, comma).trim();
          org = titleLine.slice(comma + 1).trim();
        }
      }
      cur = { kind, title, org, location: null, dates: null, role: null, tech: [], note: null, bullets: [] };
      inBullets = false;
      continue;
    }
    if (!cur) continue;
    if (/^\s*Bullets:\s*$/i.test(raw)) { inBullets = true; continue; }

    if (!inBullets) {
      const pair = kv(raw);
      if (pair) {
        const [k, v] = pair;
        const key = k.toLowerCase();
        if (key === 'location') cur.location = v;
        else if (key === 'dates') cur.dates = v;
        else if (key === 'role') cur.role = v;
        else if (key === 'note') cur.note = v;
        else if (key === 'tech') cur.tech = v.split(',').map((s) => s.trim()).filter(Boolean);
      }
      continue;
    }
    const b = parseBullet(raw);
    if (b) cur.bullets.push(b);
  }
  push();
  return entries;
}

function parseEducation(lines: string[]): ContentLibrary['education'] {
  const out: ContentLibrary['education'] = [];
  let cur: ContentLibrary['education'][number] | null = null;
  const push = () => { if (cur) out.push(cur); };
  for (const raw of lines) {
    const head = raw.match(/^###\s+(.+?)\s*$/);
    if (head) {
      push();
      const t = head[1].trim();
      const comma = t.indexOf(',');
      cur = {
        degree: comma === -1 ? t : t.slice(0, comma).trim(),
        institution: comma === -1 ? '' : t.slice(comma + 1).trim(),
        dates: null,
        details: null,
      };
      continue;
    }
    if (!cur) continue;
    const pair = kv(raw);
    if (pair) {
      const [k, v] = pair;
      if (k.toLowerCase() === 'dates') cur.dates = v;
      else cur.details = cur.details ? `${cur.details} ${v}` : v;
    }
  }
  push();
  return out;
}

function parseSimpleList(lines: string[]): string[] {
  return lines
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter((l) => l && !l.startsWith('(')); // drop placeholders like "(add any…)"
}

/** Parse the synonym map out of the USAGE CONTRACT prose section. */
function parseSynonyms(md: string): SynonymGroup[] {
  const groups: SynonymGroup[] = [];
  const lines = md.split('\n');
  let inMap = false;
  for (const raw of lines) {
    if (/^\*\*Synonym map/i.test(raw.trim())) { inMap = true; continue; }
    if (inMap) {
      if (raw.startsWith('##') || raw.startsWith('---')) break;
      const item = raw.match(/^\s*-\s*(.+)$/);
      if (!item) continue;
      // A line may carry two groups separated by ';'.
      for (const part of item[1].split(';')) {
        const terms = part
          .split('==')
          .map((t) => t.replace(/\(.*?\)/g, '').trim()) // drop "(only if …)" qualifiers
          .filter(Boolean);
        if (terms.length >= 2) groups.push(terms);
      }
    }
  }
  return groups;
}

export function parseLibrary(md: string): ContentLibrary {
  const sections = sectionize(md);
  // Headings carry trailing parentheticals ("SKILLS (tagged superset …)"), so
  // match by prefix rather than exact string.
  const pick = (prefix: string): string[] => {
    for (const [name, lines] of sections) {
      if (name.startsWith(prefix)) return lines;
    }
    return [];
  };

  return {
    contact: parseContact(pick('CONTACT')),
    summaryVariants: parseSummaryVariants(pick('SUMMARY VARIANTS')),
    skills: parseSkills(pick('SKILLS')),
    experience: parseEntries(pick('EXPERIENCE'), 'experience'),
    projects: parseEntries(pick('PROJECTS'), 'project'),
    education: parseEducation(pick('EDUCATION')),
    languages: parseSimpleList(pick('LANGUAGES')),
    certifications: parseSimpleList(pick('CERTIFICATIONS')),
    synonyms: parseSynonyms(md),
    sourceHash: hash(md),
  };
}

let cache: { hash: string; library: ContentLibrary; markdown: string } | null = null;

/** Read + parse profile_v3.md, cached by content hash within the process. */
export function ensureLibrary(): { library: ContentLibrary; markdown: string } {
  const p = profileLibraryPath();
  if (!fs.existsSync(p)) {
    throw new Error(`content library not found at ${p}. Place profile_v3.md there (see refactor plan).`);
  }
  const md = fs.readFileSync(p, 'utf-8');
  const h = hash(md);
  if (cache && cache.hash === h) return { library: cache.library, markdown: cache.markdown };
  const library = parseLibrary(md);
  cache = { hash: h, library, markdown: md };
  log.info(
    {
      experience: library.experience.length,
      projects: library.projects.length,
      summaryVariants: Object.values(library.summaryVariants).filter(Boolean).length,
      synonymGroups: library.synonyms.length,
    },
    'library: parsed',
  );
  return { library, markdown: md };
}
