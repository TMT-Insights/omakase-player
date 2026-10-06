import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';

for (const f of readdirSync('patches').filter((f) => f.endsWith('.patch'))) {
  const p = `patches/${f}`;
  try {
    execFileSync('git', ['apply', '--check', '-R', p], {stdio: 'ignore'});
    console.log(`already applied: ${f}`);
    continue;
  } catch {}
  execFileSync('git', ['apply', p], {stdio: 'inherit'});
  console.log(`applied: ${f}`);
}
