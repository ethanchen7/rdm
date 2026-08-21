#!/usr/bin/env node
// Cross-building a Windows package from macOS needs two runtime binaries
// that are platform-specific and don't get touched by @electron/rebuild
// (which only ever targets the host OS): sqlite3's native addon and the
// ffmpeg-static bundled executable. Both already support fetching a
// non-host platform/arch via the standard npm_config_platform/
// npm_config_arch override convention, so this fetches the win32/x64
// build of each directly into backend/node_modules right before packaging
// — no Windows machine needed for this part. bcrypt ships prebuilt binaries
// for every platform (including win32) bundled in the npm package itself,
// self-selected at require() time — see the build/ cleanup below though.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const backendNodeModules = path.join(__dirname, '..', 'backend', 'node_modules');
const env = { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' };

// bcrypt's loader (node-gyp-build) checks build/Release/*.node BEFORE its own
// bundled prebuilds/<platform>-<arch>/ directory. If anything ever compiles
// bcrypt from source for another platform (e.g. `electron-rebuild` run for
// the macOS build), that leftover build/Release output shadows the correct
// platform's prebuild here and crashes at runtime with "not a valid Win32
// application". bcrypt never needs building — remove any stale build output
// so it always falls through to the bundled prebuilds.
const bcryptBuildDir = path.join(backendNodeModules, 'bcrypt', 'build');
if (fs.existsSync(bcryptBuildDir)) {
    console.log('[fetch-win-natives] removing stale bcrypt/build (would shadow the win32 prebuild)...');
    fs.rmSync(bcryptBuildDir, { recursive: true, force: true });
}

console.log('[fetch-win-natives] sqlite3 (win32-x64, N-API prebuild)...');
execFileSync(
    process.execPath,
    [path.join(backendNodeModules, '.bin', 'prebuild-install'), '-r', 'napi', '--platform=win32', '--arch=x64', '--force'],
    { cwd: path.join(backendNodeModules, 'sqlite3'), env, stdio: 'inherit' }
);

console.log('[fetch-win-natives] ffmpeg-static (win32-x64)...');
execFileSync(
    process.execPath,
    [path.join(backendNodeModules, 'ffmpeg-static', 'install.js')],
    { cwd: path.join(backendNodeModules, 'ffmpeg-static'), env, stdio: 'inherit' }
);

console.log('[fetch-win-natives] done.');
