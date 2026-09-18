/**
 * 提升为笔记（T1.47）—— `F1.10`，把内联便签卡"毕业"成 Vault 里的真实 `.md`。
 *
 * 为什么需要它：便签卡的内容存在 `.nboard` 里，**只有打开白板才看得见** ——
 * 搜不到、链不到、反向链接面板里没有它。用户想"把这张便签变成正经笔记"时，
 * 正确的动作不是新建文件再复制粘贴，而是原地升级：
 * **几何、层级、颜色、强调条全部不动，只把 `note` 换成指向新文件的 `noteRef`**。
 *
 * 拆解：
 * - 纯函数（`noteNameFrom` / `promotedCard` / `boardFolderOf`）：可 node 单测。
 * - `NotePromoter`：只管"找个不冲突的路径 + 写盘"，依赖窄接口 `VaultSink`。
 *   模型层的替换由 `BoardView` 在同一次 commit 里做（这样撤销是一步，
 *   而不是"文件建好了但卡没换"的中间态）。
 *
 * ★ 写文件与改模型**不可能原子**（写盘是异步的，模型提交是同步的）。
 *   这里的选择：先写盘成功后**再**改模型。代价是极端情况下（写成功但随后
 *   白板保存失败）会多出一个孤立文件 —— 比"模型里指向一个不存在的文件"（断链）
 *   轻得多，因为孤立文件用户能看见也能删，断链只会让人困惑。
 */

import type { CardOfType, NoteRefContent } from '../model/schema';

/** Vault 写入口的窄接口（生产实现：`io/vaultIO.ts`） */
export interface VaultSink {
  exists(path: string): Promise<boolean>;
  create(path: string, content: string): Promise<void>;
}

/** 文件名里不能出现的字符（对齐 Obsidian / 各操作系统的并集） */
const ILLEGAL_IN_NAME = /[\\/:*?"<>|#^[\]]/g;

/** 标题为空时，退回用正文首行当文件名 */
export function firstLineOf(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.replace(/^#{1,6}\s*/, '').trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/**
 * 标题 → 文件名。
 *
 * 不合法的字符换成空格而不是直接删：`a/b` 删成 `ab` 会让两个不同标题
 * 撞成同一个文件名，而换空格后至少还能区分（`a b`）。长度截断是防呆 ——
 * 有些系统对单段文件名有 255 字节上限。
 */
export function noteNameFrom(title: string): string {
  const cleaned = title.replace(ILLEGAL_IN_NAME, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '未命名';
  return cleaned.slice(0, 80);
}

/** `/folder/白板.nboard` → `/folder`；根目录白板 → `''` */
export function boardFolderOf(boardPath: string): string {
  const slash = boardPath.lastIndexOf('/');
  return slash === -1 ? '' : boardPath.slice(0, slash);
}

/**
 * 把内联便签卡"平移"成引用卡：身份字段全部保留，只换 `type` 与 `content`。
 *
 * 用一个对象展开而不是逐字段拷：将来 `CardBase` 加字段时这里**自动跟上**，
 * 而逐字段拷贝会静默丢掉新字段（这类 bug 要等到"用户说颜色没了"才被发现）。
 */
export function promotedCard(
  card: CardOfType<'note'>,
  path: string,
  subpath: string | null = null,
): CardOfType<'noteRef'> {
  const content: NoteRefContent = { path, subpath, mode: 'summary', excerptLines: 6 };
  return { ...card, type: 'noteRef', content };
}

export class NotePromoter {
  constructor(private readonly sink: VaultSink) {}

  /**
   * 把一段正文写成一个新的 `.md`。
   *
   * @param folder Vault 相对目录（`''` = 根目录）
   * @returns 新建文件的 Vault 相对路径
   */
  async writeBacked(title: string, markdown: string, folder: string): Promise<string> {
    const name = noteNameFrom(title.length > 0 ? title : firstLineOf(markdown));
    const target = await this.resolveFreeName(folder, name);
    await this.sink.create(target, markdown);
    return target;
  }

  /** 同名文件已存在时顺延为 `名字 2`、`名字 3`… */
  private async resolveFreeName(folder: string, name: string): Promise<string> {
    const prefix = folder.length > 0 ? `${folder.replace(/\/+$/, '')}/` : '';
    let target = `${prefix}${name}.md`;
    let index = 2;
    // 上限纯粹是防御死循环（`exists` 永远返回 true 的假实现）：
    // 真到 1000 个同名文件时，用户的问题已经不是文件名了
    while (index < 1000 && (await this.sink.exists(target))) {
      target = `${prefix}${name} ${index}.md`;
      index += 1;
    }
    return target;
  }
}
