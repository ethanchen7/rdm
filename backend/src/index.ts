/// <reference path="./guacamole-lite.d.ts" />
import express from 'express';
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import GuacamoleLite from 'guacamole-lite';
import { startSSMTunnel } from './ssmTunnel';
import { getWindowsPassword } from './passwordDecrypt';
import { initDb, addCustomInstance, updateCustomInstance, getCustomInstances, deleteCustomInstance, getCustomInstance, getAllEc2Settings, getEc2SettingFull, upsertEc2Setting } from './db';
// @ts-ignore
import Crypt from 'guacamole-lite/lib/Crypt';

dotenv.config();

const app = express();

// Optional built-in TLS so the app can run standalone over HTTPS — needed for
// browser clipboard sync (secure context) — without a reverse proxy in front.
// Point TLS_CERT/TLS_KEY at a cert + key (self-signed, mkcert, or a real cert);
// with neither set it serves plain HTTP. guacamole-lite attaches to whichever
// server is created below, so the WebSocket follows the same scheme (ws/wss).
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
let server: http.Server | https.Server;
if (TLS_CERT && TLS_KEY) {
    server = https.createServer(
        { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
        app
    );
    console.log('TLS enabled — serving HTTPS/WSS');
} else {
    server = http.createServer(app);
}

// Built by `npm run build` in ../frontend; nginx proxies /rdpm/ straight to
// this service (see ../../deploy.json), so the SPA is served from here too.
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');

app.use(cors());
app.use(express.json());

const ec2 = new EC2Client({});
// Cost Explorer is a global service that only lives in us-east-1.
const costExplorer = new CostExplorerClient({ region: 'us-east-1' });

// Key must be exactly 32 bytes for AES-256-CBC
const GUAC_CRYPT_KEY = process.env.GUAC_CRYPT_KEY || 'MySuperSecretKeyForGuacamoleLite';
const GUAC_CRYPT_CYPHER = 'AES-256-CBC';
const USE_SSM_TUNNEL = process.env.USE_SSM_TUNNEL === 'true';


app.get('/api/instances', async (req, res) => {
    try {
        const cmd = new DescribeInstancesCommand({
            Filters: [
                { Name: 'instance-state-name', Values: ['running', 'stopped', 'pending', 'stopping'] }
            ]
        });
        const response = await ec2.send(cmd);
        // Stored per-EC2 overrides (custom identifier / username / whether a
        // password is saved), merged into each discovered instance.
        const overrides = await getAllEc2Settings();
        const instances = [];

        for (const reservation of (response.Reservations || [])) {
            for (const instance of (reservation.Instances || [])) {
                // Find Name tag
                const nameTag = instance.Tags?.find(t => t.Key === 'Name');
                const ov = instance.InstanceId ? overrides[instance.InstanceId] : undefined;
                instances.push({
                    id: instance.InstanceId,
                    name: nameTag ? nameTag.Value : instance.InstanceId,
                    // User-set custom identifier override (falls back to the AWS
                    // Name tag in the UI when empty).
                    label: ov?.label || '',
                    username: ov?.username || '',
                    hasPassword: ov?.hasPassword || false,
                    state: instance.State?.Name,
                    // Why the instance is in that state (e.g.
                    // 'Server.InsufficientInstanceCapacity',
                    // 'Client.UserInitiatedShutdown'). AWS keeps the previous
                    // reason until the state actually changes, which is what
                    // lets the UI tell a failed start from one still in flight.
                    stateReasonCode: instance.StateReason?.Code || '',
                    stateReasonMessage: instance.StateReason?.Message || '',
                    privateIp: instance.PrivateIpAddress,
                    publicIp: instance.PublicIpAddress
                });
            }
        }
        
        // Sort by name
        instances.sort((a, b) => a.name!.localeCompare(b.name!));
        
        res.json(instances);
    } catch (err: any) {
        console.error('Error fetching instances:', err);
        res.status(500).json({ error: err.message });
    }
});

// Month-to-date AWS spend, shown in the header. Cost Explorer data can lag a
// few hours and requires the `ce:GetCostAndUsage` IAM permission, so any
// failure is reported as `available: false` rather than breaking the header.
app.get('/api/billing', async (req, res) => {
    try {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        // First day of the current month (UTC).
        const start = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`;
        // End is exclusive; use tomorrow so today's partial spend is included.
        const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const end = `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth() + 1)}-${pad(endDate.getUTCDate())}`;

        const cmd = new GetCostAndUsageCommand({
            TimePeriod: { Start: start, End: end },
            Granularity: 'MONTHLY',
            Metrics: ['UnblendedCost']
        });
        const response = await costExplorer.send(cmd);

        // Sum all buckets in the range (there may be more than one if the range
        // straddles a month boundary near midnight UTC).
        let amount = 0;
        let currency = 'USD';
        for (const bucket of (response.ResultsByTime || [])) {
            const cost = bucket.Total?.UnblendedCost;
            if (cost?.Amount) amount += parseFloat(cost.Amount);
            if (cost?.Unit) currency = cost.Unit;
        }

        res.json({ available: true, amount, currency, periodStart: start });
    } catch (err: any) {
        console.error('Error fetching billing:', err);
        res.json({ available: false, error: err.message });
    }
});

// Configure Guacamole Lite
const guacOptions = {
    crypt: {
        cypher: GUAC_CRYPT_CYPHER,
        key: GUAC_CRYPT_KEY
    },
    // 'DEBUG' logs every ping/nop frame on every connection — it filled a log
    // with gigabytes of noise. 'NORMAL' keeps connect/disconnect/errors only.
    log: {
        level: 'NORMAL'
    }
};

// guacd is the Guacamole proxy daemon that does the actual RDP; this service
// only brokers tokens and WebSockets. If it isn't running, the WebSocket opens
// and then dies without ever explaining itself, so it gets probed directly (see
// probeGuacd) and reported as its own error.
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = Number(process.env.GUACD_PORT) || 4822;
const GUACD_PROBE_TIMEOUT_MS = 2000;

const guacClientOptions = {
    host: GUACD_HOST,
    port: GUACD_PORT
};

// Opens and immediately drops a TCP connection to guacd. Enough to tell "not
// running / not reachable" from "running but the RDP target is refusing us",
// which are otherwise indistinguishable once the tunnel has been handed off.
const probeGuacd = () => new Promise<{ reachable: boolean; error?: string }>(resolve => {
    const socket = net.createConnection({ host: GUACD_HOST, port: GUACD_PORT });
    const settle = (result: { reachable: boolean; error?: string }) => {
        socket.destroy();
        resolve(result);
    };
    socket.setTimeout(GUACD_PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle({ reachable: true }));
    socket.once('timeout', () => settle({ reachable: false, error: `no response within ${GUACD_PROBE_TIMEOUT_MS}ms` }));
    socket.once('error', (err: NodeJS.ErrnoException) => settle({ reachable: false, error: err.code || err.message }));
});

const guacdUnreachableMessage = (error?: string) =>
    `guacd is unreachable at ${GUACD_HOST}:${GUACD_PORT}${error ? ` (${error})` : ''} — check that the guacd service is running.`;

// Polled by the frontend when a session dies, to say whether guacd was the
// reason rather than the remote desktop itself.
app.get('/api/guacd', async (req, res) => {
    const probe = await probeGuacd();
    res.json({
        reachable: probe.reachable,
        host: GUACD_HOST,
        port: GUACD_PORT,
        error: probe.reachable ? undefined : guacdUnreachableMessage(probe.error)
    });
});

// Constructing GuacamoleLite attaches the WebSocket handler to `server`; we
// don't need the returned instance (tokens are encrypted directly below).
new GuacamoleLite(
    { server },
    guacClientOptions,
    guacOptions,
    {}
);

app.get('/api/custom-instances', async (req, res) => {
    try {
        const instances = await getCustomInstances();
        res.json(instances);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/custom-instances', async (req, res) => {
    try {
        const { id, name, ip, username, password } = req.body;
        await addCustomInstance(id, name, ip, username, password);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/custom-instances/:id', async (req, res) => {
    try {
        const { name, ip, username, changePassword, password } = req.body;
        await updateCustomInstance(req.params.id, { name, ip, username, changePassword, password });
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/custom-instances/:id', async (req, res) => {
    try {
        await deleteCustomInstance(req.params.id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Save per-EC2 overrides (custom identifier, RDP username, optional password).
// Leaving the password blank means "use key.pem / RDP_PASSWORD" at connect time.
app.put('/api/ec2-settings/:id', async (req, res) => {
    try {
        const { label, username, changePassword, password } = req.body;
        await upsertEc2Setting(req.params.id, { label, username, changePassword, password });
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/connect', async (req, res) => {
    try {
        // Checked before any of the work below, so a stopped guacd is reported as
        // itself instead of as a session that opens and instantly vanishes.
        const probe = await probeGuacd();
        if (!probe.reachable) {
            return res.status(503).json({ error: guacdUnreachableMessage(probe.error) });
        }

        const { instanceId, customId, settings = {} } = req.body;

        let rdpHostname = '';
        let rdpPort = 3389;
        let dynamicPassword = '';
        let username = process.env.AWS_RDP_USERNAME || 'Administrator';

        if (customId) {
            const custom = await getCustomInstance(customId);
            if (!custom) {
                return res.status(404).json({ error: 'Custom instance not found' });
            }
            rdpHostname = custom.ip;
            dynamicPassword = custom.password || '';
            username = custom.username || 'Administrator';
        } else if (instanceId) {
            if (USE_SSM_TUNNEL) {
                rdpPort = await startSSMTunnel(instanceId);
                rdpHostname = '127.0.0.1';
            } else {
                const describeCmd = new DescribeInstancesCommand({
                    InstanceIds: [instanceId]
                });
                const ec2Res = await ec2.send(describeCmd);
                const inst = ec2Res.Reservations?.[0]?.Instances?.[0];

                if (!inst) {
                    return res.status(404).json({ error: 'Instance not found' });
                }

                rdpHostname = inst.PublicIpAddress || inst.PrivateIpAddress || '';
                if (!rdpHostname) {
                    return res.status(400).json({ error: 'Instance has no IP address' });
                }
            }

            // Per-instance overrides take priority: an explicit username and/or
            // a saved password entered in the instance settings modal.
            const ec2Setting = await getEc2SettingFull(instanceId);
            if (ec2Setting?.username) username = ec2Setting.username;

            if (ec2Setting?.password) {
                // User supplied a password explicitly — use it as-is.
                dynamicPassword = ec2Setting.password;
            } else {
                // Blank password → auto-decrypt via key.pem, else RDP_PASSWORD.
                const fetchedPassword = await getWindowsPassword(ec2, instanceId);
                dynamicPassword = fetchedPassword || process.env.RDP_PASSWORD || '';
            }
        } else {
            return res.status(400).json({ error: 'Missing instanceId or customId' });
        }
        
        // Prepare Guacamole connection settings for this tunnel
        const connectionSettings = {
            connection: {
                type: 'rdp',
                settings: {
                    hostname: rdpHostname,
                    port: rdpPort.toString(),
                    username: username,
                    password: dynamicPassword || '',
                    security: 'nla',
                    'ignore-cert': 'true',
                    width: '1920',
                    height: '1080',
                    'color-depth': settings.colorDepth || '32',
                    'enable-font-smoothing': settings.fontSmoothing !== false ? 'true' : 'false',
                    'enable-theming': 'true',
                    'enable-desktop-composition': 'true',
                    'enable-wallpaper': 'true'
                }
            }
        };

        // Encrypt the connection settings into a token
        const tokenCrypt = new Crypt(GUAC_CRYPT_CYPHER, GUAC_CRYPT_KEY);
        const token = tokenCrypt.encrypt(connectionSettings);
        
        res.json({ token, instanceId: instanceId || customId, port: rdpPort });
    } catch (err: any) {
        console.error('Error connecting:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/instances/start', async (req, res) => {
    const { instanceIds } = req.body;
    if (!instanceIds || !instanceIds.length) return res.status(400).json({ error: 'No instance IDs provided' });
    try {
        const cmd = new StartInstancesCommand({ InstanceIds: instanceIds });
        await ec2.send(cmd);
        res.json({ success: true });
    } catch (err: any) {
        console.error('Error starting instances:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/instances/stop', async (req, res) => {
    const { instanceIds } = req.body;
    if (!instanceIds || !instanceIds.length) return res.status(400).json({ error: 'No instance IDs provided' });
    try {
        const cmd = new StopInstancesCommand({ InstanceIds: instanceIds });
        await ec2.send(cmd);
        res.json({ success: true });
    } catch (err: any) {
        console.error('Error stopping instances:', err);
        res.status(500).json({ error: err.message });
    }
});

// Serve the built frontend. Must come after the /api/* routes above so those
// still take priority; the catch-all below is last so client-side routing
// (any non-API path) falls back to index.html.
app.use(express.static(FRONTEND_DIST));
// Express 5 (path-to-regexp v6+) requires a named wildcard — bare '*' throws
// at route registration.
app.get('/*splat', (req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));

const PORT = process.env.PORT || 3001;

initDb().then(() => {
    server.listen(PORT, () => {
        const scheme = (TLS_CERT && TLS_KEY) ? 'https' : 'http';
        console.log(`Server listening on ${scheme}://localhost:${PORT}`);
    });
}).catch(err => {
    console.error("Failed to initialize database:", err);
});
