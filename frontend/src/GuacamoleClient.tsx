import { useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, X, GripVertical } from 'lucide-react';
import Guacamole from 'guacamole-common-js';

interface Props {
    instanceId: string;
    token: string;
    name: string;
    ip: string;
    onDisconnect: () => void;
    // Reorder support: the grip in the header is the drag handle. The parent
    // grid cell is the drop target (see App.tsx), so these just report when a
    // drag of this pane starts/ends.
    onReorderDragStart?: (e: React.DragEvent) => void;
    onReorderDragEnd?: () => void;
    // Shared, app-wide clipboard. `clipboard` is the latest text from any source
    // (this device or another session); `onClipboard` reports text this session
    // received (a remote copy) or typed into the clipboard box, so it propagates
    // to every other open session.
    clipboard: string;
    onClipboard: (text: string) => void;
}

export const GuacamoleClient: React.FC<Props> = ({ token, name, ip, onDisconnect, clipboard, onClipboard, onReorderDragStart, onReorderDragEnd }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const displayRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<string>('Connecting...');
    const clientRef = useRef<Guacamole.Client | null>(null);
    // Last clipboard value this session has already sent to / received from its
    // remote, used to avoid echo loops and redundant re-pushes.
    const lastClipboard = useRef<string>('');
    const [isFullscreen, setIsFullscreen] = useState(false);
    // Explicit display size: the largest 16:9 rectangle that fits the grid cell
    // *below* the static header. Computed in JS because pure-CSS aspect-ratio
    // can't reliably produce a "largest fitting box" for a plain <div> when
    // height is the limiting axis.
    const [box, setBox] = useState<{ w: number; h: number } | null>(null);

    // Keep the display shaped exactly 16:9 and as large as its cell allows,
    // reserving room for the static header. When the cell (or the screen, in
    // fullscreen) resizes, recompute so the remote 1920x1080 desktop fills the
    // display area edge-to-edge with no black bars.
    useEffect(() => {
        const cell = rootRef.current?.parentElement;
        if (!cell) return;
        const measure = () => {
            const headerH = headerRef.current?.offsetHeight ?? 0;
            const cw = cell.clientWidth;
            const ch = cell.clientHeight - headerH;
            if (cw <= 0 || ch <= 0) return;
            let w = cw;
            let h = (w * 9) / 16;
            if (h > ch) { h = ch; w = (h * 16) / 9; }
            setBox({ w: Math.floor(w), h: Math.floor(h) });
        };
        const ro = new ResizeObserver(measure);
        ro.observe(cell);
        measure();
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        if (!displayRef.current) return;

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsBase = import.meta.env.VITE_WS_URL || `${wsProtocol}//${window.location.host}/rdpm/ws`;
        const tunnel = new Guacamole.WebSocketTunnel(wsBase);
        const client = new Guacamole.Client(tunnel);
        clientRef.current = client;

        // Add display to DOM
        const display = client.getDisplay();
        const displayEl = display.getElement();
        displayRef.current.innerHTML = '';
        displayRef.current.appendChild(displayEl);

        // Fit the remote 1920x1080 desktop to its (16:9) container. The pane is
        // shaped 16:9 in the layout, so this fills the pane exactly with no
        // letterboxing and no distortion.
        const scaleDisplay = () => {
            const container = displayRef.current;
            if (!container || display.getWidth() === 0) return;
            const scale = Math.min(
                container.clientWidth / display.getWidth(),
                container.clientHeight / display.getHeight()
            );
            if (scale > 0) display.scale(scale);
        };

        // Error handler
        client.onerror = (error) => {
            console.error('Guacamole Error:', error);
            setStatus(`Error: ${error.message}`);
        };

        // State change handler
        client.onstatechange = (state) => {
            switch (state) {
                case 0: setStatus('Idle'); break;
                case 1: setStatus('Connecting...'); break;
                case 2: setStatus('Waiting...'); break;
                case 3:
                    setStatus('Connected');
                    // Ensure we're scaled once the connection is live, even if
                    // the remote size arrived before the container was measured.
                    scaleDisplay();
                    break;
                case 4:
                    setStatus('Disconnecting...');
                    break;
                case 5:
                    setStatus('Disconnected');
                    onDisconnect();
                    break;
            }
        };

        // Re-scale whenever the remote reports a new desktop size. Without this
        // the canvas stays at its native resolution until the browser window is
        // resized, which showed up as a black pane on connect.
        display.onresize = scaleDisplay;

        // Keyboard: forward keys to the remote only while THIS pane is focused
        // (i.e. the user has clicked into the session). Attached to document but
        // gated on focus so keystrokes never leak to an unfocused session or to
        // on-page inputs like the clipboard box.
        const focusTarget = displayRef.current;
        const keyboard = new Guacamole.Keyboard(document);
        const pressedKeys = new Set<number>();

        const releaseAllKeys = () => {
            pressedKeys.forEach((keysym) => client.sendKeyEvent(0, keysym));
            pressedKeys.clear();
        };

        keyboard.onkeydown = (keysym) => {
            // Not focused: let the browser handle the key (typing in inputs, etc.)
            // and do NOT preventDefault.
            if (document.activeElement !== focusTarget) return true;
            client.sendKeyEvent(1, keysym);
            pressedKeys.add(keysym);
            // Focused: preventDefault so modifier combos (Ctrl, Alt, Ctrl+Alt+…)
            // reach the remote instead of triggering the browser's own shortcuts.
            return false;
        };
        keyboard.onkeyup = (keysym) => {
            if (!pressedKeys.has(keysym)) return true;
            client.sendKeyEvent(0, keysym);
            pressedKeys.delete(keysym);
            return false;
        };

        // Release everything when focus leaves the pane or the window (e.g.
        // Alt+Tab). Otherwise a held Ctrl/Alt's keyup is never delivered and the
        // modifier stays stuck "down" in the session, which breaks every
        // subsequent Ctrl/Alt shortcut until you press and release it again.
        const handleFocusLoss = () => releaseAllKeys();
        focusTarget.addEventListener('blur', handleFocusLoss);
        window.addEventListener('blur', handleFocusLoss);

        // Mouse setup
        const mouse = new Guacamole.Mouse(displayEl);
        // @ts-ignore
        mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState: any) => {
            const scale = display.getScale() || 1;
            const scaledState = new Guacamole.Mouse.State(
                mouseState.x / scale,
                mouseState.y / scale,
                mouseState.left,
                mouseState.middle,
                mouseState.right,
                mouseState.up,
                mouseState.down
            );
            client.sendMouseState(scaledState);
        };

        // Connect using the token
        client.connect(`token=${token}`);

        // Scale display to fit container visually when the pane itself resizes.
        const resizeObserver = new ResizeObserver(() => scaleDisplay());
        resizeObserver.observe(displayRef.current);

        // Remote copy -> shared clipboard. Publishing to the shared clipboard is
        // what makes copy/paste work *between* sessions: every other open session
        // then receives this text (see the broadcast effect below). We also make a
        // best-effort write to the OS clipboard so it can be pasted into local apps.
        client.onclipboard = (stream, mimetype) => {
            if (mimetype === 'text/plain') {
                const reader = new Guacamole.StringReader(stream);
                let data = '';
                reader.ontext = (text) => { data += text; };
                reader.onend = () => {
                    lastClipboard.current = data; // we already have it; don't push back
                    onClipboard(data);
                    if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(data).catch(() => {});
                    }
                };
            }
        };

        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);

        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
            focusTarget.removeEventListener('blur', handleFocusLoss);
            window.removeEventListener('blur', handleFocusLoss);
            if (resizeObserver) resizeObserver.disconnect();
            display.onresize = null;
            keyboard.onkeydown = null;
            keyboard.onkeyup = null;
            releaseAllKeys();
            client.disconnect();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    // Push text to the remote clipboard. StringWriter/ArrayBufferWriter already
    // split the payload into protocol-sized blobs, so we send it all at once and
    // close the stream. (An earlier ack-gated version stalled after the first
    // chunk because guacd does not ack every clipboard blob, which truncated
    // long text — do not reintroduce that.) The real length ceiling is guacd's
    // GUAC_COMMON_CLIPBOARD_MAX_LENGTH, raised to 2 MiB in the custom image.
    const sendClipboard = (text: string) => {
        const client = clientRef.current;
        if (!client || text === lastClipboard.current) return;
        lastClipboard.current = text;

        const stream = client.createClipboardStream('text/plain');
        const writer = new Guacamole.StringWriter(stream);
        writer.sendText(text);
        writer.sendEnd();
    };

    // Broadcast: whenever the shared clipboard changes (from this device or any
    // other session), push it into this session's remote desktop, so pasting
    // inside the remote just works. Skips if this session already has the value.
    useEffect(() => {
        if (status === 'Connected' && clipboard && clipboard !== lastClipboard.current) {
            sendClipboard(clipboard);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clipboard, status]);

    // On entering a session, pull the OS clipboard so text copied on this device
    // flows into the shared clipboard (and thus into every session).
    const handleNativePaste = async () => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                const text = await navigator.clipboard.readText();
                if (text && text !== lastClipboard.current) onClipboard(text);
            }
        } catch (err) {
            console.log("Clipboard paste failed", err);
        }
    };

    const toggleFullscreen = () => {
        // Fullscreen the grid cell (the pane's parent) rather than the pane
        // itself, so the 16:9 sizing logic re-measures against the full screen.
        const container = rootRef.current?.parentElement;
        if (!container) return;
        if (!document.fullscreenElement) {
            container.requestFullscreen().catch(err => {
                console.error('Error attempting to enable fullscreen:', err);
            });
        } else {
            document.exitFullscreen();
        }
    };

    return (
        <div
            ref={rootRef}
            className="relative bg-slate-900 border-2 border-slate-700 rounded-lg overflow-hidden flex flex-col group focus-within:border-yellow-400 focus-within:shadow-[0_0_15px_rgba(250,204,21,0.6)] transition-[border-color,box-shadow] duration-150 max-w-full max-h-full"
            style={box ? { width: box.w } : { width: '100%', height: '100%' }}
            onClick={() => displayRef.current?.focus()}
        >
            {/* Static header above the session */}
            <div ref={headerRef} className="bg-slate-800 border-b border-slate-700 p-2 text-white flex justify-between items-center shrink-0 z-10">
                <span className="flex items-center gap-1.5 truncate">
                    <span
                        draggable
                        onDragStart={(e) => { e.stopPropagation(); onReorderDragStart?.(e); }}
                        onDragEnd={(e) => { e.stopPropagation(); onReorderDragEnd?.(); }}
                        onClick={(e) => e.stopPropagation()}
                        className="text-slate-500 hover:text-slate-300 cursor-grab active:cursor-grabbing shrink-0"
                        title="Drag to reorder"
                    >
                        <GripVertical size={16} />
                    </span>
                    <span className="font-semibold text-sm truncate">{name} {ip && <span className="opacity-60 font-mono text-xs ml-1">({ip})</span>}</span>
                </span>
                <div className="flex gap-4 items-center shrink-0 ml-4">
                    <button onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} className="text-slate-300 hover:text-white transition-colors" title="Fullscreen">
                        {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onDisconnect(); }} className="text-red-400 hover:text-red-300 transition-colors" title="Disconnect">
                        <X size={20} />
                    </button>
                </div>
            </div>

            {/* Display area — JS-sized to a 16:9 box so the 1920x1080 desktop
                fills it with no letterboxing */}
            <div
                ref={displayRef}
                className="relative flex items-center justify-center outline-none cursor-none overflow-hidden bg-black shrink-0"
                style={box ? { width: box.w, height: box.h } : { flex: 1, width: '100%' }}
                tabIndex={0}
                onMouseEnter={handleNativePaste}
            />
        </div>
    );
}
