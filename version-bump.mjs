#!/usr/bin/env node
/**
 * T1.03 · 版本号同步
 *
 * 用法：
 *   npm version patch|minor|major   ← 推荐。npm 先写好 package.json，再调用本脚本
 *   node version-bump.mjs 0.2.0     ← 手动指定版本
 *
 * 保证三处版本号一致：package.json / manifest.json / versions.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PKG = 'package.json';
const MANIFEST = 'manifest.json';
const VERSIONS = 'versions.json';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const pkg = readJson(PKG);
const target = process.env.npm_package_version ?? process.argv[2] ?? pkg.version;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) {
  console.error(`[version-bump] 非法版本号：${target}`);
  process.exit(1);
}

const manifest = readJson(MANIFEST);
const versions = readJson(VERSIONS);
const { minAppVersion } = manifest;

// 1) package.json
if (pkg.version !== target) {
  pkg.version = target;
  writeJson(PKG, pkg);
}

// 2) manifest.json —— 必须与 git tag 完全一致（上架合规第 13 条）
manifest.version = target;
writeJson(MANIFEST, manifest);

// 3) versions.json —— 记录该版本要求的最低 Obsidian 版本，按版本号降序排列便于阅读
versions[target] = minAppVersion;
writeJson(
  VERSIONS,
  Object.fromEntries(
    Object.entries(versions).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true })),
  ),
);

console.log(
  `[version-bump] ${target} → package.json / manifest.json / versions.json（minAppVersion ${minAppVersion}）`,
);
