import path from 'path';
import dotenv from 'dotenv';

// Where writable runtime state lives: .env, rdm.sqlite, key.pem, TLS certs.
// Unset (the traditional `cd backend && npx ts-node src/index.ts` / compiled
// `node dist/index.js` flow) resolves to the backend package directory
// itself, exactly matching pre-existing behavior. The Electron main process
// sets RDM_DATA_DIR to a per-user app-data directory before requiring the
// backend, since the packaged app's own install location generally isn't
// writable (and shouldn't be — that's where the read-only compiled code and
// frontend bundle live).
export const DATA_DIR = process.env.RDM_DATA_DIR
    ? path.resolve(process.env.RDM_DATA_DIR)
    : path.join(__dirname, '..');

dotenv.config({ path: path.join(DATA_DIR, '.env') });
