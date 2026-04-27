import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { buildDefaultCaseBundle } from './build_default_case_bundle.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..'); // scripts/build/../.. = repo root
const distRoot = path.join(repoRoot, 'dist');
const distAssetsRoot = path.join(distRoot, 'assets');
const wranglerPath = path.join(repoRoot, 'wrangler.toml');

const appEntry = path.join(repoRoot, 'apps/web/src/main.ts');
const workerEntry = path.join(repoRoot, 'apps/web/src/dicomZip.worker.ts');
const decodeWorkerEntry = path.join(repoRoot, 'node_modules/@cornerstonejs/dicom-image-loader/dist/esm/decodeImageFrameWorker.js');
const cssPath = path.join(repoRoot, 'apps/web/src/styles.css');
const publicRoot = path.join(repoRoot, 'apps/web/public');
const outputPath = path.join(repoRoot, 'src/generated/workstationAssets.ts');
const buildVersionInputPaths = [
  'apps/web',
  'cases/default_clinical_case',
  'schemas',
  'services/api',
  'src/index.ts',
  'scripts/build',
  'package.json',
  'package-lock.json',
  'tsconfig.workstation.json',
];

async function collectFiles(targetPath, acc = []) {
  const absPath = path.join(repoRoot, targetPath);
  const entries = await readdir(absPath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = path.posix.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(relPath, acc);
    } else if (entry.isFile()) {
      acc.push(relPath);
    }
  }
  return acc;
}

async function copyPublicAssets(sourceRoot, targetRoot, relative = '') {
  let entries = [];
  try {
    entries = await readdir(path.join(sourceRoot, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const nextRelative = path.join(relative, entry.name);
    const sourcePath = path.join(sourceRoot, nextRelative);
    const targetPath = path.join(targetRoot, nextRelative);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyPublicAssets(sourceRoot, targetRoot, nextRelative);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function listBuildVersionInputs() {
  const files = [];
  for (const inputPath of buildVersionInputPaths) {
    const absPath = path.join(repoRoot, inputPath);
    const info = await stat(absPath);
    if (info.isDirectory()) {
      await collectFiles(inputPath, files);
    } else if (info.isFile()) {
      files.push(inputPath);
    }
  }
  return files.sort();
}

async function computeContentFingerprint(paths) {
  const hash = createHash('sha256');
  for (const relPath of paths) {
    hash.update(relPath);
    hash.update('\0');
    const absPath = path.join(repoRoot, relPath);
    const contents = await readFile(absPath);
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

async function computeBuildVersion() {
  const inputs = await listBuildVersionInputs();
  if (!inputs.length) {
    throw new Error('failed_to_collect_build_inputs');
  }
  return computeContentFingerprint(inputs);
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function extractConst(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`export const ${escaped} = "([^"]*)";`));
  return match ? match[1] : null;
}

async function syncWranglerBuildVersion(buildVersion) {
  const original = await readFile(wranglerPath, 'utf8');
  if (!/BUILD_VERSION = ".*?"/.test(original)) {
    throw new Error('failed_to_find_build_version_in_wrangler');
  }
  const updated = original.replace(/BUILD_VERSION = ".*?"/, `BUILD_VERSION = "${buildVersion}"`);
  if (updated !== original) {
    await writeFile(wranglerPath, updated, 'utf8');
  }
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

const decodeWorkerBuild = await esbuild.build({
  entryPoints: [decodeWorkerEntry],
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

const css = await readFile(cssPath, 'utf8');
const appJs = appBuild.outputFiles[0].text;
const workerJs = workerBuild.outputFiles[0].text;
const decodeWorkerJs = decodeWorkerBuild.outputFiles[0].text;
const buildVersion = await computeBuildVersion();
const styleSha256 = sha256Hex(css);
const appSha256 = sha256Hex(appJs);
const workerSha256 = sha256Hex(workerJs);
const decodeWorkerSha256 = sha256Hex(decodeWorkerJs);
const assetDigest = sha256Hex(`${buildVersion}:${styleSha256}:${appSha256}:${workerSha256}:${decodeWorkerSha256}`);

await rm(distAssetsRoot, { recursive: true, force: true });
await mkdir(distAssetsRoot, { recursive: true });

const styleFileName = `style.${buildVersion}.css`;
const appFileName = `app.${buildVersion}.js`;
const dicomWorkerFileName = `dicom-zip-worker.${buildVersion}.js`;
const decodeWorkerFileName = 'decodeImageFrameWorker.js';

await writeFile(path.join(distAssetsRoot, styleFileName), css, 'utf8');
await writeFile(path.join(distAssetsRoot, appFileName), appJs, 'utf8');
await writeFile(path.join(distAssetsRoot, dicomWorkerFileName), workerJs, 'utf8');
await writeFile(path.join(distAssetsRoot, decodeWorkerFileName), decodeWorkerJs, 'utf8');
await copyPublicAssets(publicRoot, distRoot);

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
export const WORKSTATION_DECODE_WORKER_SHA256 = ${JSON.stringify(decodeWorkerSha256)};
export const WORKSTATION_ASSET_DIGEST = ${JSON.stringify(assetDigest)};
export const WORKSTATION_STYLE_PATH = ${JSON.stringify(`/assets/${styleFileName}`)};
export const WORKSTATION_APP_PATH = ${JSON.stringify(`/assets/${appFileName}`)};
export const WORKSTATION_DICOM_WORKER_PATH = ${JSON.stringify(`/assets/${dicomWorkerFileName}`)};
export const WORKSTATION_DECODE_WORKER_PATH = ${JSON.stringify(`/assets/${decodeWorkerFileName}`)};
`;

await writeFile(outputPath, moduleSource, 'utf8');
await syncWranglerBuildVersion(buildVersion);
console.log(`Generated ${path.relative(repoRoot, outputPath)} (${buildVersion})`);
