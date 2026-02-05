import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

async function getFreePort(host) {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, host, () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to acquire a free TCP port.')));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}

async function main() {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

	const host = process.env.FIRESTORE_EMULATOR_HOSTNAME?.trim() || '127.0.0.1';
	const requestedPortRaw = process.env.FIRESTORE_EMULATOR_PORT?.trim() || null;
	const port = requestedPortRaw ? Number(requestedPortRaw) : await getFreePort(host);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid FIRESTORE_EMULATOR_PORT: '${requestedPortRaw ?? String(port)}'`);
	}

	const projectId = process.env.FIRESTORE_EMULATOR_PROJECT_ID?.trim() || 'demo-firebase-admin-cloudflare';
	const testCommand = process.env.FIRESTORE_EMULATOR_TEST_COMMAND?.trim() || 'npm run test:integration:vitest';

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'firebase-admin-cloudflare-'));
	const configPath = path.join(tmpDir, 'firebase.json');
	await fs.writeFile(
		configPath,
		JSON.stringify(
			{
				emulators: {
					firestore: { host, port },
					ui: { enabled: false }
				}
			},
			null,
			2
		)
	);

	const firebaseCmd =
		process.platform === 'win32'
			? path.join(repoRoot, 'node_modules', '.bin', 'firebase.cmd')
			: path.join(repoRoot, 'node_modules', '.bin', 'firebase');

	const args = [
		'--non-interactive',
		'--project',
		projectId,
		'--config',
		configPath,
		'emulators:exec',
		'--only',
		'firestore',
		testCommand
	];

	const child = spawn(firebaseCmd, args, {
		stdio: 'inherit',
		env: process.env,
		cwd: repoRoot
	});

	child.on('exit', async (code) => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} finally {
			process.exit(typeof code === 'number' ? code : 1);
		}
	});
}

void main();

