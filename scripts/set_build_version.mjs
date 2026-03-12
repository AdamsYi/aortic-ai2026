import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const wranglerPath = path.join(repoRoot, 'wrangler.toml');

const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8'
}).trim();

if (!hash) {
  throw new Error('failed_to_compute_git_hash');
}

const original = readFileSync(wranglerPath, 'utf8');
const updated = original.replace(/BUILD_VERSION = ".*?"/, `BUILD_VERSION = "${hash}"`);

if (updated === original) {
  throw new Error('failed_to_update_build_version_in_wrangler');
}

writeFileSync(wranglerPath, updated, 'utf8');
process.stdout.write(`${hash}\n`);
