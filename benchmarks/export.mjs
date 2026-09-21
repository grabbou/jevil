import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Public results deliberately exclude paths, device IDs, snapshots and error text.
export function publicResults({ metadata, rows }) {
  const keys = ['variant', 'scenario', 'round', 'status', 'oraclePassed', 'elapsedMs', 'oracleMs', 'observeMs', 'inferMs', 'actMs', 'requests', 'inputTokens', 'outputTokens', 'usageComplete', 'actions', 'snapshots', 'plannedFills', 'model', 'fullTrialWallMs', 'agentTotalMs'];
  return {
    metadata: Object.fromEntries(['createdAt', 'node', 'sdk', 'app', 'variants', 'rounds', 'scenarios', 'recording', 'purpose', 'simulator', 'warmRunner', 'seed', 'measurement', 'sourceHashes', 'pinnedModel'].map(key => [key, metadata[key]])),
    rows: rows.map(row => ({ ...Object.fromEntries(keys.map(key => [key, row[key]])), error: row.error ? 'See private run report (message excluded from public export)' : null })),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) throw new Error('Usage: node benchmarks/export.mjs <results.json> <public-results.json>');
  const data = publicResults(JSON.parse(await readFile(source, 'utf8')));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(data, null, 2) + '\n');
}
