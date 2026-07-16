const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function getWindowsPassword(ec2, instanceId) {
    const pemPath = path.resolve(process.cwd(), 'key.pem');
    if (!fs.existsSync(pemPath)) {
        console.log('No key.pem found');
        return null;
    }
    const { GetPasswordDataCommand } = require('@aws-sdk/client-ec2');
    const res = await ec2.send(new GetPasswordDataCommand({ InstanceId: instanceId }));
    if (!res.PasswordData) return null;
    const privateKey = fs.readFileSync(pemPath, 'utf8');
    const encryptedBuffer = Buffer.from(res.PasswordData, 'base64');
    const decryptedBuffer = crypto.privateDecrypt(
        {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_PADDING
        },
        encryptedBuffer
    );
    return decryptedBuffer.toString('utf8');
}

async function test() {
    const ec2 = new EC2Client({});
    const res = await ec2.send(new DescribeInstancesCommand({}));
    const instances = res.Reservations.flatMap(r => r.Instances);
    const running = instances.find(i => i.State.Name === 'running');
    if (!running) {
        console.log('No running instances');
        return;
    }
    const pass = await getWindowsPassword(ec2, running.InstanceId);
    console.log('Password length:', pass ? pass.length : 0);
}
test().catch(console.error);
