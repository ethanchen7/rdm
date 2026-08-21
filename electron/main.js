// Electron main process — runs the existing Express backend in-process (this
// process is just Node) and opens a BrowserWindow pointed at it, so the app
// is a real double-click-to-run desktop app instead of "start a server, then
// open a browser tab". No preload/IPC bridge is needed: the loaded page is
// the same app that already works standalone in a browser, login flow and
// all — it's just being shown in a native window here.
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { execFileSync } = require('child_process');

const PRODUCT_NAME = 'RDm';
const PREFERRED_PORT = 3010;

app.setName(PRODUCT_NAME);

// --- macOS PATH fix -------------------------------------------------------
// GUI apps launched from Finder/Dock on macOS get a minimal PATH (usually
// just /usr/bin:/bin:/usr/sbin:/sbin) — missing /usr/local/bin and
// /opt/homebrew/bin, where Docker Desktop's `docker` CLI and the `aws` CLI
// typically live. Without this, the guacd Start/Stop/Restart buttons (which
// shell out to `docker`) and the optional SSM tunnel (`aws`) would silently
// fail only in the packaged app, never in `npm run start:backend` or
// `electron .` from a terminal. Capture the user's real login-shell PATH
// once and merge it in before the backend (or anything it spawns) runs.
function fixMacPath() {
    if (process.platform !== 'darwin') return;
    try {
        const shell = process.env.SHELL || '/bin/zsh';
        const shellPath = execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], {
            encoding: 'utf8',
            timeout: 5000,
        }).trim();
        if (!shellPath) return;
        const merged = new Set([...(process.env.PATH || '').split(':'), ...shellPath.split(':')].filter(Boolean));
        process.env.PATH = [...merged].join(':');
    } catch (err) {
        console.error('[rdm] could not determine login shell PATH (docker/aws CLI detection may be affected):', err);
    }
}

// --- first-run config -------------------------------------------------------
// Generates a fresh 32-character GUAC_CRYPT_KEY (24 random bytes, base64url —
// 24*8/6 = 32 chars with no padding, matching the exact-32-chars requirement
// documented in .env.example) so every install gets a unique key without any
// user action, mirroring what the README tells self-hosters to do by hand.
function ensureEnvFile(dataDir, envExamplePath) {
    const envPath = path.join(dataDir, '.env');
    if (fs.existsSync(envPath)) return;
    fs.mkdirSync(dataDir, { recursive: true });
    const key = crypto.randomBytes(24).toString('base64url');
    const template = fs.readFileSync(envExamplePath, 'utf8');
    const contents = template.replace(
        'GUAC_CRYPT_KEY=change_me_to_a_random_32_byte_key',
        `GUAC_CRYPT_KEY=${key}`
    );
    fs.writeFileSync(envPath, contents);
}

function waitForServer(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tryConnect = () => {
            const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
                socket.end();
                resolve();
            });
            socket.on('error', () => {
                socket.destroy();
                if (Date.now() > deadline) reject(new Error(`Backend did not start listening on port ${port} in time`));
                else setTimeout(tryConnect, 150);
            });
        };
        tryConnect();
    });
}

function buildMenu(dataDir) {
    const template = [
        ...(process.platform === 'darwin'
            ? [{
                label: PRODUCT_NAME,
                submenu: [
                    { role: 'about' },
                    { type: 'separator' },
                    { role: 'hide' },
                    { role: 'hideOthers' },
                    { role: 'unhide' },
                    { type: 'separator' },
                    { role: 'quit' },
                ],
            }]
            : []),
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
                { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Open Config Folder',
                    // Where .env / key.pem / TLS certs / rdm.sqlite live for this
                    // install — the primary way to set AWS credentials etc. today
                    // (edit the file, then relaunch the app to pick up changes).
                    click: () => shell.openPath(dataDir),
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
    fixMacPath();

    const dataDir = app.getPath('userData');
    const backendDir = app.isPackaged
        ? path.join(process.resourcesPath, 'backend')
        : path.join(__dirname, '..', 'backend');

    ensureEnvFile(dataDir, path.join(backendDir, '.env.example'));

    // get-port is ESM-only (no `require()`) — a dynamic import works from
    // this CommonJS file. Also a root dependency (not just backend's) so it
    // resolves here regardless of packaged vs. dev layout.
    const { default: getPort } = await import('get-port');
    const port = await getPort({ port: [PREFERRED_PORT, ...Array.from({ length: 20 }, (_, i) => PREFERRED_PORT + i + 1)] });

    process.env.RDM_DATA_DIR = dataDir;
    process.env.PORT = String(port);

    require(path.join(backendDir, 'dist', 'index.js'));

    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        title: PRODUCT_NAME,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    buildMenu(dataDir);

    await waitForServer(port, 15000);
    await win.loadURL(`http://127.0.0.1:${port}/`);
    win.show();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });

    app.whenReady().then(main).catch((err) => {
        console.error('[rdm] failed to start:', err);
        app.quit();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) main();
    });
}
