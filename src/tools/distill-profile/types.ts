// Structured profile shape — adapted from AutoBrowser. Variant project
// framings are preserved as a UNION of highlights/technologies in a single
// project entry; downstream resume generators pick the right subset per job.

export type ContactInfo = {
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin: string | null;
  github: string | null;
  website: string | null;
};

export type SkillGroup = {
  category: string;
  items: string[];
};

export type ExperienceEntry = {
  role: string;
  company: string;
  period: string;
  location: string | null;
  highlights: string[];
  technologies: string[];
};

export type ProjectEntry = {
  name: string;
  description: string;
  highlights: string[];
  technologies: string[];
  link: string | null;
};

export type EducationEntry = {
  degree: string;
  institution: string;
  period: string;
  details: string | null;
};

export type StructuredProfile = {
  name: string;
  headline: string;
  contact: ContactInfo;
  summary: string;
  skills: SkillGroup[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  education: EducationEntry[];
  certifications: string[];
  languages: string[];
  distilledAt: string;
  sourceMarkdownHash: string;
};
