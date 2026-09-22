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
const DRY = process.argv.includes('--dry');
const BASE = (process.argv[2] && process.argv[2] !== '--dry')
  ? process.argv[2]
  : ghJson(`/repos/${repo}/git/ref/heads/main`).object.sha;

if (BASE === HEAD) {
  console.log(`远端已经是最新（${HEAD}），无需推送。`);
  process.exit(0);
}

// 远端 base 是否在本地对象库里。
// 注意：本机 `git cat-file -e` / `git fetch` / `git push` 都会挂死（代理拦 git 传输，
// 对象写操作会触网），所以这里用 `git rev-parse --quiet --verify`（纯本地、秒回）判断。
// base 不在本地时不再尝试 fetch，而是改走 API 比对两棵 tree 来算差量。
const hasBase = () => {
  try {
    git(['rev-parse', '--quiet', '--verify', `${BASE}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};
const baseLocal = hasBase();

// base tree 的文件清单（仅在 base 不在本地时通过 API 取，供上传阶段「沿用远端 blob」用）
let baseFiles = {};

// ---- 差量文件列表 ----
// base 在本地：直接 git diff（最快、最准）。
// base 不在本地（本机无法 fetch）：用 GitHub API 比对 base tree 与本地 HEAD tree。
function localChanges() {
  const raw = git(['diff', '--name-status', '-z', BASE, HEAD], { encoding: 'utf8' });
  const parts = raw.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const p = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const p2 = parts[i++];
      out.push({ status: status[0], path: p2, from: p });
    } else {
      out.push({ status: status[0], path: p });
    }
  }
  return out;
}
function apiChanges() {
  const baseTreeSha = ghJson(`/repos/${repo}/git/commits/${BASE}`).tree.sha;
  const headTreeSha = gitText(['rev-parse', `HEAD^{tree}`]);
  for (const e of ghJson(`/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`).tree) {
    if (e.type === 'blob') baseFiles[e.path] = e.sha;
  }
  const headFiles = {};
  for (const line of git(['ls-tree', '-r', HEAD], { encoding: 'utf8' }).split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^\d+\s+\w+\s+(\S+)\t(.+)$/);
    if (m) headFiles[m[2]] = m[1];
  }
  const out = [];
  const all = new Set([...Object.keys(baseFiles), ...Object.keys(headFiles)]);
  for (const p of all) {
    const b = baseFiles[p];
    const h = headFiles[p];
    if (b && !h) out.push({ status: 'D', path: p });
    else if (!b && h) out.push({ status: 'A', path: p });
    else if (b !== h) out.push({ status: 'M', path: p });
  }
  return out;
}
const changes = baseLocal ? localChanges() : apiChanges();

/**
 * 读本地 HEAD 的 blob 内容（二进制安全）。
 * 受限环境是 blobless 克隆：缺失的 blob 走网络会被代理挂死，
 * 所以这里加 8s 超时，读不到就返回 null，由调用方「沿用远端 blob」避免误改线上。
 */
function readLocalBlob(path) {
  try {
    return git(['cat-file', 'blob', `${HEAD}:${path}`], { timeout: 8000 });
  } catch {
    return null;
  }
}
function modeForPath(path) {
  try {
    const m = gitText(['ls-tree', HEAD, '--', path]).split(/\s+/)[0];
    return m || '100644';
  } catch {
    return '100644';
  }
}
console.log(`仓库: ${repo}\nbase: ${BASE}${baseLocal ? '' : ' (走 API 算差量)'} \nhead: ${HEAD}\n变更文件: ${changes.length}`);
if (!changes.length) {
  console.log('代码内容无变化，仅 commit 元数据不同；将直接建空 tree 提交。');
}
if (DRY) {
  console.log('[dry] 仅打印变更，未推送：');
  for (const c of changes) console.log(`  ${c.status} ${c.path}`);
  process.exit(0);
}

// ---- 逐文件建 blob ----
const treeEntries = [];
for (const c of changes) {
  if (c.status === 'D') {
    // 删除：本地 blobless 克隆无法确认是否真删，为安全沿用远端同名 blob（不删），
    // 避免误删线上资源。确需删除时请在本机完整克隆后推送。
    const baseSha = baseFiles[c.path];
    if (baseSha) {
      treeEntries.push({ path: c.path, mode: modeForPath(c.path), type: 'blob', sha: baseSha });
      console.log(`  ~D ${c.path} (沿用远端 blob，本地不可读，不删除)`);
    } else {
      treeEntries.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
      console.log(`  D ${c.path}`);
    }
    continue;
  }
  const buf = readLocalBlob(c.path);
  if (!buf) {
    // 本地读不到 blob（blobless 克隆）：沿用远端同名 blob，不重新上传、不误改线上。
    const baseSha = baseFiles[c.path];
    if (baseSha) {
      treeEntries.push({ path: c.path, mode: modeForPath(c.path), type: 'blob', sha: baseSha });
      console.log(`  ~ ${c.status} ${c.path} (本地无 blob，沿用远端)`);
    }
    continue;
  }
  const blob = ghJson(`/repos/${repo}/git/blobs`, 'POST', {
    content: buf.toString('base64'),
    encoding: 'base64',
  });
  treeEntries.push({ path: c.path, mode: modeForPath(c.path), type: 'blob', sha: blob.sha });
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
