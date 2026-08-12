import type { Request } from 'express';

// Parsed once at startup from TRUSTED_LAN_CIDRS, e.g.
// "192.168.1.0/24,127.0.0.1/32". Empty/unset means nothing is trusted, so 2FA
// (when enabled) is required from every source — the safe default.
interface Cidr {
    base: number;
    mask: number;
}

function ipToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        const v = Number(p);
        if (!Number.isInteger(v) || v < 0 || v > 255) return null;
        n = (n << 8) | v;
    }
    return n >>> 0;
}

function parseCidr(entry: string): Cidr | null {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const [ip, prefixStr] = trimmed.split('/');
    const base = ipToInt(ip || '');
    if (base === null) return null;
    const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { base: base & mask, mask };
}

const TRUSTED_CIDRS: Cidr[] = (process.env.TRUSTED_LAN_CIDRS || '')
    .split(',')
    .map(parseCidr)
    .filter((c): c is Cidr => c !== null);

// Node reports IPv4-mapped addresses on a dual-stack socket as
// "::ffff:192.168.1.5", and IPv6 loopback as "::1" — normalize both back to
// plain IPv4 before matching so a "127.0.0.1/32" entry works as expected.
function normalize(addr: string): string {
    if (addr === '::1') return '127.0.0.1';
    return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

// `req.ip` rather than `req.socket.remoteAddress` — Express only derives it
// from X-Forwarded-For when `app.set('trust proxy', ...)` has been
// configured (via TRUST_PROXY, see index.ts); with nothing configured (the
// default) `req.ip` is exactly the raw socket address, so this is safe
// whether or not a reverse proxy is in front.
export function isTrustedSource(req: Request): boolean {
    const raw = req.ip;
    if (!raw) return false;
    const n = ipToInt(normalize(raw));
    if (n === null) return false; // non-IPv4 (e.g. a real IPv6 LAN address) — not matchable, so not trusted
    return TRUSTED_CIDRS.some(c => (n & c.mask) === c.base);
}
