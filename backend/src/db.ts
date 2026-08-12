import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// Key must be exactly 32 bytes for AES-256-CBC
const DB_CRYPT_KEY = Buffer.from((process.env.GUAC_CRYPT_KEY || 'MySuperSecretKeyForGuacamoleLite').padEnd(32, '0').slice(0, 32));

export let db: any = null;

export async function initDb() {
    db = await open({
        filename: path.join(__dirname, '..', 'rdm.sqlite'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS custom_instances (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ip TEXT NOT NULL,
            username TEXT NOT NULL,
            encrypted_password TEXT,
            protocol TEXT NOT NULL DEFAULT 'rdp'
        );
    `);

    // CREATE TABLE IF NOT EXISTS doesn't add columns to a table that already
    // exists from before `protocol` was introduced — migrate those in place.
    const customCols = await db.all(`PRAGMA table_info(custom_instances)`);
    if (!customCols.some((c: any) => c.name === 'protocol')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN protocol TEXT NOT NULL DEFAULT 'rdp'`);
    }
    // `os` drives the sidebar OS icon and gates the macOS-only Ctrl/Cmd swap;
    // `swap_keys` is that swap itself, only meaningful (and only editable) when
    // os = 'macos'. Reliable OS detection isn't available from guacd/VNC/RDP,
    // so both are plain user-set fields, same as protocol.
    if (!customCols.some((c: any) => c.name === 'os')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN os TEXT NOT NULL DEFAULT ''`);
    }
    if (!customCols.some((c: any) => c.name === 'swap_keys')) {
        await db.exec(`ALTER TABLE custom_instances ADD COLUMN swap_keys INTEGER NOT NULL DEFAULT 0`);
    }

    // Per-EC2 credential/label overrides. EC2 instances are discovered from AWS
    // (not stored), so this table only holds the bits the user can edit: a
    // display label ("custom identifier"), an RDP username, and an optional
    // password. A blank/absent password means "fall back to key.pem / env".
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ec2_settings (
            instance_id TEXT PRIMARY KEY,
            label TEXT,
            username TEXT,
            encrypted_password TEXT
        );
    `);

    const ec2Cols = await db.all(`PRAGMA table_info(ec2_settings)`);
    if (!ec2Cols.some((c: any) => c.name === 'os')) {
        await db.exec(`ALTER TABLE ec2_settings ADD COLUMN os TEXT NOT NULL DEFAULT ''`);
    }
    if (!ec2Cols.some((c: any) => c.name === 'swap_keys')) {
        await db.exec(`ALTER TABLE ec2_settings ADD COLUMN swap_keys INTEGER NOT NULL DEFAULT 0`);
    }
}

function encrypt(text: string): string {
    if (!text) return '';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', DB_CRYPT_KEY, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string {
    if (!text) return '';
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift()!, 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', DB_CRYPT_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        console.error('Decryption failed', e);
        return '';
    }
}

// ---------------------------------------------------------------------------
// Custom (non-EC2) instances
// ---------------------------------------------------------------------------

export async function addCustomInstance(id: string, name: string, ip: string, username: string, password?: string, protocol: string = 'rdp', os: string = '', swapKeys: boolean = false) {
    const encPass = password ? encrypt(password) : '';
    await db.run(
        'INSERT OR REPLACE INTO custom_instances (id, name, ip, username, encrypted_password, protocol, os, swap_keys) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, name, ip, username, encPass, protocol, os, swapKeys ? 1 : 0]
    );
}

// Update an existing custom instance. The password is only touched when
// `changePassword` is true, so editing the identifier/IP/username never wipes a
// stored password the user didn't intend to change. When it IS changed, an
// empty string clears it.
export async function updateCustomInstance(
    id: string,
    fields: { name: string; ip: string; username: string; protocol: string; os?: string; swapKeys?: boolean; changePassword?: boolean; password?: string }
) {
    const os = fields.os || '';
    const swapKeys = fields.swapKeys ? 1 : 0;
    if (fields.changePassword) {
        const encPass = fields.password ? encrypt(fields.password) : '';
        await db.run(
            'UPDATE custom_instances SET name = ?, ip = ?, username = ?, protocol = ?, os = ?, swap_keys = ?, encrypted_password = ? WHERE id = ?',
            [fields.name, fields.ip, fields.username, fields.protocol, os, swapKeys, encPass, id]
        );
    } else {
        await db.run(
            'UPDATE custom_instances SET name = ?, ip = ?, username = ?, protocol = ?, os = ?, swap_keys = ? WHERE id = ?',
            [fields.name, fields.ip, fields.username, fields.protocol, os, swapKeys, id]
        );
    }
}

export async function getCustomInstances() {
    const rows = await db.all('SELECT id, name, ip, username, encrypted_password, protocol, os, swap_keys FROM custom_instances');
    // Never leak the password to the client — expose only whether one is set.
    return rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        ip: r.ip,
        username: r.username,
        protocol: r.protocol || 'rdp',
        os: r.os || '',
        swapKeys: !!r.swap_keys,
        hasPassword: !!r.encrypted_password
    }));
}

export async function getCustomInstance(id: string) {
    const row = await db.get('SELECT * FROM custom_instances WHERE id = ?', [id]);
    if (!row) return null;
    return {
        ...row,
        password: decrypt(row.encrypted_password)
    };
}

export async function deleteCustomInstance(id: string) {
    await db.run('DELETE FROM custom_instances WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// EC2 credential/label overrides
// ---------------------------------------------------------------------------

// All stored EC2 overrides, keyed by instance id, for merging into the
// discovered instance list. Passwords are never returned — only `hasPassword`.
export async function getAllEc2Settings(): Promise<Record<string, { label: string; username: string; hasPassword: boolean; os: string; swapKeys: boolean }>> {
    const rows = await db.all('SELECT instance_id, label, username, encrypted_password, os, swap_keys FROM ec2_settings');
    const map: Record<string, { label: string; username: string; hasPassword: boolean; os: string; swapKeys: boolean }> = {};
    for (const r of rows) {
        map[r.instance_id] = {
            label: r.label || '',
            username: r.username || '',
            hasPassword: !!r.encrypted_password,
            os: r.os || '',
            swapKeys: !!r.swap_keys
        };
    }
    return map;
}

// Full override (decrypted password) for one instance, used when building a
// connection. Returns null if the user has never saved settings for it.
export async function getEc2SettingFull(id: string) {
    const row = await db.get('SELECT * FROM ec2_settings WHERE instance_id = ?', [id]);
    if (!row) return null;
    return {
        label: row.label || '',
        username: row.username || '',
        password: decrypt(row.encrypted_password)
    };
}

export async function upsertEc2Setting(
    id: string,
    fields: { label?: string; username?: string; os?: string; swapKeys?: boolean; changePassword?: boolean; password?: string }
) {
    const existing = await db.get('SELECT * FROM ec2_settings WHERE instance_id = ?', [id]);
    const label = fields.label ?? existing?.label ?? '';
    const username = fields.username ?? existing?.username ?? '';
    const os = fields.os ?? existing?.os ?? '';
    const swapKeys = (fields.swapKeys ?? !!existing?.swap_keys) ? 1 : 0;
    let encPass = existing?.encrypted_password ?? '';
    if (fields.changePassword) {
        encPass = fields.password ? encrypt(fields.password) : '';
    }
    await db.run(
        'INSERT OR REPLACE INTO ec2_settings (instance_id, label, username, encrypted_password, os, swap_keys) VALUES (?, ?, ?, ?, ?, ?)',
        [id, label, username, encPass, os, swapKeys]
    );
}
