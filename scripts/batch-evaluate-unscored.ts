import { evaluateJob } from '../src/tools/evaluate-job/index.js';

const jobIds = [
  '92367093','92357981','92358668','92359168','92361479','92362799','92364744',
  '92364268','92364491','92364575','92364603','92364615','92364820','92365291',
  '92365513','92365516','92365790','92366703','92366944','92368017','92368503',
  '92368502','92368908','92357101','92358990','92360478','92360617','92360826',
  '92360900','92360761','92368418','92361131','92361204','92360983','92361239',
  '92361500','92362321','92362312','92362554','92362517','92362466','92362954',
  '92363130','92363850','92364223','92364476','92364681','92364731','92364802',
  '92365472','92365559','92366959',
];

async function main() {
  console.log(`Batch-evaluating ${jobIds.length} unscored jobs...\n`);

  let done = 0;
  for (const id of jobIds) {
    try {
      const result = await evaluateJob(id);
      done++;
      const score = result.match?.scoreOutOf5 ?? '?';
      const rec = result.match?.recommendation ?? '?';
      const title = result.job?.title ?? '?';
      console.log(`[${done}/${jobIds.length}] ${score}/5 ${rec} — ${(title || '').slice(0,60)}`);
    } catch (err: any) {
      done++;
      console.error(`[${done}/${jobIds.length}] ERROR — ${id}: ${err.message || err}`);
    }
  }

  console.log(`\nDone. Evaluated ${done}/${jobIds.length} jobs.`);
  process.exit(0);
}

main();
