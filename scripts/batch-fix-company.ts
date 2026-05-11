// Batch re-extract all jobs to fill company names using the fixed seek-extract.
// Visits each job page and uses the new companyFromVisibleText fallback.
import { seekExtract } from "../src/tools/seek-extract/index.js";
import { db } from "../src/shared/db/store.js";
import { createLogger } from "../src/shared/logger.js";

const log = createLogger("batch-fix");

const allJobs = db.listJobs();
const toFix = allJobs.filter(j => !j.job.company);

log.info({ total: allJobs.length, toFix: toFix.length }, "Starting batch re-extract");

let fixed = 0;
let failed = 0;

for (const { job } of toFix) {
  try {
    const result = await seekExtract(job.url, { reextract: true });
    if (result.company) {
      log.info({ jobId: job.jobId, title: result.title, company: result.company }, "✅ Fixed");
      fixed++;
    } else {
      log.warn({ jobId: job.jobId, title: result.title }, "⚠️ Still no company");
      failed++;
    }
  } catch (err) {
    log.error({ jobId: job.jobId, err: (err as Error).message }, "❌ Failed");
    failed++;
  }
  // Polite wait between pages
  await new Promise(r => setTimeout(r, 2000));
}

log.info({ fixed, failed }, "Batch re-extract complete");
