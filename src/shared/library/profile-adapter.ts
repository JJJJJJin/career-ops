// Adapter: ContentLibrary (profile_v3.md) → a profile context object for the
// two remaining LLM tools (match-job scoring, cover-letter drafting). These do
// NOT assemble résumé content — they reason over the candidate's facts — so a
// faithful projection of the library is all they need. This is the ONLY profile
// source now; the old distill-profile / profile.json path is gone.
import { ensureLibrary } from './parse.js';

export type ProfileContext = {
  name: string;
  headline: string;
  contact: {
    email: string | null;
    phone: string | null;
    location: string | null;
    linkedin: string | null;
    github: string | null;
    website: string | null;
  };
  summary: string;
  skills: Array<{ category: string; items: string[] }>;
  experience: Array<{
    role: string;
    company: string;
    period: string;
    location: string | null;
    highlights: string[];
    technologies: string[];
  }>;
  projects: Array<{
    name: string;
    description: string;
    highlights: string[];
    technologies: string[];
    link: string | null;
  }>;
  education: Array<{ degree: string; institution: string; period: string; details: string | null }>;
  certifications: string[];
  languages: string[];
  /** Content hash of profile_v3.md — used as the application's profile_hash. */
  sourceMarkdownHash: string;
};

/** Build the profile context from the vetted content library (profile_v3.md). */
export function ensureProfileFromLibrary(): { profile: ProfileContext; markdown: string } {
  const { library, markdown } = ensureLibrary();
  const profile: ProfileContext = {
    name: library.contact.name,
    headline: library.summaryVariants.backend ?? '',
    contact: {
      email: library.contact.email,
      phone: library.contact.phone,
      location: library.contact.location,
      linkedin: library.contact.linkedin,
      github: library.contact.github,
      website: null,
    },
    // All three positioning variants give the scorer/cover-letter full context.
    summary: Object.values(library.summaryVariants).filter(Boolean).join('\n\n'),
    skills: library.skills,
    experience: library.experience.map((e) => ({
      role: e.title,
      company: e.org ?? '',
      period: e.dates ?? '',
      location: e.location,
      highlights: e.bullets.map((b) => b.text),
      technologies: e.tech,
    })),
    projects: library.projects.map((p) => ({
      name: p.title,
      description: p.role ?? '',
      highlights: p.bullets.map((b) => b.text),
      technologies: p.tech,
      link: null,
    })),
    education: library.education.map((e) => ({
      degree: e.degree,
      institution: e.institution,
      period: e.dates ?? '',
      details: e.details,
    })),
    certifications: library.certifications,
    languages: library.languages,
    sourceMarkdownHash: library.sourceHash,
  };
  return { profile, markdown };
}
