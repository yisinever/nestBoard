/**
 * 把导出结果写进 Vault（T1.72 / `F9-01`）。
 *
 * ★ 覆盖策略：**只覆盖自己上次导出的那个文件**。
 *
 * 导出是"再生成"而不是"创作"：用户改两笔再导一次，如果每次都顺延成
 * `白板 2.md`、`白板 3.md`，一上午就能攒出十几个几乎一样的文件，
 * 反过来把 Vault 弄乱 —— 那比"没导出"更烦人。
 *
 * 认领方式是在文件末尾留一行 HTML 注释指纹（{@link exportMarker}）：
 * **只有目标文件带着同一块白板的指纹时**才原地覆盖，别的东西一律不碰
 * （同名笔记是用户的，不是我们的）。指纹是 HTML 注释，在阅读视图里不显示。
 */

import { boardFolderOf } from '../integration/NotePromoter';

/** Vault 写入口的窄接口（生产实现：`io/vaultIO.ts`） */
export interface MarkdownExportSink {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  process(path: string, transform: (raw: string) => string): Promise<void>;
}

/**
 * 导出物的指纹行。
 *
 * 带上 `source` 而不是一个固定的标记：同一块白板重复导出应覆盖，而**两块白板
 * 导出成同名文件时不能互相覆盖**（`Boards/A.md` 与 `Boards/A 2.md` 都导出成 `A.md`
 * 是可能的）。指纹区分到"哪块板子"，才算真的安全。
 */
export function exportMarker(sourcePath: string): string {
  return `<!-- nestboard:export source="${sourcePath}" -->`;
}

export interface MarkdownExportTarget {
  /** Vault 相对目录（`''` = 根目录） */
  folder: string;
  /** 不含扩展名的文件名（调用方已做过非法字符清理） */
  name: string;
  /** 来源白板路径，写进指纹 */
  sourcePath: string;
}

export class MarkdownExporter {
  constructor(private readonly sink: MarkdownExportSink) {}

  /**
   * 写入导出结果并返回实际落盘路径。
   *
   * 指纹统一由这里补在末尾，而不是让调用方自己拼 —— 调用方拼错（漏一行空行、
   * 忘了换行）会让"下次能覆盖"这个前提静默失效，而且要等到用户发现
   * 攒了一堆文件时才暴露。
   */
  async export(markdown: string, target: MarkdownExportTarget): Promise<string> {
    const marker = exportMarker(target.sourcePath);
    const content = `${markdown.trimEnd()}\n\n${marker}\n`;
    const path = await this.resolveTarget(target.folder, target.name, marker);

    if (await this.sink.exists(path)) {
      // `process` 是原子的读改写（03 §3.2 W1）：中途失败不会留下半个文件
      await this.sink.process(path, () => content);
    } else {
      await this.sink.create(path, content);
    }
    return path;
  }

  /** 顺延找名字：已存在的文件**只有带着同一个指纹**才能被认领（`名字` → `名字 2` → …） */
  private async resolveTarget(folder: string, name: string, marker: string): Promise<string> {
    const prefix = folder.length > 0 ? `${folder.replace(/\/+$/, '')}/` : '';
    let target = `${prefix}${name}.md`;
    let index = 2;
    // 上限纯粹是防御死循环（`exists` 永远返回 true 的假实现）
    while (index < 1000 && (await this.isForeign(target, marker))) {
      target = `${prefix}${name} ${index}.md`;
      index += 1;
    }
    return target;
  }

  /** 这个路径被"别人的东西"占着吗（不存在 = 没占；指纹是自己 = 没占） */
  private async isForeign(path: string, marker: string): Promise<boolean> {
    if (!(await this.sink.exists(path))) return false;
    try {
      const existing = await this.sink.read(path);
      return !existing.includes(marker);
    } catch {
      // 读不出来（权限 / 编码异常）时按"被占用"处理：
      // 宁可多出一个新文件，也不要覆盖一份我们看不透的内容
      return true;
    }
  }
}

/** `/folder/白板.nboard` → `白板`（导出文件名兜底用） */
export function boardNameOf(boardPath: string): string {
  const folder = boardFolderOf(boardPath);
  const base = folder.length > 0 ? boardPath.slice(folder.length + 1) : boardPath;
  return base.replace(/\.nboard$/, '');
}
