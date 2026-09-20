#!/usr/bin/env node
/**
 * 通过 GitHub Git Database API 推送本地提交。
 *
 * 背景：本机 git push 走代理（127.0.0.1:51822）会返回 502 / exit 128，
 * 但 `gh api` 的 HTTPS 通道是好的。所以这里绕开 git 传输层：
 *   1. 用 `git cat-file` 从本地对象库读出差异文件的 blob
 *   2. 逐个 POST /git/blobs 拿到远端 blob sha
 *   3. POST /git/trees（带 base_tree）合成新 tree —— 只提交差量，不用枚举全仓库
 *   4. POST /git/commits（parent = 远端当前 commit）生成新 commit
 *   5. PATCH /git/refs/heads/main 推进分支
 *
 * 用法：node tools/gh-push.mjs <远端当前sha|空> 
 *   不带参数时自动以「远端 ref 指向的 commit」为 base。
 * 环境变量：GH_REPO=owner/repo（默认从 git remote 解析）
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, ...opts });
}
function gitText(args) {
  return git(args, { encoding: 'utf8' }).trim();
}
function ghJson(path, method = 'GET', body) {
  const args = ['api', path, '-X', method];
  if (body) args.push('--input', '-');
  const out = execFileSync('gh', args, {
    cwd: ROOT,
    input: body ? JSON.stringify(body) : undefined,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : null;
}

// ---- 解析仓库 ----
let repo = process.env.GH_REPO;
if (!repo) {
  const url = gitText(['config', '--get', 'remote.origin.url']);
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`无法从 remote url 解析仓库名: ${url}`);
  repo = m[1];
}

const HEAD = gitText(['rev-parse', 'HEAD']);
const BASE = process.argv[2] || ghJson(`/repos/${repo}/git/ref/heads/main`).object.sha;

if (BASE === HEAD) {
  console.log(`远端已经是最新（${HEAD}），无需推送。`);
  process.exit(0);
}

// 远端 base 必须存在于本地对象库，否则无法算差量。
// 注意：沙箱会拦住 tracking ref 的写入（refs/remotes/origin/main 建不出来），
// 但 fetch 仍然会把对象下载下来并写进 FETCH_HEAD —— 所以只看对象是否存在，不看 ref。
const hasBase = () => {
  try {
    git(['cat-file', '-e', `${BASE}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};
if (!hasBase()) {
  console.log(`本地缺少远端 base ${BASE.slice(0, 8)}，自动 fetch...`);
  try {
    git(['fetch', 'origin', 'main'], { stdio: 'pipe' });
  } catch (e) {
    // fetch 可能因写入 ref 失败而返回非 0，但对象通常已经下载成功，继续用对象存在性判断
    if (!hasBase()) throw e;
  }
  if (!hasBase()) {
    throw new Error(`本地缺少远端 base commit ${BASE}，请先 git fetch origin main`);
  }
  console.log('fetch 完成。');
}

// ---- 差量文件列表（-z 避免中文路径被引号转义） ----
const raw = git(['diff', '--name-status', '-z', BASE, HEAD], { encoding: 'utf8' });
const parts = raw.split('\0').filter(Boolean);
const changes = [];
for (let i = 0; i < parts.length; ) {
  const status = parts[i++];
  const p = parts[i++];
  if (status.startsWith('R') || status.startsWith('C')) {
    const p2 = parts[i++];
    changes.push({ status: status[0], path: p2, from: p });
  } else {
    changes.push({ status: status[0], path: p });
  }
}
console.log(`仓库: ${repo}\nbase: ${BASE}\nhead: ${HEAD}\n变更文件: ${changes.length}`);
if (!changes.length) {
  console.log('代码内容无变化，仅 commit 元数据不同；将直接建空 tree 提交。');
}

// ---- 逐文件建 blob ----
const treeEntries = [];
for (const c of changes) {
  if (c.status === 'D') {
    treeEntries.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
    console.log(`  D ${c.path}`);
    continue;
  }
  // 读模式与内容（二进制安全）
  let mode;
  try {
    mode = gitText(['ls-tree', HEAD, '--', c.path]).split(/\s+/)[0];
  } catch {
    mode = '100644';
  }
  if (!mode) mode = '100644';
  const buf = git(['cat-file', 'blob', `${HEAD}:${c.path}`]);
  const blob = ghJson(`/repos/${repo}/git/blobs`, 'POST', {
    content: buf.toString('base64'),
    encoding: 'base64',
  });
  treeEntries.push({ path: c.path, mode, type: 'blob', sha: blob.sha });
  console.log(`  ${c.status} ${c.path} -> ${blob.sha.slice(0, 8)} (${Math.round(buf.length / 1024)} KB)`);
}

// ---- 合成 tree ----
const baseTree = ghJson(`/repos/${repo}/git/commits/${BASE}`).tree.sha;
const newTree = ghJson(`/repos/${repo}/git/trees`, 'POST', {
  base_tree: baseTree,
  tree: treeEntries,
});
console.log(`tree: ${newTree.sha}`);

// ---- 建 commit（沿用本地提交的 message / 作者 / 时间） ----
const meta = gitText(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', HEAD]).split('\0');
const [an, ae, aI, cn, ce, cI, message] = meta;
const newCommit = ghJson(`/repos/${repo}/git/commits`, 'POST', {
  message,
  tree: newTree.sha,
  parents: [BASE],
  author: { name: an, email: ae, date: aI },
  committer: { name: cn, email: ce, date: cI },
});
console.log(`commit: ${newCommit.sha}`);

// ---- 推进分支（非强制，若远端已被他人推进会报错而不是覆盖） ----
const updated = ghJson(`/repos/${repo}/git/refs/heads/main`, 'PATCH', {
  sha: newCommit.sha,
  force: false,
});
console.log(`远端 main 已更新为 ${updated.object.sha}`);
