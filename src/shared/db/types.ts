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

/** How a posting is applied to. Detected from the SEEK apply button. */
export type ApplyType = 'quick' | 'external' | 'unknown';

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
  /** 'quick' = on-SEEK quick apply, 'external' = employer site. null until detected. */
  applyType?: ApplyType | null;
  /** Destination when applyType === 'external'. */
  externalApplyUrl?: string | null;
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

/** How the auto-apply attempt was made. */
export type ApplyMethod = 'quick' | 'external';

/** Outcome of an auto-apply attempt. */
export type ApplyState = 'submitted' | 'filled_pending_review' | 'external_pending' | 'failed';

/** One employer screening question and the answer the agent submitted. */
export type ApplyAnswer = { question: string; answer: string; kind?: string };

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
  applyMethod: ApplyMethod | null;
  appliedAt: string | null;
  applyState: ApplyState | null;
  applyResumePath: string | null;
  applyAnswers: ApplyAnswer[] | null;
  applyError: string | null;
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

export type AgentRunStatus = 'running' | 'awaiting_human' | 'paused' | 'done' | 'failed';

/** Durable progress of an MCP agent-driven workflow run (no secrets stored). */
export type AgentRun = {
  runId: string;
  workflow: string | null;
  goal: string | null;
  vars: Record<string, unknown>;
  currentStep: string | null;
  status: AgentRunStatus;
  steps: Array<{ ts: string; note: string }>;
  startedAt: string;
  updatedAt: string;
};
