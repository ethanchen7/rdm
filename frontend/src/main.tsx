import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import AuthGate from './Auth.tsx'

// A thin global wrapper rather than threading auth state through every call
// site in App.tsx: (1) always sends the session cookie, which matters in dev
// mode where the Vite dev server and the API are on different ports (fetch's
// default 'same-origin' credentials mode wouldn't send it there), and (2)
// tells AuthGate to drop back to the login screen the moment any API call
// reports the session is gone — expired, or logged out from another tab.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const isApi = url.includes('/api/');
    const res = await nativeFetch(input, isApi ? { credentials: 'include', ...init } : init);
    if (isApi && res.status === 401 && !url.includes('/api/auth/')) {
        window.dispatchEvent(new Event('rdm-session-expired'));
    }
    return res;
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
)
