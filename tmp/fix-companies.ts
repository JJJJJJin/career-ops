// Batch fix all NULL companies in existing jobs.
// Uses heuristics on the already-stored description text, LLM fallback only when needed.
import { db } from "../../shared/db/store.js";
import { callJson } from "../../shared/llm/client.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("fix-companies");

function heuristicCompany(description: string, title: string): string | null {
  const lines = description.split('\n').filter(l => l.trim());
  
  // Strategy 1: Check if title appears in description, get next line
  const titleIdx = lines.findIndex(l => l.includes(title));
  if (titleIdx >= 0 && titleIdx + 1 < lines.length) {
    const candidate = lines[titleIdx + 1].trim();
    if (candidate && candidate.length > 2 && !/^\d/.test(candidate) && !candidate.startsWith('About')) {
      return candidate;
    }
  }

  // Strategy 2: First line that ends with common company suffixes
  const companyPattern = /(?:Pty\s+Ltd|Limited|Corporation|Corp|Inc\.?|LLC|Group|Ltd\.?|GmbH|SA|AB|OY)$/i;
  for (const line of lines.slice(0, 5)) {
    if (companyPattern.test(line.trim()) && line.trim().length < 100) {
      return line.trim();
    }
  }

  // Strategy 3: First line that starts with a company-like pattern
  // e.g., "CompanyName (NASDAQ:" or "CompanyName is a..."
  const firstLine = lines[0];
  if (firstLine) {
    const m = firstLine.match(/^([A-Z][A-Za-z\s\-&.]{2,60}?)(?:\s*\(|\s+is\s|\s+are\s)/);
    if (m) return m[1].trim();
  }

  return null;
}

// Get all jobs with null/empty company
const allJobs = db.listJobs();
const nullCompanyJobs = allJobs.filter(j => !j.job.company);

log.info({ total: allJobs.length, toFix: nullCompanyJobs.length }, "Starting batch company fix");

let fixed = 0;
let llmFixed = 0;
let skipped = 0;

// Open a single connection for batch updates
const Database = (await import("better-sqlite3")).default;
const { config } = await import("../../shared/config.js");
const writeDb = new Database(config.paths.dbPath);

for (const { job } of nullCompanyJobs) {
  let company = heuristicCompany(job.description, job.title);
  
  if (!company) {
    // LLM fallback
    try {
      const result = await callJson<{ company: string | null }>({
        step: "fix-companies:extract",
        systemPrompt: "Extract the hiring company name from this job description. Return JSON: {\"company\": string|null}",
        userPrompt: `Job title: ${job.title}\n\nFull description:\n${job.description.substring(0, 2000)}`,
      });
      company = result.company ?? null;
      if (company) llmFixed++;
    } catch {
      // skip
    }
  }
  
  if (company) {
    writeDb.prepare("UPDATE jobs SET company = ? WHERE job_id = ?").run(company, job.jobId);
    log.info({ jobId: job.jobId, title: job.title, company }, "Fixed");
    fixed++;
  } else {
    log.warn({ jobId: job.jobId, title: job.title }, "Could not extract company");
    skipped++;
  }
}

writeDb.close();
log.info({ fixed, llmFixed, skipped }, "Batch company fix complete");
