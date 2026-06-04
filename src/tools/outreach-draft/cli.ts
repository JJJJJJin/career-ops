import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../shared/config.js';
import { draftOutreach, type OutreachContact } from './index.js';

// Usage:
//   career-ops outreach-draft <jobId> --contact "Name|Role|linkedin|note" [--contact ...]
//   career-ops outreach-draft <jobId> --contacts contacts.json
//
// contacts.json: [ { "name": "...", "role": "...", "channel": "linkedin", "note": "..." } ]
function parseContactFlag(s: string): OutreachContact {
  const [name, role, channel, note] = s.split('|').map((x) => x.trim());
  return {
    name,
    role: role || null,
    channel: channel === 'email' ? 'email' : 'linkedin',
    note: note || null,
  };
}

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  const contacts: OutreachContact[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--contact') contacts.push(parseContactFlag(argv[++i] ?? ''));
    else if (a === '--contacts') {
      const file = argv[++i];
      contacts.push(...(JSON.parse(fs.readFileSync(file, 'utf-8')) as OutreachContact[]));
    } else if (!a.startsWith('--')) jobId = a;
  }
  if (!jobId || !contacts.length) {
    console.error('Usage: career-ops outreach-draft <jobId> --contact "Name|Role|linkedin|note" [--contact ...]');
    console.error('   or: career-ops outreach-draft <jobId> --contacts contacts.json');
    process.exit(2);
  }

  const r = await draftOutreach(jobId, contacts);
  process.stdout.write(`✔ ${r.drafts.length} outreach draft(s) queued (NOT sent) → ${path.relative(config.repoRoot, r.filePath)}\n`);
  for (const d of r.drafts) {
    process.stdout.write(`\n— ${d.contactName}${d.contactRole ? ` (${d.contactRole})` : ''} · ${d.channel} · draft #${d.id}\n${d.message}\n`);
  }
  process.stdout.write(`\nReview, edit, and send yourself. Mark sent: (status tracked in DB).\n`);
}
