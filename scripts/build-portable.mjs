/**
 * Assemble the portable distribution:
 *
 *   build/portable/
 *   ├── WeChat Claude.exe        Tauri shell (cargo release build)
 *   ├── node/node.exe            pinned Node 22 LTS runtime
 *   ├── dist/                    compiled service
 *   ├── node_modules/            production deps (--omit=dev --omit=optional:
 *   │                             the 218MB claude.exe platform package is
 *   │                             downloaded on first run instead)
 *   ├── scripts/ skills/ package.json
 *
 * then zips it into release/WeChatClaude-portable-<version>.zip.
 *
 * Usage: node scripts/build-portable.mjs   (npm run dist:portable)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(repoRoot, "build", "portable");
const npmStage = path.join(repoRoot, "build", "npm-stage");
const nodeCacheDir = path.join(repoRoot, ".tmp", "node-runtime");
const releaseDir = path.join(repoRoot, "release");

const NODE_VERSION = "22.23.2";
const NODE_URLS = [
  `https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}/win-x64/node.exe`,
  `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`,
];

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
const productExe = `${pkg.build?.productName ?? "WeChat Claude"}.exe`;

function run(cmd, args, opts = {}) {
  // On Windows npm/npx are .cmd shims; Node refuses to spawn .cmd without
  // a shell (EINVAL since the CVE-2024-27980 hardening).
  const executable = process.platform === "win32" && ["npm", "npx"].includes(cmd)
    ? `${cmd}.cmd`
    : cmd;
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(executable, args, { stdio: "inherit", cwd: repoRoot, shell: needsShell, ...opts });
}

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function mb(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  const walk = (entry) => {
    if (fs.statSync(entry).isFile()) return fs.statSync(entry).size;
    return fs.readdirSync(entry).reduce((sum, name) => sum + walk(path.join(entry, name)), 0);
  };
  return st.isFile() ? st.size : walk(p);
}

function fmtMb(bytes) {
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

async function ensureNodeExe() {
  const cached = path.join(nodeCacheDir, `node-v${NODE_VERSION}.exe`);
  if (fs.existsSync(cached)) return cached;
  fs.mkdirSync(nodeCacheDir, { recursive: true });
  const tmp = `${cached}.part`;
  let lastError = null;
  for (const url of NODE_URLS) {
    try {
      console.log(`下载 Node ${NODE_VERSION}：${url}`);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const out = fs.createWriteStream(tmp);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(Buffer.from(value))) {
          await new Promise((resolve) => out.once("drain", resolve));
        }
      }
      await new Promise((resolve) => out.end(resolve));
      fs.renameSync(tmp, cached);
      return cached;
    } catch (err) {
      lastError = err;
      fs.rmSync(tmp, { force: true });
      console.warn(`  失败：${String(err)}`);
    }
  }
  throw new Error(`无法下载 Node ${NODE_VERSION}：${String(lastError)}`);
}

// -------------------------------------------------------------------- steps

console.log("== 1/6 编译服务 ==");
run("npm", ["run", "build:app"]);

console.log("== 2/6 生产依赖（不含 claude 平台包）==");
rm(npmStage);
fs.mkdirSync(npmStage, { recursive: true });
fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(npmStage, "package.json"));
fs.copyFileSync(path.join(repoRoot, "package-lock.json"), path.join(npmStage, "package-lock.json"));
run("npm", ["ci", "--omit=dev", "--omit=optional"], { cwd: npmStage });

console.log("== 3/6 Node 运行时 ==");
const nodeExe = await ensureNodeExe();

console.log("== 4/6 组装便携目录 ==");
rm(staging);
fs.mkdirSync(path.join(staging, "node"), { recursive: true });
fs.copyFileSync(nodeExe, path.join(staging, "node", "node.exe"));
copyDir(path.join(repoRoot, "dist"), path.join(staging, "dist"));
copyDir(path.join(npmStage, "node_modules"), path.join(staging, "node_modules"));
fs.mkdirSync(path.join(staging, "scripts"), { recursive: true });
for (const f of ["preprocess.py", "preprocess-requirements.txt"]) {
  fs.copyFileSync(path.join(repoRoot, "scripts", f), path.join(staging, "scripts", f));
}
copyDir(path.join(repoRoot, "skills"), path.join(staging, "skills"));
fs.writeFileSync(
  path.join(staging, "package.json"),
  `${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true }, null, 2)}\n`,
  "utf-8",
);

console.log("== 5/6 Tauri 壳（cargo release）==");
run("npx", ["tauri", "build"]);
// With bundling disabled the binary is named after the crate, not productName.
const builtExe = path.join(repoRoot, "src-tauri", "target", "release", "wechat-claude-shell.exe");
if (!fs.existsSync(builtExe)) {
  throw new Error(`未找到构建产物：${builtExe}`);
}
fs.copyFileSync(builtExe, path.join(staging, productExe));

console.log("== 6/6 打包 zip ==");
fs.mkdirSync(releaseDir, { recursive: true });
const zipPath = path.join(releaseDir, `WeChatClaude-portable-${pkg.version}.zip`);
fs.rmSync(zipPath, { force: true });
run("powershell", [
  "-NoProfile", "-Command",
  `Compress-Archive -Path (Join-Path '${staging}' '*') -DestinationPath '${zipPath}' -Force`,
]);

// ------------------------------------------------------------------ summary

console.log("\n便携包构建完成：");
console.log(`  ${zipPath}  (${fmtMb(fs.statSync(zipPath).size)})`);
const parts = [
  [productExe, "Tauri 壳"],
  ["node/node.exe", "Node 运行时"],
  ["dist", "服务代码"],
  ["node_modules", "生产依赖"],
  ["skills", "文档生成技能"],
];
for (const [rel, label] of parts) {
  console.log(`  ${fmtMb(mb(path.join(staging, rel))).padStart(9)}  ${label}  (${rel})`);
}
console.log(`  ${fmtMb(mb(staging)).padStart(9)}  解压后合计`);
console.log("\n首跑说明：exe 同目录可放 .env；缺 claude 运行时会弹安装向导按需下载。");
