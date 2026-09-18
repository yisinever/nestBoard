/**
 * 脑图序列化（`06 §3`）：内存模型 → 磁盘文本。
 *
 * ★ 与白板 `io/BoardRepository` 里的 `serializeBoard` 同一条：**2 空格缩进、人类可读、
 *   git diff 友好**。缩进值直接复用 `BOARD_JSON_INDENT` —— 同一个库里的两种 JSON
 *   没有任何理由用两种排版。
 * ★ 放在 `mind/io/` 而不是 `model/`：**写盘格式是 io 的关切**，
 *   `model/` 只管"内存里这份对象合不合法"（与白板的分层一致）。
 * ★ 纯函数：不 import `obsidian`、不碰 DOM。所以它能被单测钉住
 *   —— 而且"写出去再读回来必须一模一样"这条**往返纪律**正需要它才好测。
 */

import { BOARD_JSON_INDENT } from '../../constants';
import type { MindFile } from '../model/schema';

/**
 * 序列化。
 *
 * ★ 末尾**补一个换行**：文本文件以换行结尾是编辑器与 git 的共同约定，
 *   少这一行会让最后一次 diff 出现"文件末尾无换行"这种与内容无关的噪声。
 * ★ 可选键缺席就**不写**（`JSON.stringify` 天然如此）：这是 `06 §3` 纪律 2
 *   （读一遍写回去逐字节不变）能在序列化这一侧自动成立的原因。
 */
export function serializeMindFile(file: MindFile): string {
  return `${JSON.stringify(file, null, BOARD_JSON_INDENT)}\n`;
}
