import { seekExtract } from '../src/tools/seek-extract/index.js';

const jobIds = [ '92366959','92365559','92365472','92364802','92364731','92364681','92364476','92364223','92363850','92363130','92362954','92362466','92362517','92362554','92362312','92362321','92361500','92361239','92360983','92361204','92360761','92368418','92361131','92360826','92360900','92360617','92360478','92358990','92357101','92368908','92368502','92368503','92368017','92366944','92366703','92365790','92365516','92365513','92365291','92364820','92364615','92364603','92364575','92364491','92364268','92364744','92362799','92361479','92359168','92358668','92357981' ];

async function main() {
  console.log(`Batch-extracting ${jobIds.length} jobs...\n`);

  let done = 0;
  for (const id of jobIds) {
    try {
      const result = await seekExtract(`https://www.seek.com.au/job/${id}`);
      done++;
      console.log(`[${done}/${jobIds.length}] ✅ ${id} — ${(result.title || '').slice(0,50)}`);
    } catch (err: any) {
      done++;
      console.warn(`[${done}/${jobIds.length}] ⚠️ ${id}: ${err.message || err}`);
    }
  }

  console.log(`\nDone. Extracted ${done}/${jobIds.length} jobs.`);
  process.exit(0);
}

main();
