/**
 * 迁移框架（T1.09）。
 *
 * 只做一件事：把**旧版本**的 `.nboard` 平移到当前版本。
 * v1 是当前版本，所以迁移链现在是空的 —— 但框架必须先立起来，
 * 否则第一个破坏性改动就会演变成"边做边改 schema 的迁移地狱"（04 §17 三大坑之一）。
 *
 * 三条约定：
 * 1. `version` **缺失或非法** → 视为当前版本（宽容，让手写/精简文件也能打开）；
 * 2. `version > 当前版本` → **直接失败**，上层进入只读保护态（绝不猜、绝不覆盖）；
 * 3. 迁移链**必须连续**（0→1→2…），断链即失败 —— 宁可开不了，也不能迁错。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM。
 */

import { BOARD_SPEC, BOARD_VERSION } from '../constants';
import { isRecord } from '../model/validate';

export interface MigrationStep {
  /** 迁移完成后的版本号；链上必须连续 */
  to: number;
  /** 写进日志 / CHANGELOG 的一句话说明 */
  description: string;
  migrate(input: Record<string, unknown>): Record<string, unknown>;
}

/**
 * 当前迁移链。
 *
 * * `v1` 为基线；
 * * **`v2` = 白板里可以出现 `minds[]`**（脑图升格为白板对象，`2.2.0`）——
 *   这一步是**恒等**的：`minds` 是可选键，而老的两种脑图卡（`mind` / `mindRef`）
 *   由**读入口**就地转成容器（`model/validate.ts`）。也就是说 v1 的文本不需要被改写，
 *   只是"读出来之后的样子"变了。
 *   ★ 但这一步**必须有**：迁移链是"逐版本一跳"的（下面那个 `while`），少了 `{to: 2}`
 *     所有 v1 文件都会掉进 `no-migration-path` —— 那等于"升级一次，旧板全打不开"。
 *   ★ 它同时让 `future-version` 这道闸门对 v2 生效：老插件（只认识 1）见到 v2 文件会
 *     进只读保护态（`main.ts` 有专门的提示文案）—— 那正是我们要的"明确拒绝"，
 *     而不是"能打开、保存时把脑图静默丢掉"（见 `12 §4.6`）。
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    to: 2,
    description: '白板可以内建脑图（`minds[]`，可选键）：老的两类脑图卡读入时转为容器',
    migrate: (input) => input,
  },
];

export type MigrateFailureReason = 'not-an-object' | 'future-version' | 'no-migration-path';

export type MigrateResult =
  | { ok: true; value: Record<string, unknown>; applied: string[] }
  | { ok: false; reason: MigrateFailureReason; version: number | null };

/**
 * 读取文件里的数据版本号。
 * @returns `null` = 缺失或非法（按"当前版本"处理）
 */
export function readBoardVersion(input: Record<string, unknown>): number | null {
  const raw = input.version;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

/**
 * 把原始对象迁移到当前版本。
 * @param steps 迁移链，默认 `MIGRATIONS`；测试可注入假链以验证框架本身
 */
export function migrateBoardFile(
  input: unknown,
  steps: readonly MigrationStep[] = MIGRATIONS,
): MigrateResult {
  if (!isRecord(input)) return { ok: false, reason: 'not-an-object', version: null };

  let value: Record<string, unknown> = { ...input };
  const declared = readBoardVersion(value);
  let version = declared ?? BOARD_VERSION;

  if (version > BOARD_VERSION) {
    return { ok: false, reason: 'future-version', version };
  }

  const applied: string[] = [];
  while (version < BOARD_VERSION) {
    const step = steps.find((candidate) => candidate.to === version + 1);
    if (!step) return { ok: false, reason: 'no-migration-path', version };
    value = step.migrate(value);
    version = step.to;
    applied.push(`v${version} · ${step.description}`);
  }

  // 规范化信封字段：迁移后的文件永远带当前 spec / version
  value = { ...value, spec: BOARD_SPEC, version: BOARD_VERSION };
  return { ok: true, value, applied };
}
