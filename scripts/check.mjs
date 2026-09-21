import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
for (const directory of ['src', 'benchmarks', 'scripts']) {
  for (const file of readdirSync(directory)) {
    if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
  }
}
