import { spawn, ChildProcess } from 'child_process';
import net from 'net';

export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
        srv.on('error', reject);
    });
}

const activeTunnels: Record<string, { process: ChildProcess, port: number }> = {};

export async function startSSMTunnel(instanceId: string): Promise<number> {
    if (activeTunnels[instanceId]) {
        return activeTunnels[instanceId].port;
    }

    const port = await findFreePort();
    
    return new Promise((resolve, reject) => {
        const cmd = 'aws';
        const args = [
            'ssm', 'start-session',
            '--target', instanceId,
            '--document-name', 'AWS-StartPortForwardingSession',
            '--parameters', `portNumber=3389,localPortNumber=${port}`
        ];

        console.log(`Starting tunnel for ${instanceId} on port ${port}...`);
        const proc = spawn(cmd, args);

        let started = false;
        
        proc.stdout?.on('data', (data) => {
            const out = data.toString();
            console.log(`[SSM ${instanceId}] ${out}`);
            if (out.includes('Port') && out.includes('opened for sessionId')) {
                started = true;
                activeTunnels[instanceId] = { process: proc, port };
                resolve(port);
            }
        });

        proc.stderr?.on('data', (data) => {
            console.error(`[SSM ERR ${instanceId}] ${data.toString()}`);
        });

        proc.on('close', (code) => {
            console.log(`SSM tunnel for ${instanceId} closed with code ${code}`);
            delete activeTunnels[instanceId];
            if (!started) {
                reject(new Error(`Failed to start tunnel, exited with ${code}`));
            }
        });
    });
}

export function stopSSMTunnel(instanceId: string) {
    if (activeTunnels[instanceId]) {
        activeTunnels[instanceId].process.kill();
        delete activeTunnels[instanceId];
    }
}
