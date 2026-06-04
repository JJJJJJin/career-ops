// Tailored-résumé schema — produced by the deterministic assembler, consumed by
// render-resume-pdf. Persisted to output/<source>/<slug>/<slug>-resume.json.
// (Canonical home; the former generate-resume path has been removed.)
import type { Archetype } from '../../shared/library/types.js';

export type TailoredContact = {
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  linkedinDisplay: string | null;
  portfolioUrl: string | null;
  portfolioDisplay: string | null;
  github: string | null;
  /** e.g. "Full working rights in Australia (no sponsorship required)". */
  workRights: string | null;
};

export type TailoredExperience = {
  company: string;
  role: string;
  period: string;
  location: string | null;
  /** May contain inline **bold** for keyword emphasis. */
  highlights: string[];
};

export type TailoredProject = {
  name: string;
  /** Short tag like "Backend" or "AI / LLM". Optional. */
  badge: string | null;
  description: string;
  highlights: string[];
  technologies: string[];
};

export type TailoredEducation = {
  degree: string;
  institution: string;
  period: string;
  details: string | null;
};

export type TailoredSkillGroup = {
  category: string;
  items: string[];
};

export type TailoredResume = {
  name: string;
  contact: TailoredContact;
  summary: string;
  competencies: string[];
  experience: TailoredExperience[];
  projects: TailoredProject[];
  education: TailoredEducation[];
  certifications: string[];
  skills: TailoredSkillGroup[];
};

/** Per-JD assembly report: what was selected, what the JD wanted that we lack. */
export type AssemblyReport = {
  jobId: string;
  archetype: Archetype;
  summaryVariant: Archetype;
  selections: Array<{
    kind: 'experience' | 'project';
    title: string;
    picked: number;
    available: number;
    relevanceScore: number;
  }>;
  /** JD tech/requirements with no support in the library — feeds the gap tracker. */
  unmetRequirements: string[];
  synonymSwaps: Array<{ from: string; to: string }>;
  traceability: 'passed';
};
