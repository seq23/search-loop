#!/usr/bin/env node
// Every push to a branch from CI rebases onto the moved branch and retries.
// A bare `git push` after a commit fails whenever another job pushed first
// (p-n-p Daily Authority Cycle, 18 Nov 2026: "! [rejected] main -> main (fetch first)").
// Fails on: a `git push` in .github/workflows/*.yml, .github/actions/**/action.yml or
// .github/scripts/*.sh with no `pull --rebase` and no retry loop within 6 lines.
// Exempt: force pushes to a job's own branch, tag pushes, deletes.
// usage: node <this file>   (from the repo root; proves itself on fixtures first)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function barePushes(files) {
  const bad = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      // A push in command position only (not a step name, a comment or an echo).
      if (!/(^|run:\s*|[;&|({!]\s*|\b(then|do|if|else|until|while)\s+)git\s+push\b/.test(t) || /^(#|echo\b|printf\b)/.test(t)) return;
      if (/\s(-f|--force|--force-with-lease|--tags|--delete|-d)\b/.test(t) || /refs\/tags|origin\s+"?v[0-9$]|origin\s+v1\b/.test(t)) return;
      const win = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
      if (/pull\s+--rebase|\brebase\b/.test(win) && /\b(for|while|until)\b[^\n]*;\s*do\b|\bdo\s*$/m.test(win)) return;
      bad.push(`${f.path}:${i + 1}: ${t}`);
    });
  }
  return bad;
}

function collect(root) {
  const out = [];
  const add = (rel) => out.push({ path: rel, text: fs.readFileSync(path.join(root, rel), 'utf8') });
  const ls = (d, re) => (fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d), { recursive: true }).map(String).filter((n) => re.test(n)).map((n) => path.join(d, n)) : []);
  ls('.github/workflows', /\.ya?ml$/).forEach(add);
  ls('.github/actions', /action\.ya?ml$/).forEach(add);
  ls('.github/scripts', /\.sh$/).forEach(add);
  return out;
}

export function selfTest() {
  const old = { path: 'old.yml', text: '        run: |\n          git commit -m x\n          git push\n' };
  const fixed = { path: 'new.yml', text: '          git commit -m x\n          for i in 1 2 3; do git pull --rebase --autostash -q origin "$GITHUB_REF_NAME" && git push origin "HEAD:$GITHUB_REF_NAME" && break; [ "$i" = 3 ] && exit 1; sleep $((i*10)); done\n' };
  const exempt = { path: 'tag.yml', text: '          git push -f origin "$branch"\n          git push origin "v$ver"\n' };
  return barePushes([old]).length === 1 && barePushes([{ path: 'n.yml', text: '      - name: a bare git push fails\n' }]).length === 0 && barePushes([fixed, exempt]).length === 0 && barePushes([{ path: 'm.yml', text: '          git push origin main\n' }]).length === 1;
}

const main = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (main) {
  // The check proves itself on every run: the pre-fix shape is caught, the fix and the exemptions pass.
  if (!selfTest()) { console.error('VALIDATION_FINDING check=workflow-push summary=self-test-blind'); console.error('NAMED STOP [SELF_TEST_BLIND] check-workflow-push missed a bare push or flagged a retried one'); process.exit(1); }
  const files = collect(process.cwd());
  if (!files.length) { console.error('VALIDATION_FINDING check=workflow-push summary=nothing-checked'); console.error('NAMED STOP [NOTHING_CHECKED] no workflow files found under .github/'); process.exit(1); }
  const bad = barePushes(files);
  if (bad.length) { console.error(`VALIDATION_FINDING check=${process.env.VALIDATION_CHECK_ID || 'workflow-push'} summary=bare-git-push`); for (const b of bad) console.error(`FAIL bare git push (no rebase/retry): ${b}`); console.error(`NAMED STOP [BARE_GIT_PUSH] ${bad.length} push(es) fail when main moves; use: for i in 1 2 3; do git pull --rebase --autostash -q origin "$GITHUB_REF_NAME" && git push origin "HEAD:$GITHUB_REF_NAME" && break; [ "$i" = 3 ] && exit 1; sleep $((i*10)); done`); process.exit(1); }
  console.log(`check-workflow-push: OK — ${files.length} file(s), every push rebases and retries (self-test passed)`);
}
