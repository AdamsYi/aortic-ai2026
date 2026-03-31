import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const wranglerPath = path.join(repoRoot, 'wrangler.toml');
const workstationAssetsPath = path.join(repoRoot, 'src/generated/workstationAssets.ts');

const assetsSource = readFileSync(workstationAssetsPath, 'utf8');
const match = assetsSource.match(/export const WORKSTATION_BUILD_VERSION = "([^"]+)";/);
const hash = match ? match[1] : '';

if (!hash) {
  throw new Error('failed_to_read_workstation_build_version');
}

const original = readFileSync(wranglerPath, 'utf8');
if (!/BUILD_VERSION = ".*?"/.test(original)) {
  throw new Error('failed_to_find_build_version_in_wrangler');
}

const updated = original.replace(/BUILD_VERSION = ".*?"/, `BUILD_VERSION = "${hash}"`);
if (updated !== original) {
  writeFileSync(wranglerPath, updated, 'utf8');
}
process.stdout.write(`${hash}\n`);
