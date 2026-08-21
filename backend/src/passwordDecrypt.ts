import { DATA_DIR } from './dataDir';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EC2Client, GetPasswordDataCommand } from '@aws-sdk/client-ec2';

const pemPath = path.join(DATA_DIR, 'key.pem');

export async function getWindowsPassword(ec2: EC2Client, instanceId: string): Promise<string | null> {
    // If the user hasn't provided a key.pem, fallback to environment variable
    if (!fs.existsSync(pemPath)) {
        console.log(`[Auth] No key.pem found, relying on RDP_PASSWORD env for ${instanceId}`);
        return process.env.RDP_PASSWORD || null;
    }

    try {
        console.log(`[Auth] Fetching encrypted password for ${instanceId}...`);
        const cmd = new GetPasswordDataCommand({ InstanceId: instanceId });
        const res = await ec2.send(cmd);
        
        if (!res.PasswordData) {
            console.log(`[Auth] No password data available for ${instanceId} (might still be initializing)`);
            return process.env.RDP_PASSWORD || null;
        }

        const pemKey = fs.readFileSync(pemPath, 'utf8');
        
        // AWS PasswordData is base64 encoded
        const encryptedBuffer = Buffer.from(res.PasswordData, 'base64');
        
        const decrypted = crypto.privateDecrypt(
            {
                key: pemKey,
                padding: crypto.constants.RSA_PKCS1_PADDING
            },
            encryptedBuffer
        );
        
        return decrypted.toString('utf8');

    } catch (err) {
        console.error(`[Auth] Failed to decrypt password for ${instanceId}:`, err);
        return process.env.RDP_PASSWORD || null;
    }
}
