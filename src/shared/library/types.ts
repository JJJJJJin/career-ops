// Content-library data model. Parsed deterministically from profile_v3.md by
// parse.ts. The library is the SINGLE SOURCE OF TRUTH for resume content: the
// assembler may only SELECT, REORDER, PRUNE, and apply synonym swaps from this
// structure — it never generates new claims. See profile_v3.md USAGE CONTRACT.

/** JD archetype → picks the summary variant + default bullet ordering. */
export type Archetype = 'backend' | 'full-stack' | 'ai-agent';

export const ARCHETYPES: Archetype[] = ['backend', 'full-stack', 'ai-agent'];

export type LibraryContact = {
  name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin: string | null;
  github: string | null;
  workRights: string | null;
};

/** One pre-vetted atomic bullet with its selection tags. */
export type LibraryBullet = {
  /** Bullet text with the leading [tag] markers stripped. Verbatim otherwise. */
  text: string;
  /** Lowercased tags parsed from the leading [tag] [tag] markers. */
  tags: string[];
  /**
   * True when the bullet is marked conditional in the library, e.g.
   * "(supplementary, junior/IT-leaning roles only)". Such bullets are only
   * selected when the JD emphasis explicitly calls for them.
   */
  conditional: boolean;
};

/** An experience role or a project — same shape, different `kind`. */
export type LibraryEntry = {
  kind: 'experience' | 'project';
  /** Role title (experience) or descriptive project name. Used VERBATIM — no seniority change. */
  title: string;
  /** Company (experience) or null for projects. */
  org: string | null;
  location: string | null;
  dates: string | null;
  /** Project role/context line ("Scrum Master and backend developer, ..."). */
  role: string | null;
  /** Project tech list. */
  tech: string[];
  /** Honesty / usage note from the library (not rendered). */
  note: string | null;
  bullets: LibraryBullet[];
};

export type LibraryEducation = {
  degree: string;
  institution: string;
  dates: string | null;
  details: string | null;
};

/** A set of terms that all denote the same real thing (safe to swap). */
export type SynonymGroup = string[];

export type ContentLibrary = {
  contact: LibraryContact;
  /** Exactly one is selected per resume; used verbatim modulo synonym swaps. */
  summaryVariants: Record<Archetype, string>;
  skills: Array<{ category: string; items: string[] }>;
  experience: LibraryEntry[];
  projects: LibraryEntry[];
  education: LibraryEducation[];
  languages: string[];
  certifications: string[];
  synonyms: SynonymGroup[];
  /** sha-256 (truncated) of the source markdown, for cache invalidation. */
  sourceHash: string;
};
