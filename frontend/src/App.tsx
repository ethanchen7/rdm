import { useState, useEffect, useCallback, useRef } from 'react';
import { Grid, LayoutGrid, Maximize, Square, PlayCircle, StopCircle, RefreshCw, PanelLeftClose, PanelLeftOpen, Plus, X, ChevronUp, ChevronDown, Settings, GalleryHorizontalEnd, Loader2, DollarSign, AlertTriangle, ArrowUpDown, GripVertical, Check } from 'lucide-react';
import { GuacamoleClient } from './GuacamoleClient';
import './index.css';

let toastSeq = 0;
interface Toast { id: number; message: string; type: 'error' | 'success' | 'info'; }

interface EC2Instance {
    id: string;
    name: string;
    state: string;
    publicIp?: string;
    privateIp?: string;
    // User-set overrides (see backend ec2_settings)
    label?: string;
    username?: string;
    hasPassword?: boolean;
}

interface ActiveSession {
    instanceId: string;
    token: string;
    name: string;
    ip: string;
}

interface CustomInstance {
    id: string;
    name: string;
    ip: string;
    username: string;
    hasPassword?: boolean;
}

interface Billing {
    available: boolean;
    amount?: number;
    currency?: string;
}

// Which instance the settings modal is editing, and in what mode.
type InstanceModal =
    | { mode: 'add' }
    | { mode: 'edit-custom'; id: string }
    | { mode: 'edit-ec2'; id: string };

interface ConfirmState {
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
}

// Mount point the app is served from — '/' standalone, or '/rdpm/' (etc.)
// behind a path-stripping reverse proxy. Derived from the page URL so no build
// step is tied to a specific prefix. `VITE_API_URL` still overrides if set.
const MOUNT_PATH = window.location.pathname.replace(/[^/]*$/, '');
const API_BASE = import.meta.env.VITE_API_URL || `${MOUNT_PATH}api`;

function App() {
    const [instances, setInstances] = useState<EC2Instance[]>([]);
    const [activeSessions, setActiveSessions] = useState<Record<string, ActiveSession>>({});
    // Explicit render order for the grid, so panes can be dragged to reorder.
    // Persisted to localStorage so an arrangement survives reloads/reconnects.
    const [sessionOrder, setSessionOrder] = useState<string[]>(() => {
        try { return JSON.parse(localStorage.getItem('rdpm_order') || '[]'); } catch { return []; }
    });
    // Dedicated full-view reorder mode: minimizes every session into compact,
    // easily-draggable tiles so ordering works regardless of the grid layout.
    const [reorderMode, setReorderMode] = useState(false);
    // Transient notifications (connection failures, etc.).
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [gridLayout, setGridLayout] = useState<number>(2); // 1 = 1x1, 2 = 2x2, 4 = 4x4
    const [isSidebarVisible, setIsSidebarVisible] = useState<boolean>(() => {
        const stored = localStorage.getItem('rdpm_sidebar');
        return stored !== null ? stored === 'true' : true;
    });
    const [isHeaderVisible, setIsHeaderVisible] = useState<boolean>(() => {
        const stored = localStorage.getItem('rdpm_header');
        return stored !== null ? stored === 'true' : true;
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [customInstances, setCustomInstances] = useState<CustomInstance[]>([]);
    const [billing, setBilling] = useState<Billing | null>(null);
    // Shared clipboard across all open sessions (and this device), enabling
    // copy/paste between sessions, not just device -> session.
    const [sharedClipboard, setSharedClipboard] = useState('');

    // Per-instance loading states
    const [connecting, setConnecting] = useState<Record<string, boolean>>({});
    const [starting, setStarting] = useState<Record<string, boolean>>({});
    const [stopping, setStopping] = useState<Record<string, boolean>>({});

    const [hasRestored, setHasRestored] = useState(false);

    // Instance add/edit modal + its form.
    const [instanceModal, setInstanceModal] = useState<InstanceModal | null>(null);
    const [instanceForm, setInstanceForm] = useState({
        name: '', ip: '', username: 'Administrator',
        password: '', changePassword: false, hasPassword: false
    });

    // Reusable confirmation dialog (used for every stop action).
    const [confirm, setConfirm] = useState<ConfirmState | null>(null);

    // Drag-to-reorder state for the grid.
    const [dragId, setDragId] = useState<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    // A transparent 1x1 image used as the native drag ghost, so dragging shows
    // our own styled source/placeholder instead of a bitmap of the video pane.
    const dragImgRef = useRef<HTMLImageElement | null>(null);
    useEffect(() => {
        const img = new Image();
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        dragImgRef.current = img;
    }, []);
    const setBlankDragImage = (e: React.DragEvent) => {
        if (dragImgRef.current) e.dataTransfer.setDragImage(dragImgRef.current, 0, 0);
        e.dataTransfer.effectAllowed = 'move';
    };

    const pushToast = useCallback((message: string, type: Toast['type'] = 'error') => {
        const id = ++toastSeq;
        setToasts(prev => [...prev, { id, message, type }]);
        // Errors linger a little longer so the reason is readable.
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 4000);
    }, []);
    const dismissToast = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

    // Settings Modal State
    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    const [globalSettings, setGlobalSettings] = useState({ fontSmoothing: true, colorDepth: '32' });

    useEffect(() => {
        fetchInstances();
        fetchCustomInstances();
        fetchBilling();
        const storedSettings = localStorage.getItem('rdpm_settings');
        if (storedSettings) {
            try { setGlobalSettings(JSON.parse(storedSettings)); } catch(e){}
        }
    }, []);

    // Session persistence: sessionStorage tracks which sessions were open;
    // localStorage ('rdpm_order') remembers their arrangement across reloads.
    useEffect(() => {
        if (!hasRestored) {
            const stored = sessionStorage.getItem('rdpm_active_sessions');
            if (stored) {
                try {
                    const activeIds: string[] = JSON.parse(stored);
                    const remembered: string[] = (() => {
                        try { return JSON.parse(localStorage.getItem('rdpm_order') || '[]'); } catch { return []; }
                    })();
                    // Reconnect in the remembered order; append any that weren't ranked.
                    const ordered = [
                        ...remembered.filter(id => activeIds.includes(id)),
                        ...activeIds.filter(id => !remembered.includes(id))
                    ];
                    ordered.forEach((id: string) => connectInstance(id));
                } catch (e) {}
            }
            setHasRestored(true);
        } else {
            sessionStorage.setItem('rdpm_active_sessions', JSON.stringify(Object.keys(activeSessions)));
        }
    }, [activeSessions, hasRestored]);

    // Remember the arrangement.
    useEffect(() => {
        localStorage.setItem('rdpm_order', JSON.stringify(sessionOrder));
    }, [sessionOrder]);

    // UI State persistence
    useEffect(() => {
        localStorage.setItem('rdpm_sidebar', isSidebarVisible.toString());
    }, [isSidebarVisible]);

    useEffect(() => {
        localStorage.setItem('rdpm_header', isHeaderVisible.toString());
    }, [isHeaderVisible]);

    const fetchBilling = async () => {
        try {
            const res = await fetch(`${API_BASE}/billing`);
            if (res.ok) setBilling(await res.json());
        } catch (e) {
            console.error('Failed to fetch billing', e);
        }
    };

    const fetchCustomInstances = async () => {
        try {
            const res = await fetch(`${API_BASE}/custom-instances`);
            if (res.ok) {
                const data = await res.json();
                setCustomInstances(data);
            }
        } catch (e) {
            console.error('Failed to fetch custom instances', e);
        }
    };

    const fetchInstances = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${API_BASE}/instances`);
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            setInstances(data);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const connectInstance = async (instanceId: string) => {
        if (activeSessions[instanceId] || connecting[instanceId]) return;

        setConnecting(prev => ({ ...prev, [instanceId]: true }));
        try {
            const isCustom = instanceId.startsWith('custom-');
            const body = isCustom ? { customId: instanceId, settings: globalSettings } : { instanceId, settings: globalSettings };

            let name = instanceId;
            let ip = '';
            if (isCustom) {
                const c = customInstances.find(c => c.id === instanceId);
                if (c) { name = c.name; ip = c.ip; }
            } else {
                const c = instances.find(c => c.id === instanceId);
                if (c) { name = c.label || c.name; ip = c.publicIp || c.privateIp || ''; }
            }

            const res = await fetch(`${API_BASE}/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();

            setActiveSessions(prev => ({
                ...prev,
                [instanceId]: {
                    instanceId,
                    token: data.token,
                    name,
                    ip
                }
            }));
            setSessionOrder(prev => prev.includes(instanceId) ? prev : [...prev, instanceId]);
        } catch (err: any) {
            // Surface the actual reason (bad password, instance unreachable,
            // guacd/RDP error, etc.) rather than a generic failure.
            const reason = (err?.message || 'Unknown error').toString().trim();
            const label = instances.find(i => i.id === instanceId)?.name
                || customInstances.find(c => c.id === instanceId)?.name
                || instanceId;
            pushToast(`Couldn't connect to ${label}: ${reason}`, 'error');
        } finally {
            setConnecting(prev => ({ ...prev, [instanceId]: false }));
        }
    };

    // Open the add/edit modal, prefilled for the target.
    const openAddModal = () => {
        setInstanceForm({ name: '', ip: '', username: 'Administrator', password: '', changePassword: true, hasPassword: false });
        setInstanceModal({ mode: 'add' });
    };

    const openEditCustom = (inst: CustomInstance) => {
        setInstanceForm({ name: inst.name, ip: inst.ip, username: inst.username || 'Administrator', password: '', changePassword: false, hasPassword: !!inst.hasPassword });
        setInstanceModal({ mode: 'edit-custom', id: inst.id });
    };

    const openEditEc2 = (inst: EC2Instance) => {
        setInstanceForm({
            name: inst.label || inst.name,
            ip: inst.publicIp || inst.privateIp || '',
            username: inst.username || 'Administrator',
            password: '', changePassword: false, hasPassword: !!inst.hasPassword
        });
        setInstanceModal({ mode: 'edit-ec2', id: inst.id });
    };

    const handleSaveInstance = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!instanceModal) return;
        const f = instanceForm;
        try {
            if (instanceModal.mode === 'add') {
                await fetch(`${API_BASE}/custom-instances`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: 'custom-' + Date.now(), name: f.name, ip: f.ip, username: f.username, password: f.password })
                });
            } else if (instanceModal.mode === 'edit-custom') {
                await fetch(`${API_BASE}/custom-instances/${instanceModal.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: f.name, ip: f.ip, username: f.username, changePassword: f.changePassword, password: f.password })
                });
            } else if (instanceModal.mode === 'edit-ec2') {
                await fetch(`${API_BASE}/ec2-settings/${instanceModal.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ label: f.name, username: f.username, changePassword: f.changePassword, password: f.password })
                });
            }
            await Promise.all([fetchCustomInstances(), fetchInstances()]);
            setInstanceModal(null);
        } catch (err) {
            pushToast('Failed to save instance settings', 'error');
        }
    };

    const handleDeleteCustom = async (id: string) => {
        try {
            await fetch(`${API_BASE}/custom-instances/${id}`, { method: 'DELETE' });
            await fetchCustomInstances();
            if (activeSessions[id]) disconnectInstance(id);
            // Forget its remembered slot too.
            setSessionOrder(prev => prev.filter(x => x !== id));
        } catch (err) {
            pushToast('Failed to delete custom instance', 'error');
        }
    };

    // Confirm before removing a custom instance from the list.
    const confirmDeleteCustom = (inst: CustomInstance) => {
        setConfirm({
            title: 'Remove instance',
            message: `Remove "${inst.name}" from your list? This deletes its saved connection details. EC2 instances are unaffected.`,
            confirmLabel: 'Remove',
            onConfirm: () => handleDeleteCustom(inst.id)
        });
    };

    const disconnectInstance = useCallback((instanceId: string) => {
        setActiveSessions(prev => {
            const newSessions = { ...prev };
            delete newSessions[instanceId];
            return newSessions;
        });
        // Keep the id in sessionOrder (just no longer active) so reconnecting
        // restores it to the same slot — e.g. 1,2,3 → disconnect 2 → shows 1,3 →
        // reconnect 2 → reappears between 1 and 3.
    }, []);

    const connectAll = async () => {
        for (const inst of instances) {
            if (inst.state === 'running' && !activeSessions[inst.id]) {
                await connectInstance(inst.id);
            }
        }
        for (const custom of customInstances) {
            if (!activeSessions[custom.id]) {
                await connectInstance(custom.id);
            }
        }
    };

    const disconnectAll = () => {
        // Clear active sessions but keep the remembered order, so reconnecting
        // any of them restores its previous slot.
        setActiveSessions({});
    };

    // Move `fromId` to occupy `toId`'s slot in the grid order.
    const reorderSession = (fromId: string | null, toId: string) => {
        if (!fromId || fromId === toId) return;
        setSessionOrder(prev => {
            const from = prev.indexOf(fromId);
            const to = prev.indexOf(toId);
            if (from === -1 || to === -1) return prev;
            const next = [...prev];
            next.splice(from, 1);
            next.splice(to, 0, fromId);
            return next;
        });
    };

    const startInstances = async (instanceIds: string[]) => {
        if (!instanceIds.length) return;
        const newStarting = { ...starting };
        instanceIds.forEach(id => newStarting[id] = true);
        setStarting(newStarting);

        try {
            const res = await fetch(`${API_BASE}/instances/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instanceIds })
            });
            if (!res.ok) throw new Error(await res.text());
            fetchInstances();
        } catch (err: any) {
            pushToast(`Failed to start: ${err.message}`, 'error');
        } finally {
            setStarting(prev => {
                const next = { ...prev };
                instanceIds.forEach(id => delete next[id]);
                return next;
            });
        }
    };

    const stopInstances = async (instanceIds: string[]) => {
        if (!instanceIds.length) return;
        const newStopping = { ...stopping };
        instanceIds.forEach(id => newStopping[id] = true);
        setStopping(newStopping);

        try {
            const res = await fetch(`${API_BASE}/instances/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instanceIds })
            });
            if (!res.ok) throw new Error(await res.text());
            fetchInstances();
        } catch (err: any) {
            pushToast(`Failed to stop: ${err.message}`, 'error');
        } finally {
            setStopping(prev => {
                const next = { ...prev };
                instanceIds.forEach(id => delete next[id]);
                return next;
            });
        }
    };

    // Every stop action is gated behind a confirmation dialog.
    const confirmStop = (instanceIds: string[], label: string) => {
        if (!instanceIds.length) return;
        const plural = instanceIds.length > 1;
        setConfirm({
            title: plural ? 'Stop instances' : 'Stop instance',
            message: `Stop ${label}? This shuts down the Windows machine${plural ? 's' : ''} and ends any open session${plural ? 's' : ''}.`,
            confirmLabel: plural ? `Stop ${instanceIds.length} instances` : 'Stop',
            onConfirm: () => stopInstances(instanceIds)
        });
    };

    const runningEc2Ids = instances.filter(i => i.state === 'running').map(i => i.id);
    const stoppedEc2Ids = instances.filter(i => i.state === 'stopped').map(i => i.id);

    const getGridClass = () => {
        switch (gridLayout) {
            case 1: return 'grid grid-cols-1 auto-rows-fr';
            case 2: return 'grid grid-cols-1 md:grid-cols-2 auto-rows-fr';
            case 3: return 'flex overflow-x-auto snap-x snap-mandatory'; // Horizontal
            case 4: return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 auto-rows-fr';
            default: return 'grid grid-cols-1 auto-rows-fr';
        }
    };

    const activeSessionList = Object.values(activeSessions);
    // Render in explicit drag order; ignore ids no longer connected.
    const orderedSessions = sessionOrder.map(id => activeSessions[id]).filter(Boolean) as ActiveSession[];

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col font-sans relative">
            {!isHeaderVisible && (
                <button
                    onClick={() => setIsHeaderVisible(true)}
                    className="absolute top-0 left-1/2 -translate-x-1/2 bg-slate-800 text-slate-400 hover:text-white px-6 py-1 rounded-b-lg border-b border-x border-slate-700 shadow-xl z-50 opacity-20 hover:opacity-100 transition-all flex items-center justify-center"
                    title="Show Header"
                >
                    <ChevronDown size={20} />
                </button>
            )}

            {/* Header */}
            {isHeaderVisible && (
            <header className="relative bg-slate-900 border-b border-slate-800 p-4 flex justify-between items-center shadow-lg z-10">
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => setIsSidebarVisible(!isSidebarVisible)}
                        className="text-slate-400 hover:text-white transition-colors p-1"
                        title="Toggle Sidebar"
                    >
                        {isSidebarVisible ? <PanelLeftClose size={24} /> : <PanelLeftOpen size={24} />}
                    </button>
                    <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
                        RDPm <span className="text-sm text-slate-500 ml-2 font-normal">RDP Manager</span>
                    </h1>
                    <button
                        onClick={connectAll}
                        disabled={loading || instances.length === 0}
                        className="text-sm bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-500/30 px-3 py-1.5 rounded flex items-center gap-2 transition-colors disabled:opacity-50"
                    >
                        Connect All
                    </button>
                    <button
                        onClick={disconnectAll}
                        disabled={activeSessionList.length === 0}
                        className="text-sm bg-orange-600/20 text-orange-400 hover:bg-orange-600/30 border border-orange-500/30 px-3 py-1.5 rounded flex items-center gap-2 transition-colors disabled:opacity-50"
                    >
                        Disconnect All
                    </button>
                    <button
                        onClick={() => { fetchInstances(); fetchBilling(); }}
                        disabled={loading}
                        className="text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded flex items-center gap-2 transition-colors disabled:opacity-50 ml-2"
                    >
                        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>

                <div className="flex items-center gap-2 bg-slate-800 p-1 rounded-lg border border-slate-700">
                    <button
                        onClick={() => setGridLayout(1)}
                        className={`p-2 rounded transition-colors ${gridLayout === 1 ? 'bg-slate-700 text-blue-400' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        title="Single View"
                    >
                        <Square size={20} />
                    </button>
                    <button
                        onClick={() => setGridLayout(3)}
                        className={`p-2 rounded transition-colors ${gridLayout === 3 ? 'bg-slate-700 text-blue-400' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        title="Horizontal Scroll"
                    >
                        <GalleryHorizontalEnd size={20} />
                    </button>
                    <button
                        onClick={() => setGridLayout(2)}
                        className={`p-2 rounded transition-colors ${gridLayout === 2 ? 'bg-slate-700 text-blue-400' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        title="2x2 Grid"
                    >
                        <Grid size={20} />
                    </button>
                    <button
                        onClick={() => setGridLayout(4)}
                        className={`p-2 rounded transition-colors ${gridLayout === 4 ? 'bg-slate-700 text-blue-400' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        title="4x4 Grid"
                    >
                        <LayoutGrid size={20} />
                    </button>
                    <div className="w-px h-6 bg-slate-700 mx-1"></div>
                    <button
                        onClick={() => setReorderMode(true)}
                        disabled={orderedSessions.length < 2}
                        className={`p-2 rounded transition-colors text-slate-400 hover:text-white hover:bg-slate-700/50 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-400`}
                        title="Reorder sessions"
                    >
                        <ArrowUpDown size={20} />
                    </button>
                    <div className="w-px h-6 bg-slate-700 mx-1"></div>
                    <button
                        onClick={() => { setIsSettingsModalOpen(true); fetchBilling(); }}
                        className="p-2 rounded text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors"
                        title="Global Settings"
                    >
                        <Settings size={20} />
                    </button>
                </div>

                {/* Minimize tab: sits flush just below the header's bottom edge
                    (top-full) so it reads as a pull-handle instead of floating
                    over the header content. */}
                <button
                    onClick={() => setIsHeaderVisible(false)}
                    className="absolute top-full left-1/2 -translate-x-1/2 bg-slate-800 text-slate-400 hover:text-white px-6 h-5 rounded-b-lg border-b border-x border-slate-700 shadow-md z-20 opacity-40 hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="Hide Header"
                >
                    <ChevronUp size={16} />
                </button>
            </header>
            )}

            <div className="flex flex-1 overflow-hidden">
                {/* Sidebar */}
                {isSidebarVisible && (
                    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col overflow-y-auto shrink-0">
                        <div className="p-4 border-b border-slate-800 flex justify-between items-center">
                            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Active Instances</h2>
                            <button
                                onClick={openAddModal}
                                className="text-slate-400 hover:text-white p-1 bg-slate-800 rounded hover:bg-slate-700 transition-colors"
                                title="Add Custom RDP"
                            >
                                <Plus size={14} />
                            </button>
                        </div>
                    {error && <div className="p-4 text-red-400 text-sm">{error}</div>}
                    <ul className="flex-1 p-2 space-y-1">
                        {customInstances.map(inst => {
                            const isConnected = !!activeSessions[inst.id];
                            return (
                                <li key={inst.id} className={`w-full text-left px-3 py-2 rounded flex flex-col gap-2 group transition-colors ${
                                    isConnected ? 'bg-indigo-600/10 border border-indigo-500/20' : 'hover:bg-slate-800 border border-transparent'
                                }`}>
                                    <div className="flex items-center justify-between">
                                        <div className="flex flex-col truncate">
                                            <div className="flex items-center gap-2">
                                                <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
                                                <span className={`font-medium text-sm truncate ${isConnected ? 'text-indigo-400' : 'text-slate-300'}`}>{inst.name}</span>
                                            </div>
                                            <span className="text-xs opacity-60 truncate font-mono mt-0.5 ml-4">{inst.ip}</span>
                                        </div>
                                        <div className="flex items-center gap-1 shrink-0">
                                            <button onClick={() => openEditCustom(inst)} title="Instance Settings" className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-white p-1"><Settings size={14}/></button>
                                            <button onClick={() => confirmDeleteCustom(inst)} title="Remove" className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 p-1"><X size={14}/></button>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-end">
                                        <button
                                            onClick={() => isConnected ? disconnectInstance(inst.id) : connectInstance(inst.id)}
                                            disabled={connecting[inst.id]}
                                            className={`px-2 py-1 text-xs rounded border transition-colors flex items-center justify-center min-w-[70px] ${
                                                isConnected ? 'bg-red-500/20 border-red-500/50 text-red-400 hover:bg-red-500/30' : 'bg-indigo-500/20 border-indigo-500/50 text-indigo-400 hover:bg-indigo-500/30 disabled:opacity-50'
                                            }`}
                                        >
                                            {connecting[inst.id] ? <Loader2 size={12} className="animate-spin" /> : (isConnected ? 'Disconnect' : 'Connect')}
                                        </button>
                                    </div>
                                </li>
                            )
                        })}

                        {instances.length > 0 && (
                            <div className="flex items-center justify-between px-2 pt-4 pb-2">
                                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">AWS EC2</span>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => startInstances(stoppedEc2Ids)}
                                        disabled={loading || stoppedEc2Ids.length === 0}
                                        title="Start all stopped instances"
                                        className="p-1 rounded text-green-400 hover:bg-green-500/20 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    >
                                        <PlayCircle size={16} />
                                    </button>
                                    <button
                                        onClick={() => confirmStop(runningEc2Ids, 'all running instances')}
                                        disabled={loading || runningEc2Ids.length === 0}
                                        title="Stop all running instances"
                                        className="p-1 rounded text-red-400 hover:bg-red-500/20 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                    >
                                        <StopCircle size={16} />
                                    </button>
                                </div>
                            </div>
                        )}
                        {instances.map(inst => {
                            const isConnected = !!activeSessions[inst.id];
                            const isRunning = inst.state === 'running';
                            const displayName = inst.label || inst.name;
                            return (
                                <li key={inst.id} className={`w-full text-left px-3 py-2 rounded flex flex-col gap-2 group transition-colors ${
                                    isConnected
                                    ? 'bg-blue-600/10 border border-blue-500/20'
                                    : 'hover:bg-slate-800 border border-transparent'
                                }`}>
                                    <div className="flex items-center justify-between">
                                        <div className="flex flex-col truncate">
                                            <div className="flex items-center gap-2">
                                                <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500' : 'bg-slate-500'}`}></span>
                                                <span className={`font-medium text-sm truncate ${isConnected ? 'text-blue-400' : 'text-slate-300'}`}>{displayName}</span>
                                            </div>
                                            <span className="text-xs opacity-60 truncate font-mono mt-0.5 ml-4">{inst.id}</span>
                                        </div>
                                        <button onClick={() => openEditEc2(inst)} title="Instance Settings" className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-white p-1 shrink-0"><Settings size={14}/></button>
                                    </div>
                                    <div className="flex items-center justify-between ml-4">
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => startInstances([inst.id])}
                                                title="Start EC2"
                                                disabled={isRunning || starting[inst.id]}
                                                className={`p-1 rounded flex items-center justify-center w-6 h-6 ${isRunning ? 'opacity-30 cursor-not-allowed' : 'hover:bg-green-500/20 text-green-400'}`}
                                            >
                                                {starting[inst.id] ? <Loader2 size={16} className="animate-spin" /> : <PlayCircle size={16} />}
                                            </button>
                                            <button
                                                onClick={() => confirmStop([inst.id], displayName)}
                                                title="Stop EC2"
                                                disabled={!isRunning || stopping[inst.id]}
                                                className={`p-1 rounded flex items-center justify-center w-6 h-6 ${!isRunning ? 'opacity-30 cursor-not-allowed' : 'hover:bg-red-500/20 text-red-400'}`}
                                            >
                                                {stopping[inst.id] ? <Loader2 size={16} className="animate-spin" /> : <StopCircle size={16} />}
                                            </button>
                                        </div>
                                        <button
                                            onClick={() => isConnected ? disconnectInstance(inst.id) : connectInstance(inst.id)}
                                            disabled={!isRunning || connecting[inst.id]}
                                            title={isConnected ? "Disconnect Viewer" : "Connect Viewer"}
                                            className={`px-2 py-1 text-xs rounded border transition-colors flex items-center justify-center min-w-[70px] ${
                                                !isRunning ? 'opacity-30 cursor-not-allowed border-slate-700' :
                                                isConnected ? 'bg-red-500/20 border-red-500/50 text-red-400 hover:bg-red-500/30' : 'bg-blue-500/20 border-blue-500/50 text-blue-400 hover:bg-blue-500/30'
                                            }`}
                                        >
                                            {connecting[inst.id] ? <Loader2 size={12} className="animate-spin" /> : (isConnected ? 'Disconnect' : 'Connect')}
                                        </button>
                                    </div>
                                </li>
                            )
                        })}
                        {instances.length === 0 && !loading && (
                            <div className="text-center p-4 text-slate-500 text-sm">No active instances found.</div>
                        )}
                    </ul>
                </aside>
                )}

                {/* Main Content - Grid View */}
                <main className="flex-1 bg-black p-4 overflow-y-auto">
                    {orderedSessions.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-slate-500">
                            <Maximize size={48} className="mb-4 opacity-20" />
                            <p className="text-lg">Select an instance to start a session</p>
                            <p className="text-sm mt-2 max-w-md text-center opacity-70">
                                This will automatically tunnel RDP over AWS Systems Manager (SSM) and stream the desktop securely to your browser.
                            </p>
                        </div>
                    ) : (
                        <div className={`gap-4 h-full ${getGridClass()}`}>
                            {orderedSessions.map(session => {
                                // Resolve name/IP from the live instance lists so a
                                // session restored on page load (before the lists have
                                // finished fetching) still shows the friendly name/IP
                                // instead of the raw instance id. Fall back to whatever
                                // was snapshotted at connect time.
                                const custom = customInstances.find(c => c.id === session.instanceId);
                                const ec2 = instances.find(i => i.id === session.instanceId);
                                const name = custom?.name || ec2?.label || ec2?.name || session.name;
                                const ip = custom?.ip || ec2?.publicIp || ec2?.privateIp || session.ip;
                                const isDropTarget = dragOverId === session.instanceId && dragId !== session.instanceId;
                                return (
                                <div
                                    key={session.instanceId}
                                    onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverId !== session.instanceId) setDragOverId(session.instanceId); } }}
                                    onDragLeave={() => { if (dragOverId === session.instanceId) setDragOverId(null); }}
                                    onDrop={(e) => { e.preventDefault(); reorderSession(dragId, session.instanceId); setDragId(null); setDragOverId(null); }}
                                    className={`flex items-center justify-center min-h-[240px] min-w-0 rounded-lg transition-all duration-200 ease-out will-change-transform ${gridLayout === 3 ? 'min-w-full shrink-0 snap-center h-full' : ''} ${isDropTarget ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-black scale-[1.015]' : ''} ${dragId === session.instanceId ? 'opacity-40 scale-[0.97]' : ''}`}
                                >
                                    <GuacamoleClient
                                        instanceId={session.instanceId}
                                        token={session.token}
                                        name={name}
                                        ip={ip}
                                        clipboard={sharedClipboard}
                                        onClipboard={setSharedClipboard}
                                        onDisconnect={() => disconnectInstance(session.instanceId)}
                                        onReorderDragStart={(e) => { setBlankDragImage(e); setDragId(session.instanceId); }}
                                        onReorderDragEnd={() => { setDragId(null); setDragOverId(null); }}
                                    />
                                </div>
                                );
                            })}
                        </div>
                    )}
                </main>
            </div>

            {/* Instance Add / Edit Modal */}
            {instanceModal && (() => {
                const isEc2 = instanceModal.mode === 'edit-ec2';
                const isAdd = instanceModal.mode === 'add';
                const title = isAdd ? 'Add Custom RDP' : isEc2 ? 'EC2 Instance Settings' : 'Instance Settings';
                return (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
                    <form onSubmit={handleSaveInstance} className="bg-slate-900 border border-slate-700 p-6 rounded-lg shadow-2xl w-full max-w-sm">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-semibold text-white">{title}</h3>
                            <button type="button" onClick={() => setInstanceModal(null)} className="text-slate-400 hover:text-white"><X size={20}/></button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs text-slate-400 mb-1">Custom Identifier</label>
                                <input required type="text" className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500" value={instanceForm.name} onChange={e => setInstanceForm({...instanceForm, name: e.target.value})} placeholder="Home PC" />
                            </div>
                            <div>
                                <label className="block text-xs text-slate-400 mb-1">IP Address / Hostname</label>
                                <input
                                    required={!isEc2}
                                    disabled={isEc2}
                                    type="text"
                                    className={`w-full border border-slate-700 rounded p-2 outline-none focus:border-blue-500 ${isEc2 ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-slate-950 text-white'}`}
                                    value={instanceForm.ip}
                                    onChange={e => setInstanceForm({...instanceForm, ip: e.target.value})}
                                    placeholder="192.168.1.100"
                                />
                                {isEc2 && <p className="text-xs text-slate-500 mt-1">Managed by AWS — updates automatically.</p>}
                            </div>
                            <div>
                                <label className="block text-xs text-slate-400 mb-1">Username</label>
                                <input required type="text" className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500" value={instanceForm.username} onChange={e => setInstanceForm({...instanceForm, username: e.target.value})} />
                            </div>
                            <div>
                                {isAdd ? (
                                    <>
                                        <label className="block text-xs text-slate-400 mb-1">Password (optional)</label>
                                        <input type="password" className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500" value={instanceForm.password} onChange={e => setInstanceForm({...instanceForm, password: e.target.value})} />
                                    </>
                                ) : (
                                    <>
                                        <label className="flex items-center gap-2 text-sm text-slate-300 mb-2 cursor-pointer select-none">
                                            <input type="checkbox" className="w-4 h-4" checked={instanceForm.changePassword} onChange={e => setInstanceForm({...instanceForm, changePassword: e.target.checked, password: ''})} />
                                            Change password
                                            {instanceForm.hasPassword && !instanceForm.changePassword && <span className="text-xs text-emerald-400/80 ml-1">(a password is saved)</span>}
                                        </label>
                                        {instanceForm.changePassword && (
                                            <input type="password" autoFocus className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500" value={instanceForm.password} onChange={e => setInstanceForm({...instanceForm, password: e.target.value})} placeholder={isEc2 ? 'Leave blank to use key.pem' : 'New password'} />
                                        )}
                                    </>
                                )}
                                {isEc2 && (
                                    <p className="text-xs text-slate-500 mt-1">
                                        For AWS instances the password can be left blank — it's auto-decrypted from your <code className="text-slate-400">key.pem</code> (or <code className="text-slate-400">RDP_PASSWORD</code>). Set one here only to override.
                                    </p>
                                )}
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button type="button" onClick={() => setInstanceModal(null)} className="px-4 py-2 text-sm text-slate-300 hover:text-white">Cancel</button>
                            <button type="submit" className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">{isAdd ? 'Add Connection' : 'Save'}</button>
                        </div>
                    </form>
                </div>
                );
            })()}

            {/* Confirmation Dialog */}
            {confirm && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center">
                    <div className="bg-slate-900 border border-slate-700 p-6 rounded-lg shadow-2xl w-full max-w-sm">
                        <div className="flex items-start gap-3 mb-4">
                            <div className="mt-0.5 text-amber-400 shrink-0"><AlertTriangle size={22} /></div>
                            <div>
                                <h3 className="text-lg font-semibold text-white">{confirm.title}</h3>
                                <p className="text-sm text-slate-400 mt-1">{confirm.message}</p>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end gap-3">
                            <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-slate-300 hover:text-white">Cancel</button>
                            <button
                                onClick={() => { confirm.onConfirm(); setConfirm(null); }}
                                className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded flex items-center gap-2"
                            >
                                {confirm.confirmLabel}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Global Settings Modal */}
            {isSettingsModalOpen && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
                    <div className="bg-slate-900 border border-slate-700 p-6 rounded-lg shadow-2xl w-full max-w-sm">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-semibold text-white">Global Settings</h3>
                            <button onClick={() => setIsSettingsModalOpen(false)} className="text-slate-400 hover:text-white"><X size={20}/></button>
                        </div>
                        <div className="space-y-4">
                            <div className="bg-slate-950 border border-slate-700 rounded p-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <DollarSign size={16} className="text-emerald-400" />
                                        <span className="text-sm text-slate-300">AWS Spend (Month-to-Date)</span>
                                    </div>
                                    <button onClick={fetchBilling} className="text-slate-400 hover:text-white p-1" title="Refresh billing">
                                        <RefreshCw size={14} />
                                    </button>
                                </div>
                                <div className="mt-2">
                                    {billing?.available && billing.amount !== undefined ? (
                                        <span className="text-2xl font-bold text-emerald-300 tabular-nums">
                                            {billing.amount.toLocaleString(undefined, { style: 'currency', currency: billing.currency || 'USD' })}
                                        </span>
                                    ) : (
                                        <span className="text-sm text-slate-500">
                                            Unavailable — ensure the service role has the <code className="text-slate-400">ce:GetCostAndUsage</code> permission.
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-slate-500 mt-1">Current statement so far this month, via AWS Cost Explorer. Data can lag a few hours.</p>
                            </div>
                            <div className="flex items-center justify-between">
                                <div>
                                    <label className="block text-sm text-slate-300">Enable Font Smoothing</label>
                                    <p className="text-xs text-slate-500">Improves text clarity drastically (ClearType)</p>
                                </div>
                                <input type="checkbox" checked={globalSettings.fontSmoothing} onChange={e => {
                                    const newSet = {...globalSettings, fontSmoothing: e.target.checked};
                                    setGlobalSettings(newSet);
                                    localStorage.setItem('rdpm_settings', JSON.stringify(newSet));
                                }} className="w-4 h-4" />
                            </div>
                            <div>
                                <label className="block text-sm text-slate-300 mb-1">Color Depth</label>
                                <select
                                    className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-white outline-none focus:border-blue-500"
                                    value={globalSettings.colorDepth}
                                    onChange={e => {
                                        const newSet = {...globalSettings, colorDepth: e.target.value};
                                        setGlobalSettings(newSet);
                                        localStorage.setItem('rdpm_settings', JSON.stringify(newSet));
                                    }}
                                >
                                    <option value="16">16-bit (Faster)</option>
                                    <option value="24">24-bit (High Color)</option>
                                    <option value="32">32-bit (True Color)</option>
                                </select>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-end">
                            <button onClick={() => setIsSettingsModalOpen(false)} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded">Done</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Reorder Mode — minimizes every session into compact draggable
                tiles so ordering is easy regardless of the current grid layout. */}
            {reorderMode && (
                <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex flex-col">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
                        <div>
                            <h3 className="text-lg font-semibold text-white flex items-center gap-2"><ArrowUpDown size={18} /> Reorder sessions</h3>
                            <p className="text-xs text-slate-500 mt-0.5">Drag tiles to rearrange. The order is remembered across every layout and reloads.</p>
                        </div>
                        <button onClick={() => setReorderMode(false)} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-2">
                            <Check size={16} /> Done
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-6">
                        {orderedSessions.length === 0 ? (
                            <div className="text-center text-slate-500 mt-20">No active sessions to reorder.</div>
                        ) : (
                        <div className="max-w-xl mx-auto flex flex-col gap-2">
                            {orderedSessions.map((session, idx) => {
                                const custom = customInstances.find(c => c.id === session.instanceId);
                                const ec2 = instances.find(i => i.id === session.instanceId);
                                const name = custom?.name || ec2?.label || ec2?.name || session.name;
                                const ip = custom?.ip || ec2?.publicIp || ec2?.privateIp || session.ip;
                                const isDrag = dragId === session.instanceId;
                                const isOver = dragOverId === session.instanceId && !isDrag;
                                return (
                                    <div
                                        key={session.instanceId}
                                        draggable
                                        onDragStart={() => setDragId(session.instanceId)}
                                        onDragEnd={() => { setDragId(null); setDragOverId(null); }}
                                        onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverId !== session.instanceId) setDragOverId(session.instanceId); } }}
                                        onDragLeave={() => { if (dragOverId === session.instanceId) setDragOverId(null); }}
                                        onDrop={(e) => { e.preventDefault(); reorderSession(dragId, session.instanceId); setDragId(null); setDragOverId(null); }}
                                        className={`flex items-center gap-3 rounded-lg border px-4 py-3 bg-slate-900 cursor-grab active:cursor-grabbing transition-all duration-200 ease-out
                                            ${isDrag ? 'opacity-40 scale-[0.98]' : 'hover:border-slate-600'}
                                            ${isOver ? 'border-blue-400 ring-1 ring-blue-400 translate-x-1' : 'border-slate-700'}`}
                                    >
                                        <GripVertical size={18} className="text-slate-500 shrink-0" />
                                        <span className="w-6 text-center text-xs font-mono text-slate-500 shrink-0">{idx + 1}</span>
                                        <div className="flex flex-col truncate">
                                            <span className="text-sm font-medium text-slate-200 truncate">{name}</span>
                                            {ip && <span className="text-xs text-slate-500 font-mono truncate">{ip}</span>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        )}
                    </div>
                </div>
            )}

            {/* Toast notifications */}
            {toasts.length > 0 && (
                <div className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
                    {toasts.map(t => (
                        <div
                            key={t.id}
                            role="alert"
                            className={`toast-in flex items-start gap-3 rounded-lg border px-4 py-3 shadow-2xl ${
                                t.type === 'error' ? 'bg-red-950/95 border-red-500/40 text-red-100'
                                : t.type === 'success' ? 'bg-emerald-950/95 border-emerald-500/40 text-emerald-100'
                                : 'bg-slate-900/95 border-slate-600 text-slate-100'
                            }`}
                        >
                            <div className="mt-0.5 shrink-0">
                                {t.type === 'error' ? <AlertTriangle size={18} className="text-red-400" /> : <Check size={18} className="text-emerald-400" />}
                            </div>
                            <p className="text-sm flex-1 break-words">{t.message}</p>
                            <button onClick={() => dismissToast(t.id)} className="opacity-60 hover:opacity-100 shrink-0"><X size={16} /></button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default App;
