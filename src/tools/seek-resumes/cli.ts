import { closeSession, launchSession } from '../../shared/browser/session.js';
import { config } from '../../shared/config.js';
import { ensureLoggedIn } from '../../shared/seek/auth.js';
import { getSavedResumes, rotateUploadResume } from '../../shared/seek/documents.js';
import { RESUME } from '../../shared/seek/selectors.js';

export async function runCli(argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'list';
  const headful = argv.includes('--headful') || argv.includes('--headed');

  const session = await launchSession({
    headless: headful ? false : config.browser.headless,
    storageStatePath: config.seek.authStatePath,
  });
  try {
    await ensureLoggedIn(session);

    if (sub === 'list') {
      const resumes = await getSavedResumes(session);
      process.stdout.write(`\nSaved resumés: ${resumes.length}/${RESUME.limit}\n`);
      for (const r of resumes) {
        process.stdout.write(`  ${r.isDefault ? '★' : ' '} ${r.filename}\n`);
      }
      if (resumes.length >= RESUME.limit) process.stdout.write(`\n  ⚠ at the limit — the next rotate will delete the oldest non-default\n`);
      return;
    }

    if (sub === 'rotate') {
      const pdfPath = argv.find((a, i) => i > 0 && !a.startsWith('--'));
      if (!pdfPath) {
        console.error('Usage: career-ops seek-resumes rotate <pdfPath> [--headful]');
        process.exit(2);
      }
      const r = await rotateUploadResume(session, pdfPath);
      if (r.deleted) process.stdout.write(`  🗑  deleted oldest: ${r.deleted}\n`);
      process.stdout.write(`  ⬆  uploaded: ${r.filename}\n  saved resumés now: ${r.count}/${RESUME.limit}\n`);
      return;
    }

    console.error(`Unknown subcommand "${sub}". Usage: career-ops seek-resumes [list | rotate <pdfPath>] [--headful]`);
    process.exit(2);
  } finally {
    await closeSession(session);
  }
}
