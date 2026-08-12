import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, ShieldCheck, KeyRound } from 'lucide-react';
import App from './App';

const MOUNT_PATH = window.location.pathname.replace(/[^/]*$/, '');
const API_BASE = import.meta.env.VITE_API_URL || `${MOUNT_PATH}api`;

const readErrorMessage = async (res: Response) => {
    const body = (await res.text()).trim();
    try {
        return JSON.parse(body).error || body;
    } catch {
        return body || `HTTP ${res.status}`;
    }
};

export interface AuthStatus {
    hasUser: boolean;
    authenticated: boolean;
    username?: string;
    totpEnabled?: boolean;
    inactivityTimeoutMinutes?: number;
}

// How often a real mouse/keyboard event (while one has happened recently)
// re-touches the server-side session, vs. how often we check locally whether
// the inactivity timeout has elapsed. Both are cheap and infrequent.
const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_CHECK_INTERVAL_MS = 15_000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

const inputCls = 'w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500';
const buttonCls = 'w-full px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded flex items-center justify-center gap-2';

function AuthShell({ children, title }: { children: React.ReactNode; title: string }) {
    return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-700 p-6 rounded-lg shadow-2xl w-full max-w-sm">
                <div className="flex items-center gap-2 mb-6">
                    <ShieldCheck size={22} className="text-blue-400" />
                    <h1 className="text-lg font-semibold text-white">{title}</h1>
                </div>
                {children}
            </div>
        </div>
    );
}

function SetupForm({ onDone }: { onDone: () => void }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (password !== confirm) return setError("Passwords don't match.");
        setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/setup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            onDone();
        } catch (err: any) {
            setError(err.message || 'Setup failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <AuthShell title="Set up RDm">
            <form onSubmit={submit} className="space-y-4">
                <p className="text-xs text-slate-500 -mt-2">
                    First run — create the account used to sign in. There's only one.
                </p>
                <div>
                    <label className="block text-sm text-slate-300 mb-1">Username</label>
                    <input className={inputCls} value={username} onChange={e => setUsername(e.target.value)} autoFocus required />
                </div>
                <div>
                    <label className="block text-sm text-slate-300 mb-1">Password</label>
                    <input className={inputCls} type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={8} required />
                </div>
                <div>
                    <label className="block text-sm text-slate-300 mb-1">Confirm password</label>
                    <input className={inputCls} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} minLength={8} required />
                </div>
                {error && <p className="text-sm text-red-400">{error}</p>}
                <button className={buttonCls} disabled={busy} type="submit">
                    {busy && <Loader2 size={14} className="animate-spin" />} Create account
                </button>
            </form>
        </AuthShell>
    );
}

function LoginForm({ onDone }: { onDone: () => void }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [pendingToken, setPendingToken] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submitPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            const data = await res.json();
            if (data.requiresTotp) {
                setPendingToken(data.pendingToken);
            } else {
                onDone();
            }
        } catch (err: any) {
            setError(err.message || 'Login failed');
        } finally {
            setBusy(false);
        }
    };

    const submitTotp = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/login/totp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pendingToken, code })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            onDone();
        } catch (err: any) {
            setError(err.message || 'Invalid code');
            setCode('');
        } finally {
            setBusy(false);
        }
    };

    if (pendingToken) {
        return (
            <AuthShell title="Two-factor code">
                <form onSubmit={submitTotp} className="space-y-4">
                    <p className="text-xs text-slate-500 -mt-2 flex items-center gap-1.5">
                        <KeyRound size={13} /> This login is arriving from outside the trusted LAN — enter the code from your authenticator app.
                    </p>
                    <input
                        className={`${inputCls} text-center text-lg tracking-[0.3em]`}
                        value={code}
                        onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        inputMode="numeric"
                        autoFocus
                        maxLength={6}
                        required
                    />
                    {error && <p className="text-sm text-red-400">{error}</p>}
                    <button className={buttonCls} disabled={busy || code.length !== 6} type="submit">
                        {busy && <Loader2 size={14} className="animate-spin" />} Verify
                    </button>
                    <button type="button" onClick={() => { setPendingToken(null); setCode(''); setError(''); }} className="w-full text-xs text-slate-500 hover:text-slate-300">
                        Back
                    </button>
                </form>
            </AuthShell>
        );
    }

    return (
        <AuthShell title="Login">
            <form onSubmit={submitPassword} className="space-y-4">
                <div>
                    <label className="block text-sm text-slate-300 mb-1">Username</label>
                    <input className={inputCls} value={username} onChange={e => setUsername(e.target.value)} autoFocus required />
                </div>
                <div>
                    <label className="block text-sm text-slate-300 mb-1">Password</label>
                    <input className={inputCls} type="password" value={password} onChange={e => setPassword(e.target.value)} required />
                </div>
                {error && <p className="text-sm text-red-400">{error}</p>}
                <button className={buttonCls} disabled={busy} type="submit">
                    {busy && <Loader2 size={14} className="animate-spin" />} Sign in
                </button>
            </form>
        </AuthShell>
    );
}

export default function AuthGate() {
    const [status, setStatus] = useState<AuthStatus | null>(null);

    const refresh = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/auth/status`);
            setStatus(await res.json());
        } catch {
            // Transient network hiccup — leave the previous state up rather
            // than bouncing to a blank screen; the next poll/retry recovers.
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    // The global fetch wrapper installed in main.tsx dispatches this when any
    // /api/* call (other than /api/auth/*) comes back 401 — a session that
    // expired (absolute max age, or the inactivity timeout below) out from
    // under an already-loaded app.
    useEffect(() => {
        const onExpired = () => setStatus(s => (s ? { ...s, authenticated: false } : s));
        window.addEventListener('rdm-session-expired', onExpired);
        return () => window.removeEventListener('rdm-session-expired', onExpired);
    }, []);

    // Client-side inactivity tracking. Deliberately driven by real
    // mouse/keyboard events, not by ordinary API traffic (background polling
    // would otherwise keep a session "active" while the user is AFK). Closing
    // the tab — or just leaving it idle — both simply stop producing these
    // events, so the same timeout covers "walked away" and "closed the page":
    // there's nothing that resets the clock on close, it just stops advancing.
    const lastActivity = useRef(Date.now());
    const lastHeartbeat = useRef(0);
    useEffect(() => {
        if (!status?.authenticated || !status.inactivityTimeoutMinutes) return;
        const timeoutMs = status.inactivityTimeoutMinutes * 60_000;
        lastActivity.current = Date.now();
        lastHeartbeat.current = 0;

        const onActivity = () => {
            const now = Date.now();
            lastActivity.current = now;
            if (now - lastHeartbeat.current >= HEARTBEAT_INTERVAL_MS) {
                lastHeartbeat.current = now;
                fetch(`${API_BASE}/auth/heartbeat`, { method: 'POST' }).catch(() => {});
            }
        };
        ACTIVITY_EVENTS.forEach(ev => document.addEventListener(ev, onActivity, { passive: true }));

        const interval = setInterval(() => {
            if (Date.now() - lastActivity.current >= timeoutMs) {
                fetch(`${API_BASE}/auth/logout`, { method: 'POST' }).finally(() => {
                    setStatus(s => (s ? { ...s, authenticated: false } : s));
                });
            }
        }, IDLE_CHECK_INTERVAL_MS);

        return () => {
            ACTIVITY_EVENTS.forEach(ev => document.removeEventListener(ev, onActivity));
            clearInterval(interval);
        };
    }, [status?.authenticated, status?.inactivityTimeoutMinutes]);

    if (!status) return null;
    if (!status.hasUser) return <SetupForm onDone={refresh} />;
    if (!status.authenticated) return <LoginForm onDone={refresh} />;
    return <App authStatus={status} onAuthRefresh={refresh} />;
}
