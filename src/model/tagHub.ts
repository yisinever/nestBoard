/**
 * **标签枢纽笔记**（`F1` ②）—— 让白板里的标签在 Obsidian 侧有一个"落脚点"。
 *
 * ## 它解决什么
 *
 * `metadataCache` 只索引 `.md`：白板便签里写的 `#纪要` 对 Obsidian 是不存在的。
 * 索引笔记（`model/indexNote.ts`）已经把标签写进 frontmatter，于是 `tag:#纪要`
 * 查询与标签面板**已经能命中那块白板** —— 但点进标签面板看到的是"一列索引笔记"，
 * 没有任何一页能回答"这个标签在我库里都有哪些板用过"。
 *
 * 枢纽笔记就是那一页：**每个标签一份 md**，正文里带上 `#标签` 本身 + 用到它的白板清单
 * （指向各自的索引笔记）。它是库内的普通 Markdown，所以标签面板、全局搜索、反链、
 * Dataview 全都原生生效 —— 与索引笔记同一套"借 md 做马甲"的思路。
 *
 * ## 三条硬规矩（与索引笔记逐条对齐）
 *
 * ① **只在索引笔记开着时生成**：两者是同一件事的两半（"白板进 md 体系"），
 *    用户关掉索引笔记却冒出一堆标签笔记，等于替他做了一个可见的改变；
 * ② **只写自己生成的文件**（`TAG_HUB_MARKER` 是唯一的认领依据）；
 * ③ **可再生的纯函数**：同样的输入给同样的文本（`renderTagHubNote` 里不许出现
 *    `new Date()`），否则桥那边"没变就不写盘"的判断会永远失效。
 *
 * 模块约束：纯逻辑、**不 import `obsidian`**，可直接在 node 下单测。
 */

import { t } from '../util/i18n';
import { normalizeIndexFolder } from './indexNote';

/**
 * 生成物标记（与 `INDEX_NOTE_MARKER` 同一条纪律：落笔前先认它）。
 *
 * ★ 与索引笔记**用两个不同的标记**：两者的清理路径不同（一个按白板清、一个按标签清），
 *   认错标记 = 把对方的文件当自己的删掉。
 */
export const TAG_HUB_MARKER = '<!-- nestboard:tag-hub -->';

/** frontmatter 里"这份笔记是哪个标签的枢纽"那一栏（同 `INDEX_NOTE_BOARD_KEY` 的用法：给清理侧当线索） */
export const TAG_HUB_KEY = 'nestboard-tag';

/**
 * 枢纽笔记的固定子目录名。
 *
 * ★ 单独一层 `_tags/` 而不是与索引笔记平铺：索引笔记**镜像白板路径**（`Boards/项目/子板.md`），
 *   平铺进来就可能与镜像出来的目录同名相撞。一个下划线开头的固定目录是"不可能撞"的写法。
 */
export const TAG_HUB_FOLDER = '_tags';

/** 一个用到了这个标签的白板 */
export interface TagHubBoard {
  /** 对应的**索引笔记**路径（库内相对）—— 清单里链接的是它，不是 `.nboard` */
  notePath: string;
  /** 白板标题（索引笔记会自己兜底成文件名，这里给算好的那个） */
  title: string;
  /** 白板路径（库内相对）；只用来排序与兜底标题 */
  boardPath: string;
}

/** `renderTagHubNote` 的输入 */
export interface TagHubInput {
  /** 标签（不带 `#`） */
  tag: string;
  boards: readonly TagHubBoard[];
}

/** 枢纽笔记所在的目录（索引目录下的 `_tags`） */
export function tagHubFolderOf(folder: string): string {
  const dir = normalizeIndexFolder(folder);
  return dir.length > 0 ? `${dir}/${TAG_HUB_FOLDER}` : TAG_HUB_FOLDER;
}

/**
 * 一个标签对应哪个文件。
 *
 * ★ `#纪要` → `<索引目录>/_tags/纪要.md`。
 * ★ 文件名里的路径分隔符与非法字符换成 `-`：标签允许写 `项目/周报`（Obsidian 的嵌套标签
 *   就是这么写的），而 `/` 在文件名里是目录分隔符 —— 不换的话会在 `_tags/` 下面
 *   长出一层目录来（清理时按平铺扫，那一层就漏掉了）。
 * ★ 代价是 `项目/周报` 与 `项目-周报` 撞同一个文件。这是**知情取舍**：两者在
 *   Obsidian 的标签体系里本来就是两个标签，但让它们在磁盘上共用一个枢纽页，
 *   比"每加一层嵌套就在索引目录里多一层目录"要好得多（后者的清理与迁移都得跟着递归）。
 */
export function tagHubPathOf(tag: string, folder: string): string {
  return `${tagHubFolderOf(folder)}/${tagHubFileNameOf(tag)}.md`;
}

/** 标签 → 文件名（去 `#`、非法字符换 `-`、压缩连续 `-`） */
export function tagHubFileNameOf(tag: string): string {
  const clean = tag
    .trim()
    .replace(/^#+/, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean.length > 0 ? clean : 'untagged';
}

/** 这份文本是不是我们生成的标签枢纽笔记 */
export function isTagHubNote(text: string): boolean {
  return text.includes(TAG_HUB_MARKER);
}

/**
 * 渲染一份标签枢纽笔记。
 *
 * ★ 纯函数：输出只取决于入参（外加界面语言）—— 与 `renderIndexNote` 同一条纪律，
 *   桥靠"渲染出来一样就跳过写盘"来避免每次自动保存都写一遍。
 * ★ 清单按 `boardPath` 排序（调用方给什么顺序都不影响结果），去重按 `notePath`。
 */
export function renderTagHubNote(input: TagHubInput): string {
  const tag = input.tag.trim().replace(/^#+/, '');
  const lines: string[] = [];

  lines.push('---');
  lines.push(`${TAG_HUB_KEY}: ${yamlString(tag)}`);
  lines.push('tags:');
  lines.push(`  - ${yamlString(tag)}`);
  lines.push('---');
  lines.push('');

  lines.push(TAG_HUB_MARKER);
  lines.push(`<!-- ${t('tagHub.warning')} -->`);
  lines.push('');
  // 标题里带 `#标签`：这一行本身就是一次"标签出现在正文里"，标签面板与搜索都能认
  lines.push(`# #${tag}`);
  lines.push('');
  lines.push(`## ${t('tagHub.section.boards')}`);
  lines.push('');

  const boards = sortBoards(input.boards);
  if (boards.length === 0) {
    lines.push(t('tagHub.empty'));
  } else {
    for (const board of boards) lines.push(`- ${wikiLinkOf(board)}`);
  }

  return `${lines.join('\n')}\n`;
}

/** 按白板路径去重（同一块板只列一次）并排序 */
function sortBoards(boards: readonly TagHubBoard[]): TagHubBoard[] {
  const byNote = new Map<string, TagHubBoard>();
  for (const board of boards) {
    if (!byNote.has(board.notePath)) byNote.set(board.notePath, board);
  }
  return [...byNote.values()].sort((a, b) => a.boardPath.localeCompare(b.boardPath));
}

/**
 * 清单里的一条 → wikilink。
 *
 * ★ 与索引笔记同一条：目标用**完整路径**（枢纽笔记住在 `_tags/` 下，裸名在那里
 *   可能指到别的同名文件），别名只在"与路径不是一回事"时才写。
 */
function wikiLinkOf(board: TagHubBoard): string {
  const path = board.notePath.endsWith('.md')
    ? board.notePath.slice(0, -'.md'.length)
    : board.notePath;
  const alias = board.title.trim();
  return alias.length > 0 && alias !== path ? `[[${path}|${alias}]]` : `[[${path}]]`;
}

/** YAML 标量：一律双引号 + 转义（与 `indexNote.yamlString` 同一套，逐字照搬） */
function yamlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}
