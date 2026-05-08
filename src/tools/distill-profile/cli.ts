import { distillProfile } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const json = argv.includes('--json');

  const { profile, cached } = await distillProfile({ force });

  if (json) {
    process.stdout.write(JSON.stringify(profile, null, 2) + '\n');
    return;
  }

  process.stdout.write(`✔ ${cached ? 'cached' : 'distilled'} profile for ${profile.name || '(no name)'}\n`);
  process.stdout.write(`  hash:        ${profile.sourceMarkdownHash}\n`);
  process.stdout.write(`  experience:  ${profile.experience.length} role(s)\n`);
  process.stdout.write(`  projects:    ${profile.projects.length}\n`);
  process.stdout.write(`  skills:      ${profile.skills.reduce((n, g) => n + g.items.length, 0)} across ${profile.skills.length} group(s)\n`);
  process.stdout.write(`  education:   ${profile.education.length}\n`);
}
