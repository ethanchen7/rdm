import { useEffect, useRef } from 'react';

// How often to re-read the device clipboard while this tab has focus. The OS
// clipboard has no change event available to web pages, so polling is the only
// way to notice that the user copied something in another app. A read is a
// cheap string fetch; sub-second keeps a paste feeling instant.
const POLL_MS = 700;

/**
 * Keeps the app in sync with the *device* (OS) clipboard.
 *
 * `onText` is called whenever the device clipboard's text changes. Reads happen
 * on a poll while the tab has focus, plus immediately on the events that mean
 * "the user probably just copied something elsewhere": regaining window focus,
 * the tab becoming visible, and pointer presses.
 *
 * Reading on window focus is the important one. An earlier version only read on
 * `mouseenter` of a session pane, which left the app holding a stale value in
 * two very common cases: switching back to the tab with the pointer already
 * sitting over the pane (no `mouseenter` fires at all), and crossing into the
 * pane before the window had focus — `readText()` rejects with "Document is not
 * focused", and nothing ever retried. Either way the next paste delivered the
 * *previous* copy. Do not go back to a single, event-shaped read.
 */
export function useDeviceClipboard(onText: (text: string) => void): void {
    const onTextRef = useRef(onText);
    onTextRef.current = onText;

    useEffect(() => {
        if (!window.isSecureContext || !navigator.clipboard?.readText) return;

        let cancelled = false;
        // Last value read off the device, so we only report actual changes.
        let lastRead = '';
        // Set when a read is rejected — permission refused, or the document
        // wasn't focused. Polling pauses until something that could plausibly
        // fix it (focus, a click) happens, rather than throwing every tick.
        let blocked = false;
        // Whether reading is allowed at all. Chromium exposes 'clipboard-read'
        // through the Permissions API and, once granted, reads are silent.
        // Firefox and Safari have no such permission — every read needs a
        // gesture and raises a "Paste" confirmation — so we stay quiet there
        // rather than popping a dialog on every click. (Device -> session sync
        // never worked on those engines under the old mouseenter read either,
        // for the same reason.)
        let allowed = false;

        const read = async () => {
            if (cancelled || !allowed) return;
            // readText() always rejects on an unfocused document; skip the noise.
            if (!document.hasFocus()) return;
            try {
                const text = await navigator.clipboard.readText();
                blocked = false;
                if (cancelled || text === lastRead) return;
                lastRead = text;
                if (text) onTextRef.current(text);
            } catch {
                blocked = true;
            }
        };
        navigator.permissions?.query({ name: 'clipboard-read' as PermissionName })
            .then(status => {
                const apply = () => {
                    if (cancelled) return;
                    // 'prompt' is worth attempting: the first gesture-driven read
                    // is what surfaces the permission request in the first place.
                    allowed = status.state !== 'denied';
                    void read();
                };
                status.onchange = apply;
                apply();
            })
            .catch(() => { /* engine without the permission — stay disabled */ });

        const timer = window.setInterval(() => { if (!blocked) void read(); }, POLL_MS);

        const resume = () => { blocked = false; void read(); };
        const onVisible = () => { if (document.visibilityState === 'visible') resume(); };

        window.addEventListener('focus', resume);
        document.addEventListener('visibilitychange', onVisible);
        // Capture phase: a pointer press carries user activation — what a browser
        // wants to see before granting clipboard-read the first time — and this
        // beats the click through to whatever session pane was clicked.
        window.addEventListener('pointerdown', resume, true);

        return () => {
            cancelled = true;
            window.clearInterval(timer);
            window.removeEventListener('focus', resume);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('pointerdown', resume, true);
        };
    }, []);
}

/**
 * Best-effort write to the device clipboard. Resolves false (rather than
 * throwing) outside a secure context — plain HTTP on a LAN IP, where the
 * Clipboard API isn't exposed at all.
 */
export async function writeDeviceClipboard(text: string): Promise<boolean> {
    if (!window.isSecureContext || !navigator.clipboard?.writeText) return false;
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}
