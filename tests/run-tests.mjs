import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = await mkdtemp(path.join(tmpdir(), 'jws-tests-'));
const testNames = ['calendarSync', 'hoursAndWage', 'exports', 'migration'];

try {
    await build({
        entryPoints: testNames.map(name => path.join(root, `tests/${name}.test.ts`)),
        outdir: outDir,
        outExtension: { '.js': '.cjs' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        sourcemap: 'inline',
        logLevel: 'silent',
        alias: { obsidian: path.join(root, 'tests/shims/obsidian.ts') }
    });

    const result = spawnSync(process.execPath, ['--test', ...testNames.map(name => path.join(outDir, `${name}.test.cjs`))], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally {
    await rm(outDir, { recursive: true, force: true });
}
