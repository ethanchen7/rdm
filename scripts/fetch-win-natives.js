#!/usr/bin/env node
// Cross-building a Windows package from macOS needs two runtime binaries
// that are platform-specific and don't get touched by @electron/rebuild
// (which only ever targets the host OS): sqlite3's native addon and the
// ffmpeg-static bundled executable. Both already support fetching a
// non-host platform/arch via the standard npm_config_platform/
// npm_config_arch override convention, so this fetches the win32/x64
// build of each directly into backend/node_modules right before packaging
// — no Windows machine needed for this part. bcrypt needs no action: it
// ships prebuilt binaries for every platform (including win32) bundled in
// the npm package itself, self-selected at require() time.
const { execFileSync } = require('child_process');
const path = require('path');

const backendNodeModules = path.join(__dirname, '..', 'backend', 'node_modules');
const env = { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' };

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
