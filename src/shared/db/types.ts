// Domain types shared across tools. The DB row shapes mirror these closely;
// the store handles JSON-encoded columns (eligibility_flags, summary_json,
// match_json) so callers see typed objects.

export type EligibilityFlag = {
  flag:
    | 'AU_CITIZENSHIP_REQUIRED'
    | 'AU_CITIZENSHIP_OR_PR_REQUIRED'
    | 'SECURITY_CLEARANCE_REQUIRED'
    | 'NO_VISA_SPONSORSHIP';
  evidence: string;
};

/** Platform a job posting came from. Defaults to 'seek' for legacy rows. */
export type JobSourceName = 'seek' | 'linkedin' | 'indeed' | 'builtin';

export type Job = {
  jobId: string;
  source: JobSourceName;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  workType: string | null;
  classification: string | null;
  description: string;
  salaryText: string | null;
  postedDate: string | null;
  fetchedAt: string;
  eligibilityFlags: EligibilityFlag[];
};

/** Thin stub returned by a JobSource.search() call before the full extract. */
export type JobSearchStub = {
  jobId: string;
  source: JobSourceName;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  matchedKeyword: string;
  isNew: boolean;
};

export type JobSummary = {
  oneLineSummary: string;
  responsibilities: string[];
  mustHaveRequirements: string[];
  niceToHaveRequirements: string[];
  techStack: string[];
  domain: string;
  seniority: string;
};

export type StrengthCitation = { requirement: string; evidence: string };
export type GapCitation = { requirement: string; suggestion: string };

export type MatchAnalysis = {
  fitScore: number;            // 0-100
  scoreOutOf5: number;         // fitScore / 20, rounded to 0.1
  recommendation: 'STRONG' | 'BORDERLINE' | 'SKIP' | 'NOT_FOR_YOU';
  oneLineFit: string;
  strengths: StrengthCitation[];
  gaps: GapCitation[];
  transferableSkills: string[];
  keywordsToEmphasize: string[];
};

export type ApplicationStatus =
  | 'new'
  | 'interested'
  | 'applied'
  | 'interview'
  | 'rejected'
  | 'offer'
  | 'skip';

export type ApplicationRow = {
  jobId: string;
  fitScore: number | null;
  scoreOutOf5: number | null;
  recommendation: MatchAnalysis['recommendation'] | null;
  status: ApplicationStatus;
  oneLineFit: string | null;
  summary: JobSummary | null;
  match: MatchAnalysis | null;
  resumeMd: string | null;
  coverLetterMd: string | null;
  companyBriefMd: string | null;
  outputDir: string | null;
  generatedAt: string | null;
  model: string | null;
  profileHash: string | null;
  notes: string | null;
  updatedAt: string;
};

export type ScanRunRow = {
  id: number;
  ranAt: string;
  source: JobSourceName;
  keyword: string;
  location: string | null;
  days: number | null;
  jobsFound: number;
  jobsNew: number;
};

/**
 * A learned element selector for one flow step on one page shape. `action` is
 * stored as plain text (the agent layer owns the ActionType union); the DB
 * stays decoupled from the agent module.
 */
export type SelectorCacheEntry = {
  flowId: string;
  stepId: string;
  pageSig: string;
  action: string;
  locator: string | null;
  valueTmpl: string | null;
  confidence: number | null;
  hits: number;
};
