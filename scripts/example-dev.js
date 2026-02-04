import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(repoRoot, '.env.local');

const wranglerArgs = [
	'dev',
	'--local',
	'--config',
	path.join(repoRoot, 'examples', 'worker', 'wrangler.toml'),
	'--ip',
	'127.0.0.1',
	'--port',
	'8788',
	'--env-file',
	envFile
];

const cmd = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';

const child = spawn(cmd, wranglerArgs, {
	stdio: 'inherit',
	env: process.env
});

child.on('exit', (code) => {
	process.exit(typeof code === 'number' ? code : 0);
});

