import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { buildDefaultCaseBundle } from './build_default_case_bundle.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const appEntry = path.join(repoRoot, 'apps/web/src/main.ts');
const workerEntry = path.join(repoRoot, 'apps/web/src/dicomZip.worker.ts');
const cssPath = path.join(repoRoot, 'apps/web/src/styles.css');
const outputPath = path.join(repoRoot, 'src/generated/workstationAssets.ts');
const generatedIgnore = new Set([
  'src/generated/workstationAssets.ts',
  'src/generated/defaultCaseBundle.ts',
]);

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function runGitBuffer(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'buffer',
  });
}

function listDirtyPaths() {
  const tracked = runGitBuffer(['diff', '--name-only', '-z', 'HEAD', '--']).toString('utf8').split('\0').filter(Boolean);
  const untracked = runGitBuffer(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked])]
    .filter((candidate) => !generatedIgnore.has(candidate))
    .sort();
}

async function computeDirtyFingerprint(paths) {
  const hash = createHash('sha256');
  for (const relPath of paths) {
    hash.update(relPath);
    hash.update('\0');
    const absPath = path.join(repoRoot, relPath);
    try {
      const contents = await readFile(absPath);
      hash.update(contents);
    } catch {
      hash.update('DELETED');
    }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 8);
}

async function computeBuildVersion() {
  const head = runGit(['rev-parse', '--short', 'HEAD']);
  if (!head) {
    throw new Error('failed_to_compute_git_head');
  }
  const dirtyPaths = listDirtyPaths();
  if (!dirtyPaths.length) return head;
  return computeDirtyFingerprint(dirtyPaths).then((fingerprint) => `${head}-dirty-${fingerprint}`);
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function extractConst(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`export const ${escaped} = "([^"]*)";`));
  return match ? match[1] : null;
}

const browserBuiltinShimPlugin = {
  name: 'browser-builtin-shim',
  setup(build) {
    const builtins = new Set(['fs', 'path', 'module', 'worker_threads']);
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!builtins.has(args.path)) return null;
      return { path: args.path, namespace: 'browser-builtin-shim' };
    });
    build.onLoad({ filter: /.*/, namespace: 'browser-builtin-shim' }, ({ path: shimPath }) => {
      if (shimPath === 'path') {
        return {
          contents: `
            const passthrough = (value = '') => String(value);
            export const normalize = passthrough;
            export const dirname = () => '';
            export const join = (...parts) => parts.filter(Boolean).join('/');
            export default { normalize, dirname, join };
          `,
          loader: 'js',
        };
      }
      return {
        contents: `
          const unavailable = () => { throw new Error(${JSON.stringify(`${shimPath} is unavailable in the browser workstation bundle`)}); };
          export const readFileSync = unavailable;
          export const readFile = unavailable;
          export const existsSync = () => false;
          export default {};
        `,
        loader: 'js',
      };
    });
  },
};

const appBuild = await esbuild.build({
  entryPoints: [appEntry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  write: false,
  logLevel: 'silent',
  loader: { '.wasm': 'dataurl' },
  plugins: [browserBuiltinShimPlugin],
  conditions: ['browser'],
  mainFields: ['browser', 'module', 'main'],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});

const workerBuild = await esbuild.build({
  entryPoints: [workerEntry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  write: false,
  logLevel: 'silent',
});

const css = await readFile(cssPath, 'utf8');
const appJs = appBuild.outputFiles[0].text;
const workerJs = workerBuild.outputFiles[0].text;
const buildVersion = await computeBuildVersion();
const styleSha256 = sha256Hex(css);
const appSha256 = sha256Hex(appJs);
const workerSha256 = sha256Hex(workerJs);
const assetDigest = sha256Hex(`${buildVersion}:${styleSha256}:${appSha256}:${workerSha256}`);

await buildDefaultCaseBundle({ buildVersion });

let existingOutput = '';
try {
  existingOutput = await readFile(outputPath, 'utf8');
} catch {
  existingOutput = '';
}

const previousBuildVersion = extractConst(existingOutput, 'WORKSTATION_BUILD_VERSION');
const previousAssetDigest = extractConst(existingOutput, 'WORKSTATION_ASSET_DIGEST');
if (
  existingOutput
  && previousBuildVersion === buildVersion
  && previousAssetDigest
  && previousAssetDigest !== assetDigest
) {
  throw new Error(
    `build_version_reuse_detected:${buildVersion}:${previousAssetDigest}:${assetDigest}`
  );
}

const moduleSource = `// Auto-generated by scripts/build_workstation.mjs
export const WORKSTATION_BUILD_VERSION = ${JSON.stringify(buildVersion)};
export const WORKSTATION_STYLE_SHA256 = ${JSON.stringify(styleSha256)};
export const WORKSTATION_APP_SHA256 = ${JSON.stringify(appSha256)};
export const WORKSTATION_DICOM_WORKER_SHA256 = ${JSON.stringify(workerSha256)};
export const WORKSTATION_ASSET_DIGEST = ${JSON.stringify(assetDigest)};
export const WORKSTATION_STYLE_CSS = ${JSON.stringify(css)};
export const WORKSTATION_APP_JS = ${JSON.stringify(appJs)};
export const WORKSTATION_DICOM_WORKER_JS = ${JSON.stringify(workerJs)};
`;

await writeFile(outputPath, moduleSource, 'utf8');
console.log(`Generated ${path.relative(repoRoot, outputPath)} (${buildVersion})`);
