import path from 'node:path';
import { config } from '../../shared/config.js';
import { generateCompanyBrief } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let companyWebsite: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--company-website' || a === '--url') {
      companyWebsite = argv[i + 1];
      i++;
    } else if (a && !a.startsWith('--')) jobId = a;
  }
  if (!jobId) {
    console.error('Usage: career-ops generate-company-brief <jobId> [--company-website <url>] [--force]');
    process.exit(2);
  }

  const r = await generateCompanyBrief(jobId, { companyWebsite, force });
  process.stdout.write(`✔ company_brief.md → ${path.relative(config.repoRoot, r.outputDir)}/\n`);
  if (r.groundedBy) process.stdout.write(`  grounded by: ${r.groundedBy}\n`);
  process.stdout.write(`  things to verify: ${r.brief.thingsToVerify.length}\n`);
}
