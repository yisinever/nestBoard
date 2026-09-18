/**
 * 「把一段文本读成白板」的两个小工具（T4.03 / T4.04 共用）。
 *
 * 为什么不再走 `BoardRepository.parseBoardText`：那条路是**会话级**的 ——
 * 它要建 session、维护 `baseline`、在失败时把会话推进保护态。而这里的两处调用方
 * 都只想要一份**临时**的模型，读完就丢：
 *
 *   - 删除前打快照：只需要 `meta.id` 与 `revision`（`readBoardManifest`）；
 *   - 冲突副本对比：需要完整模型，但绝不进 `repository` 的 session 表
 *     —— 冲突副本是一份"待处置的陌生文件"，把它变成常驻会话会让它跟着参与
 *     自动保存 / 冲突检测，那是把问题放大而不是解决。
 *
 * 模块约束：**不 import `obsidian`**，只依赖 `model/`，可在 node 下单测。
 */

import type { BoardFile } from '../model/schema';
import { looksLikeBoardFile, normalizeBoardFile, safeJsonParse } from '../model/validate';
import { migrateBoardFile } from './migrate';

/**
 * 文本 → 白板模型。任何一步失败（JSON 坏了 / 不是白板 / 版本迁移无路）都返回 `null`。
 *
 * ★ 刻意**不回传失败原因**：这两个调用方都不打算"修复"它 ——
 *   删不掉的文件有的是别的办法（`vault.trash` 照样能删），
 *   看不懂的副本也照样能在对比视图里显示为"无法解析"。
 *
 * ★ 信封判定必须放在 `migrateBoardFile` **之前**：迁移会给任何对象盖上当前
 *   `spec` / `version`，盖完之后"像不像白板"就再也问不出来了 ——
 *   那样 `{"hello":"world"}` 会显示成"两块空板完全一致"，而事实是"读不出白板内容"。
 */
export function parseBoardFile(raw: string): BoardFile | null {
  const json = safeJsonParse(raw);
  if (!json.ok) return null;
  if (!looksLikeBoardFile(json.value)) return null;

  const migrated = migrateBoardFile(json.value);
  if (!migrated.ok) return null;

  return normalizeBoardFile(migrated.value)?.board ?? null;
}

/**
 * 只抽 `meta.id` 与 `revision`（打快照时需要给 `SnapshotStore` 定位目录）。
 *
 * 比 `parseBoardFile` 便宜得多，而且**容忍内容残缺**：同步工具写坏一张卡、或用户手写
 * 了一份缺字段的文件，完整校验必然失败/修修补补，但 `id` / `revision` 往往还在 ——
 * 那两个字段在，快照就能落到正确的目录里。
 * （JSON 语法本身就是坏的则仍然返回 `null`，那种连"是什么"都读不出来。）
 */
export function readBoardManifest(raw: string): { id: string; revision: number } | null {
  const json = safeJsonParse(raw);
  if (!json.ok) return null;

  const value = json.value;
  if (typeof value !== 'object' || value === null) return null;

  const record = value as { revision?: unknown; meta?: unknown };
  const meta = record.meta;
  if (typeof meta !== 'object' || meta === null) return null;

  const id = (meta as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) return null;

  return { id, revision: typeof record.revision === 'number' ? record.revision : 0 };
}
