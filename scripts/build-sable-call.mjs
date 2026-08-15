#!/usr/bin/env node
/* oxlint-disable no-console */

// Builds the SableCall embedded bundle from source and places it where the
// Sable Vite build expects it (public/element-call — git-ignored).
//
// This lets a fork ship its own SableCall build without publishing to npm.
//
// Configuration (all optional):
//   SABLE_CALL_REPO  - git URL of the SableCall repo to clone (default: your fork)
//   SABLE_CALL_REF   - branch/tag/commit to check out (default: the repo's default branch)
//   SABLE_CALL_DIR   - path to an existing local SableCall checkout; when set, the
//                      repo is NOT cloned and this directory is used directly.
//
// The built embedded bundle is copied into public/element-call (git-ignored), the
// exact location the vite copy step in vite.config.ts expects. The published
// @sableclient/sable-call-embedded npm package is never modified, so local dev
// that only runs `pnpm install` keeps working with the published bundle.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = process.env.SABLE_CALL_REPO || 'https://github.com/TomOdellSheetMusic/SableCall.git';
const REF = process.env.SABLE_CALL_REF || '';
const LOCAL_DIR = process.env.SABLE_CALL_DIR || '';

// Where the fork's embedded bundle is placed. This is a git-ignored dir,
// deliberately NOT inside node_modules: we must never clobber the published
// @sableclient/sable-call-embedded package, otherwise a normal `pnpm install`
//-only local dev setup (which uses the published 1.1.8 bundle) would silently
// lose it and require a fork build to work again.
const TARGET_DIR = resolve('public/element-call');

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// Run a pnpm command inside the SableCall checkout using the pnpm version that
// SableCall pins in its own package.json ("packageManager"), rather than the
// pnpm that happens to be on the PATH (which is Sable's own pin). The two
// projects pin different pnpm major versions, and the SableCall lockfile (made
// with pnpm 11) contains git-hosted deps like matrix-js-sdk@github:...#develop
// (v41.7.0) that Sable's older pnpm 10 cannot parse (ERR_PNPM_INVALID_VERSION_UNION).
// Invoking via corepack lets corepack read SableCall's "packageManager" field
// and use its exact pinned pnpm, keeping the two projects' toolchains decoupled.
function runPnpm(cwd, ...args) {
  run(`corepack pnpm ${args.join(' ')}`, cwd);
}

let sourceDir;
let cleanupDir = null;

try {
  if (LOCAL_DIR) {
    sourceDir = resolve(LOCAL_DIR);
    if (!existsSync(sourceDir)) {
      console.error(`SABLE_CALL_DIR does not exist: ${sourceDir}`);
      process.exit(1);
    }
    console.log(`Using local SableCall checkout at ${sourceDir}`);
  } else {
    cleanupDir = mkdtempSync(join(tmpdir(), 'sable-call-'));
    sourceDir = join(cleanupDir, 'SableCall');
    console.log(`Cloning ${REPO} into ${sourceDir}`);
    run(`git clone --depth 1 ${REF ? `--branch ${REF}` : ''} "${REPO}" "${sourceDir}"`);
  }

  // Install dependencies and build the embedded bundle. Use SableCall's own
  // pinned pnpm (via corepack) so the frozen lockfile install is run with a
  // compatible pnpm version.
  runPnpm(sourceDir, 'install', '--frozen-lockfile');
  runPnpm(sourceDir, 'build:embedded:production');

  const builtDist = join(sourceDir, 'dist');
  if (!existsSync(builtDist)) {
    console.error(`SableCall embedded build produced no dist/ at ${builtDist}`);
    process.exit(1);
  }

  // Replace the embedded bundle in the git-ignored target dir (public/element-call
  // is the exact location vite expects the bundle at, and is git-ignored). The
  // installed npm package is left untouched so local dev without a fork build
  // still works.
  rmSync(TARGET_DIR, { recursive: true, force: true });
  cpSync(builtDist, TARGET_DIR, { recursive: true });
  console.log(`\nCopied SableCall embedded build to ${TARGET_DIR}`);
} finally {
  if (cleanupDir) {
    rmSync(cleanupDir, { recursive: true, force: true });
  }
}
