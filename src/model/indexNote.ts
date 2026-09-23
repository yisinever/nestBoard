/**
 * 索引笔记（T7.01 / `F10-09` + `F7-09`）—— 把白板里**看不见的东西**变成库内的真实文件。
 *
 * ## 它解决什么
 *
 * `.nboard` 是自定义扩展名，Obsidian 的 `metadataCache` 只解析 `.md`。于是两件事做不到：
 *
 * 1. **内联便签里的 `[[链接]]` 进不了全局图谱**（`F10-08` 用插件自己的 `LinkIndex`
 *    补上了"插件内可见"，但图谱里仍然没有这条边）；
 * 2. **白板级的元信息**（标题 / 标签 / 卡片数）没有任何承载物，Dataview、Bases
 *    这类"扫 Markdown 的查询工具"看不见它（`F7-09` 的原话是"白板级 frontmatter"，
 *    而 JSON 里根本没有 frontmatter 这回事，见 `03 §6.4` 的回填修正）。
 *
 * 索引笔记就是那层**承载物**：每块白板生成一个 `.md`，frontmatter 写白板元信息、
 * 正文写内联卡里的链接。它在库内是普通 Markdown，所以图谱、反链、搜索、Dataview
 * 全都原生生效 —— 我们一个 Obsidian 内部 API 都不用碰。
 *
 * ## 三条硬规矩
 *
 * ① **默认关闭**，且这是产品决定而非技术保守：开启的代价是"库里多出一堆文件"
 *    （用户会在大纲 / 搜索 / 图谱里看见它们），收益是"内联卡进图谱"。这笔账该由
 *    用户自己算，插件替他打开就是替他做了一个可见的改变。
 *
 * ② **只写自己生成的文件**。每个生成物第一行都带 `INDEX_NOTE_MARKER`，落笔前先认
 *    这个标记（见 `integration/IndexNoteBridge.ts` 的 `syncBoard`）。用户自建的
 *    `说明.md` 正好占着同一个路径时，那些内容一个字都不会被覆盖 —— 宁可跳过。
 *
 * ③ **生成物是可再生的**。删掉全部索引笔记，下次同步会一模一样地长回来。
 *    所以这里的渲染必须是**纯函数**：同一个输入永远得到同一份文本，
 *    否则"内容没变就别写盘"这条最小化写盘的判断（bridge 里的 `lastWritten`）
 *    会永远判为"变了"，把每次自动保存都变成一次写盘。
 *
 * ## 为什么解析不出的链接不写成 wikilink
 *
 * `[[不存在的笔记]]` 直接写进 Markdown，Obsidian 会在图谱里给它造一个幽灵节点。
 * 内联卡里写错一个名字的成本，不该是"用户的图谱里多出一个假笔记"——那类断链
 * 已经有专门的入口（断链总览 `F8-07`）。这里把它们**如实列出来**（行内代码，不是
 * 链接）：用户看得见"有这么一个东西没对上"，但图谱保持干净。
 *
 * 模块约束：纯逻辑、**不 import `obsidian`**，可直接在 node 下单测。
 */

import { t } from '../util/i18n';

/**
 * 生成物标记。
 *
 * ★ 它的**唯一**职责是回答"这个文件是不是我们写的"。因此在覆盖任何已存在的文件
 *   之前必须先看到它 —— 这是"绝不覆盖用户文件"这条承诺唯一的执行点。
 */
export const INDEX_NOTE_MARKER = '<!-- nestboard:index-note -->';

/**
 * 每份索引笔记都会带的标签。
 *
 * ★ 带它是为了让用户有一个**稳定的筛选入口**（`tag:#nestboard`）—— 索引笔记混在
 *   自己的笔记里时，用户总得有个办法一次把它们全捞出来或全滤掉。这也是 `F7-09`
 *   说的"可被 Dataview / Bases 查询"里最基础的那一条（不然查询得按目录写死）。
 */
export const INDEX_NOTE_TAG = 'nestboard';

/**
 * frontmatter 里"这份笔记属于哪块白板"的那一栏。
 *
 * ★ 导出它是为了让**清理**那一侧不必去读文件内容：`IndexNoteBridge.listIndexNotes`
 *   的生产实现直接问 `metadataCache` 的 frontmatter —— 它只认这一个键，
 *   就能在"一个文件都不读"的前提下把索引笔记从整个库里筛出来。
 *   所以这一栏的**名字**是插件内部的一个约定，改它等于同时改两处（这里与查询侧）。
 */
export const INDEX_NOTE_BOARD_KEY = 'nestboard-board';

/** 一条内联卡出链（来自 `LinkIndex`，这里只留渲染需要的两列） */
export interface IndexNoteLink {
  /** 用户当初写的原始目标文本（`[[这个]]`） */
  target: string;
  /** 解析出的库内路径；`null` = 没对上任何文件 */
  resolved: string | null;
}

/** 渲染一份索引笔记所需的全部输入 */
export interface IndexNoteInput {
  /** 白板路径（库内相对） */
  boardPath: string;
  title: string;
  tags: readonly string[];
  /**
   * **卡内**标签（`F1`）：白板里的 md（便签卡正文 / 标题 / 备注…）写下的 `#标签`。
   *
   * ★ 与 {@link tags}（白板级 `meta.tags`）并进同一份 frontmatter，而不是分两栏：
   *   `tag:#纪要` 查询在 Obsidian 侧只认一条 `tags:`，分栏的话用户得记住
   *   "有的板在 A 栏、有的在 B 栏"。合并之后口径是一句话：
   *   **这块板上任何地方写过这个标签，`tag:` 就命中它**。
   * ★ 顺序稳定：白板标签在前、卡内标签在后（`renderIndexNote` 里按给进来的顺序去重）——
   *   同一份输入永远得到同一份文本，`IndexNoteBridge` 的"没变就不写盘"靠的就是它。
   * ★ 可选：老调用方（测试、没接 `LinkIndex` 的宿主）不传 ⇒ 只有白板级标签，
   *   与 `F1` 之前一字不差。
   */
  cardTags?: readonly string[];
  /**
   * 卡片数；**`null` = 不知道**，此时整栏都不写。
   *
   * ★ 为什么允许"不知道"：卡片数是**懒加载**的（`R4`：启动时读全库白板的 JSON 会把
   *   插件卡住，所以 `BoardRegistry` 只读 `meta`，卡片数要显式 `ensureCardCount`）。
   *   索引笔记是**次要产物**，不该成为"于是每块板都被读一遍"的理由。
   *   宁可这一栏缺席（Dataview 查询里少一列），也不要写一个假的 `0` ——
   *   一份写着"0 张卡片"的索引笔记会让用户以为白板空了。
   *   白板一旦被打开或保存过，数字就是准确的了。
   */
  cardCount: number | null;
  /** 白板的 `meta.updatedAt`（ISO 串）；空串 = 不写这一句 */
  updatedAt: string;
  links: readonly IndexNoteLink[];
  /** `obsidian://nestboard?file=…`；空串 = 不写这一行 */
  boardUri: string;
}

/** 目录收敛：去掉首尾斜杠与空白，`\` 换成 `/`（与设置面板同一套规则） */
export function normalizeIndexFolder(folder: string): string {
  return folder
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * 这块白板的索引笔记该落在哪儿。
 *
 * ★ 映射规则：`<索引目录>/<白板在库内的完整相对路径去掉扩展名>.md`。
 *   即 `Boards/项目/子板.nboard` → `Boards/_index/Boards/项目/子板.md`。
 *
 *   为什么**镜像整条路径**而不是拍平到一层：一拍平，`A/周报.nboard` 与
 *   `B/周报.nboard` 就撞在同一个文件名上。要给它们分出高下，只能看"另一块板
 *   存不存在 / 谁先来"——那会让**同一块白板的索引笔记路径**依赖于库里别的东西，
 *   而 `syncBoard` 必须能在任何时刻只凭这一块板算出"我的笔记在哪"（否则移动、
 *   改名、目录迁移全都要靠一张随时会过期的映射表）。
 *   冗余一层目录换来的是：**双向可推导**（见 `indexNoteBoardOf`），且永不撞名。
 *
 * ★ 空目录（`''`）= 直接放库根，与 `newBoardFolder` 的空串语义一致。
 */
export function indexNotePathOf(boardPath: string, folder: string): string {
  const stem = stripBoardExtension(boardPath.replace(/^\/+/, ''));
  const dir = normalizeIndexFolder(folder);
  return dir.length > 0 ? `${dir}/${stem}.md` : `${stem}.md`;
}

/**
 * `indexNotePathOf` 的反函数：这份索引笔记属于哪块白板。
 *
 * ★ 清理（`IndexNoteBridge.cleanup`）靠它工作：扫一遍索引目录，**算**出每个文件
 *   对应的白板，再看那块板还在不在。比"读 frontmatter 里的 `nestboard-board`"
 *   少一次解析，也就少一处会出错的地方 —— frontmatter 是给人和 Dataview 看的，
 *   不是插件自己的记账本。
 *
 * 路径不在索引目录之下、或不是 `.md` 时返回 `null`（那不是我们的记账范围）。
 */
export function indexNoteBoardOf(notePath: string, folder: string): string | null {
  const path = notePath.replace(/^\/+/, '');
  const dir = normalizeIndexFolder(folder);
  const relative = dir.length > 0 ? stripPrefix(path, `${dir}/`) : path;
  if (relative === null) return null;
  if (!relative.endsWith('.md')) return null;
  const stem = relative.slice(0, -'.md'.length);
  if (stem.length === 0) return null;
  return `${stem}.nboard`;
}

/** 这个文件是不是插件生成的索引笔记 */
export function isIndexNote(text: string): boolean {
  return text.includes(INDEX_NOTE_MARKER);
}

/**
 * 渲染一份索引笔记。
 *
 * ★ 纯函数，且**输出只取决于入参**（外加当前界面语言）：同样的输入必须得到逐字节
 *   相同的文本。`IndexNoteBridge` 正是靠"渲染结果与上次写入的一样就跳过写盘"来
 *   避免把每次自动保存都变成一次文件写入 —— 这里随手加一个 `new Date()` 就会
 *   让那条判断永远失效。
 */
export function renderIndexNote(input: IndexNoteInput): string {
  const title =
    input.title.trim().length > 0
      ? input.title.trim()
      : stripBoardExtension(baseNameOf(input.boardPath));
  const lines: string[] = [];

  lines.push('---');
  lines.push(`${INDEX_NOTE_BOARD_KEY}: ${yamlString(input.boardPath)}`);
  lines.push(`nestboard-title: ${yamlString(title)}`);
  if (input.cardCount !== null) {
    lines.push(`nestboard-cards: ${Math.max(0, Math.trunc(input.cardCount))}`);
  }
  if (input.updatedAt.length > 0) {
    lines.push(`nestboard-updated: ${yamlString(input.updatedAt)}`);
  }
  lines.push('tags:');
  // 白板标签 + **卡内标签**（`F1`）并成一份：`tag:#纪要` 只要"板上任何地方写过"就命中
  for (const tag of tagsOf([...input.tags, ...(input.cardTags ?? [])])) {
    lines.push(`  - ${yamlString(tag)}`);
  }
  lines.push('---');
  lines.push('');

  lines.push(INDEX_NOTE_MARKER);
  lines.push(`<!-- ${t('indexNote.warning', { path: input.boardPath })} -->`);
  lines.push('');
  lines.push(`# ${title}`);
  const summary = summaryLineOf(input);
  if (summary !== null) {
    lines.push('');
    lines.push(summary);
  }
  if (input.boardUri.length > 0) {
    lines.push('');
    lines.push(`[${t('indexNote.openBoard')}](${input.boardUri})`);
  }

  const resolved = resolvedLinksOf(input.links);
  lines.push('');
  lines.push(`## ${t('indexNote.section.links')}`);
  lines.push('');
  if (resolved.length === 0) {
    lines.push(t('indexNote.noLinks'));
  } else {
    for (const link of resolved) lines.push(`- ${wikiLinkOf(link)}`);
  }

  const unresolved = unresolvedLinksOf(input.links);
  if (unresolved.length > 0) {
    lines.push('');
    lines.push(`## ${t('indexNote.section.unresolved')}`);
    lines.push('');
    lines.push(t('indexNote.unresolvedHint'));
    lines.push('');
    for (const target of unresolved) lines.push(`- ${inlineCodeOf(target)}`);
  }

  // 结尾留一个换行：文件末尾没有换行符时，很多工具（含 `git diff`）会抱怨
  return `${lines.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────
// 内部
// ─────────────────────────────────────────────────────────────

/**
 * 正文里那一句"这块白板有多大、多新"。
 *
 * ★ 三项元信息（卡片数 / 更新时间）各有各的"可能没有"（见 `IndexNoteInput` 的
 *   `cardCount`），于是有四种组合。这里只写三种 —— 两样都不知道时**整句不写**：
 *   正文里留一句"这块白板还没有元信息"是给用户看噪音，而 frontmatter 已经在
 *   那里如实交代了"这两栏都没有"。
 */
function summaryLineOf(input: IndexNoteInput): string | null {
  const cards = input.cardCount;
  const updated = input.updatedAt;

  if (cards !== null && updated.length > 0) {
    return t('indexNote.summary', { cards, updated });
  }
  if (cards !== null) return t('indexNote.summaryNoDate', { cards });
  if (updated.length > 0) return t('indexNote.summaryNoCards', { updated });
  return null;
}

/** 去重 + 去空 + 保证带上 `nestboard` 标记标签，且顺序稳定 */
function tagsOf(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of [INDEX_NOTE_TAG, ...tags]) {
    const clean = tag.trim().replace(/^#/, '');
    if (clean.length === 0 || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

/** 按解析出的路径去重、排序后的出链 */
function resolvedLinksOf(links: readonly IndexNoteLink[]): IndexNoteLink[] {
  const byPath = new Map<string, IndexNoteLink>();
  for (const link of links) {
    if (link.resolved === null) continue;
    // 两个不同的写法可能解析到同一个文件（`[[别名]]` 与 `[[目录/别名]]`）：
    // 保留第一个（调用方已按稳定顺序给我），图谱里只需要一条边
    if (!byPath.has(link.resolved)) byPath.set(link.resolved, link);
  }
  return [...byPath.values()].sort((a, b) => (a.resolved ?? '').localeCompare(b.resolved ?? ''));
}

/** 没对上文件的出链（按目标文本去重、排序） */
function unresolvedLinksOf(links: readonly IndexNoteLink[]): string[] {
  const seen = new Set<string>();
  for (const link of links) {
    if (link.resolved === null && link.target.length > 0) seen.add(link.target);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * 一条出链 → Markdown 里的 wikilink。
 *
 * ★ 链接目标用**解析出的完整路径**而不是用户写的那三个字：索引笔记住在
 *   `Boards/_index/…`，一个裸名 `[[周报]]` 在那里可能指向另一个同名文件
 *   （Obsidian 按"最短唯一名"解析，而索引笔记旁边的目录结构跟原白板不一样）。
 *   用完整路径写，指向哪个文件是确定的。
 *
 * ★ 只在"别名与路径不是一回事"时才写 `|别名`：`[[Notes/周报|周报]]` 读起来清爽，
 *   而 `[[周报|周报]]` 只是噪音。
 */
function wikiLinkOf(link: IndexNoteLink): string {
  const path = stripMdExtension(link.resolved ?? '');
  const alias = link.target.trim();
  return alias.length > 0 && alias !== path ? `[[${path}|${alias}]]` : `[[${path}]]`;
}

/** 行内代码；反引号会截断代码段，换成撇号（目标文本里出现反引号本就极罕见） */
function inlineCodeOf(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/**
 * YAML 标量：一律用双引号包起来并转义。
 *
 * ★ 不偷懒"看着不需要引号就不加"：白板标题里出现 `:` `#` `-` `[` 都会让 YAML
 *   解析出别的东西（`title: 周报: 第二期` 直接语法错），而错误的表现是"Dataview
 *   查询结果为空"——用户绝不会想到是标题里那个冒号。统一加引号 + 转义是唯一
 *   不会漏的写法。
 */
function yamlString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}

/** `Boards/A.nboard` → `A`（白板扩展名固定小写，见 `constants.ts` 的 `BOARD_EXT`） */
function stripBoardExtension(path: string): string {
  return path.endsWith('.nboard') ? path.slice(0, -'.nboard'.length) : path;
}

/** 只去掉结尾的 `.md`；中间出现的 `.md` 是目录名的一部分，不能动 */
function stripMdExtension(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -'.md'.length) : path;
}

function baseNameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** `path` 以 `prefix` 开头时返回去掉前缀的部分，否则 `null` */
function stripPrefix(path: string, prefix: string): string | null {
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
