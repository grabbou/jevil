import { readFile, writeFile } from 'node:fs/promises';
import { summarize, renderMarkdown } from './stats.mjs';

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node benchmarks/analyze.mjs results.json [report.md|summary.json]');
  process.exitCode = 1;
} else {
  const content = JSON.parse(await readFile(input, 'utf8'));
  const result = summarize(Array.isArray(content) ? content : content.rows);
  const rendered = output?.endsWith('.json') ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result);
  if (output) await writeFile(output, rendered);
  else process.stdout.write(rendered);
}
