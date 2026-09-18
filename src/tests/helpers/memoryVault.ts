/**
 * 内存版 `VaultIO`：`io/` 集成测试的替身。
 *
 * 关键语义必须与 Obsidian 一致：`process()` 的 transform **抛错时不写入任何内容**
 * —— 这正是 `BoardRepository` 冲突检测赖以成立的原子性保证（03 §3.2 W1）。
 * 如果这里实现成"先写入再抛错"，单测就会变成假的绿灯。
 */

import type { VaultIO, VaultStat } from '../../io/vaultIO';

export class MemoryVaultIO implements VaultIO {
  readonly files = new Map<string, string>();
  /** 二进制产物（导出的 PNG）：与 `files` 并列，`exists` / `list` 都要一并回答 */
  readonly binaries = new Map<string, ArrayBuffer>();
  /** 目录（Obsidian 里目录与文件在同一个索引中，`isFile` 必须能区分） */
  readonly folders = new Set<string>();
  /** 每次真正落盘的路径，用于断言"写了几次 / 有没有写" */
  readonly writeLog: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`白板文件不存在：${path}`);
    return content;
  }

  async process(path: string, transform: (raw: string) => string): Promise<void> {
    const raw = this.files.get(path) ?? '';
    const next = transform(raw); // 抛错 → 直接向上冒泡，下方写入不执行
    this.files.set(path, next);
    this.writeLog.push(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.binaries.get(path);
    // 与 Obsidian 对齐：读不到就抛（打包时"读不到"是要被上层看见的事实，不是空文件）
    if (data === undefined) throw new Error(`文件不存在：${path}`);
    return data;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binaries.has(path);
  }

  isFile(path: string): boolean {
    // 与 Obsidian 对齐：目录也在同一个索引里。内存替身用 `folders` 显式记账，
    // 否则"拖入一个文件夹"这条用例会拿到 `true`（假绿）
    return (this.files.has(path) || this.binaries.has(path)) && !this.folders.has(path);
  }

  async create(path: string, data: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`文件已存在：${path}`);
    this.files.set(path, data);
    this.writeLog.push(path);
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    if (this.files.has(path) || this.binaries.has(path)) {
      throw new Error(`文件已存在：${path}`);
    }
    this.binaries.set(path, data);
    this.writeLog.push(path);
  }

  async stat(path: string): Promise<VaultStat | null> {
    const content = this.files.get(path);
    if (content !== undefined) return { mtime: 0, size: content.length };
    const binary = this.binaries.get(path);
    return binary === undefined ? null : { mtime: 0, size: binary.byteLength };
  }

  async list(extension: string): Promise<string[]> {
    return [...this.files.keys(), ...this.binaries.keys()].filter((path) =>
      path.endsWith(`.${extension}`),
    );
  }

  async listAll(): Promise<string[]> {
    return [...this.files.keys(), ...this.binaries.keys()];
  }

  /** 模拟"外部编辑器 / 别的设备"直接改文件：绕过 `process()`，不触发原子性保护 */
  externalWrite(path: string, content: string): void {
    this.files.set(path, content);
  }
}
