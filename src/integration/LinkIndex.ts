/**
 * 跨白板链接索引（T5.01 / T5.02 · `F10-08` 内联卡链接索引、`F8-05` 内联卡标签）。
 *
 * ## 为什么非要有这么个东西
 *
 * 内联便签（`note` 卡）的正文存在 `.nboard` 里，而 Obsidian 的 `metadataCache`
 * **只索引 `.md`** —— `.nboard` 对它是一团不认识的 JSON。于是「这张便签正文里写了
 * `[[某笔记]]`」这件事，Obsidian 的反链面板看不见，全局图谱里也没有这条边：
 * 用户站在**笔记那一侧**，永远查不到"哪块白板、哪张卡提起过我"。
 *
 * 这个索引把缺口补上：插件**自己**扫一遍全部 `.nboard`，把内联卡正文里的
 * `[[链接]]` 与 `#标签` 抽出来建表。消费者有三个：侧栏跨白板反链（T5.03）、
 * 引用卡上的反链数（T5.04）、笔记侧显示白板位置（T5.05）。
 *
 * ★ **只读、零写回**：本文件从不修改任何白板；也**绝不试图把这些边塞进 Obsidian 的
 *   全局图谱**。做不到，而且不该做 —— 那是把"插件自己的理解"伪装成"Obsidian 的官方
 *   索引"，用户在图谱里看到的东西会与实际存储脱钩。所以 `F10-08` 要求 UI 上如实标注
 *   「内联卡链接不参与全局图谱」，那条标注是**功能的一部分**，不是免责声明。
 *
 * ## 数据来源与容错
 *
 * 读文件走 `io/boardText.ts` 的 `parseBoardFile`（"读完即丢"的临时模型，不进
 * `repository` 的 session 表）。任何一块板读不出来（JSON 坏了 / 不像白板 / 版本迁移
 * 无路）**只跳过它**，绝不让索引整体失败：反链少一条是小事，因为一份坏文件把侧栏
 * 整片变空白是大事。
 *
 * ## 为什么不卡 UI
 *
 * `F10-08` 要求"分片 + `requestIdleCallback`"。`rebuild()` 把文件清单切成
 * `chunkSize` 一片，片与片之间让出主线程（`scheduleIdle`），且**每片结束就提交并广播**
 * —— 几千块板的库里，侧栏会在扫描途中逐段长出结果，而不是先僵住几秒再一次性弹出。
 *
 * ## 解析不出路径怎么办
 *
 * `[[某笔记]]` 到底指哪个文件，只有 Obsidian 的 `metadataCache` 知道（还要考虑
 * "最短唯一名"、别名、大小写），所以解析由调用方注入 `resolve`。解析失败（含
 * `metadataCache` 尚未就绪的启动早期）**不丢这条边**：退回"按文件名匹配"，
 * 等 `metadataCache.on('resolved')` 之后调 `reresolve()` 再精确一次。
 *
 * 模块约束：**不 import `obsidian`**，可直接在 node 下单测。
 */

import { tagsOfCard } from '../model/tags';
import { parseBoardFile } from '../io/boardText';
import { splitName } from '../util/fileName';
import type { BoardFile } from '../model/schema';

// ─────────────────────────────────────────────────────────────
// 纯文本扫描（内联卡正文 → 链接 / 标签）
// ─────────────────────────────────────────────────────────────

/** 正文摘要的最大长度。反链列表里一句话足够定位，再长会把行挤散 */
export const EXCERPT_MAX = 120;

/** 内联卡正文里的一处 `[[链接]]` */
export interface WikiLinkHit {
  /** 原始目标文本，已剥掉 `|别名` 与 `#小标题` */
  target: string;
  /** 它出现在哪一行（压成单行的摘要），用于显示"是哪句话提到的" */
  excerpt: string;
}

/** 扫描结果：一处内联卡正文里的全部链接与标签 */
export interface InlineScan {
  links: WikiLinkHit[];
  tags: string[];
}

/**
 * `[[目标]]` / `![[目标]]`。`!` 前缀（嵌入）与普通链接**同等对待** ——
 * 嵌入一张笔记同样是"这块板提到了它"。
 */
const WIKILINK_PATTERN = /!?\[\[([^\]\n]+)\]\]/g;

/** 行内代码（成对反引号）：示例里写的 `#标签` 不该被当成真标签 */
const INLINE_CODE_PATTERN = /`[^`]*`/g;

/** 围栏代码块的起始行（``` 或 ~~~，缩进可有可无） */
const FENCE_PATTERN = /^\s*(?:```|~~~)/;

/**
 * `#标签`：`#` 前必须是**行首或空白**，后接**字母 / 数字 / `_` / `-` / `/`**。
 *
 * ★ 两处收窄都是被测试逼出来的，不是想当然：
 *
 *   ① `#` 前限定空白 —— 挡掉两类误报：`[[a#b]]` 里的 `#`（前面是 `a`）与网址里的
 *      `example.com#anchor`。markdown 标题（`# 标题`）则因为"`#` 后紧跟空白"
 *      而自然排除。
 *
 *   ② 字符类必须**枚举合法字符**，不能写成 `[^\s#]+`。后者会把中文标点一起吞掉：
 *      `看 #周报，然后…` 会整整抽出一个叫「周报，然后」的假标签。Obsidian 的标签
 *      字符集本就不含标点，所以这里用 Unicode 属性类——`\p{L}` 覆盖中文，也顺带
 *      让拉丁字母、数字、下划线照常工作。
 */
const TAG_PATTERN = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;

/**
 * 纯数字不算标签（与 Obsidian 同一规则）：`#2024` 是年份，不是标签。
 * 放宽会让每一句带年份的话都冒出一个假标签。
 */
const TAGS_ALL_DIGITS = /^[0-9]+$/;

/**
 * 扫描一段内联卡正文。
 *
 * 围栏代码块整体跳过、行内代码先抹掉，都是为了"用户**展示**语法"与"用户**使用**语法"
 * 能被分开 —— 写一篇讲标签语法的笔记，不该给这块板平白加上几个标签。
 */
export function scanInlineText(md: string): InlineScan {
  const links: WikiLinkHit[] = [];
  const tags: string[] = [];
  const seenTags = new Set<string>();
  let inFence = false;

  for (const rawLine of md.split('\n')) {
    if (FENCE_PATTERN.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = rawLine.replace(INLINE_CODE_PATTERN, '');
    const excerpt = toExcerpt(rawLine);

    WIKILINK_PATTERN.lastIndex = 0;
    for (
      let match = WIKILINK_PATTERN.exec(line);
      match !== null;
      match = WIKILINK_PATTERN.exec(line)
    ) {
      const target = normalizeLinkTarget(match[1] ?? '');
      // 空目标 = `[[#小标题]]` 这种"指向本文档内某处"的写法，没有外部目标
      if (target.length > 0) links.push({ target, excerpt });
    }

    for (const tag of tagsOfLine(line)) {
      if (seenTags.has(tag)) continue;
      seenTags.add(tag);
      tags.push(tag);
    }
  }

  return { links, tags };
}

/**
 * `[[文件夹/笔记#小标题|别名]]` → `文件夹/笔记`。
 *
 * ★ 在第一个 `|` 或 `#` 处切断即可，不必按语法逐步剥离：`#` 与 `^` 都在
 *   `utils/fileName.ts` 的 `ILLEGAL_IN_NAME` 里，文件名**不可能**包含它们，
 *   所以第一个 `#` 一定是"小标题分隔符"而不是文件名的一部分。
 */
export function normalizeLinkTarget(inner: string): string {
  return (inner.split(/[|#]/)[0] ?? '').trim();
}

/** 抽一行里的全部标签（不做去重，去重由调用方按需做） */
export function tagsOfLine(line: string): string[] {
  const found: string[] = [];
  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(line); match !== null; match = TAG_PATTERN.exec(line)) {
    const tag = match[1] ?? '';
    if (tag.length === 0 || TAGS_ALL_DIGITS.test(tag)) continue;
    found.push(tag);
  }
  return found;
}

/** 一行 → 压平的单行摘要（超长截断） */
function toExcerpt(line: string): string {
  const text = line.replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text;
}

// ─────────────────────────────────────────────────────────────
// 索引模型
// ─────────────────────────────────────────────────────────────

/**
 * 索引里的一条出链：**哪个文档**的**哪一处**，提了谁。
 *
 * ★ 字段是**文档中立**的（`06 §7.2`）：白板与脑图各是一份文档，
 *   "文档"这一层与"卡 / 节点"那一层都必须能在同一条记录里表达 ——
 *   否则反链面板要么只认白板，要么得为每种文档类型长一个分支。
 *
 * | 字段 | 白板里是 | 脑图里是 |
 * | --- | --- | --- |
 * | `anchorId` | 卡 id | 节点 id |
 * | `label` | 卡标题（可空） | 节点标题（可空） |
 */
export interface LinkHit {
  /** 源文档的 vault 相对路径 */
  docPath: string;
  docTitle: string;
  /** 命中的那一处（白板 = 卡 id；脑图 = 节点 id） */
  anchorId: string;
  /** 那一处的标题；空串 = 它没有标题（内联卡很常见） */
  label: string;
  /** 提到它的那句话 */
  excerpt: string;
  /** 原始 wikilink 目标文本 */
  target: string;
  /** 解析后的 vault 路径；`null` = 没解析出来（见 `reresolve`） */
  resolved: string | null;
}

/** 某个文档里扫出来的一条出链（`extract` 的产物，还没有解析路径） */
export interface ExtractedLink {
  /** 原始 wikilink 目标文本 */
  target: string;
  /** 提到它的那句话 */
  excerpt: string;
  /** 命中的那一处（白板 = 卡 id；脑图 = 节点 id） */
  anchorId: string;
  /** 那一处的标题（可空） */
  label: string;
}

/** 一处**卡内/节点上**写下的标签（`F1` 追记：侧栏标签面板要能展开到"哪张卡在用"） */
export interface ExtractedTag {
  tag: string;
  /** 写它的那一处（白板 = 卡 id；脑图 = 节点 id）；空串 = 只有文档级信息 */
  anchorId: string;
  /** 那一处的标题（可空） */
  label: string;
}

/** 一份文档扫出来的东西 */
export interface ExtractedDoc {
  /** 文档标题（白板 / 脑图的 `meta.title`） */
  title: string;
  links: ExtractedLink[];
  tags: string[];
  /**
   * 标签 → 写它的那一处（可选）。
   *
   * ★ 缺席 = 这份文档只报"有这些标签"（脑图那份提取器就是如此）：
   *   `recordOf` 会替它造出 `anchorId: ''` 的条目，面板照样列得出这份文档，
   *   只是展开不到具体卡片。新提取器**不必**为了兼容而补一个空数组。
   */
  tagHits?: ExtractedTag[];
}

/**
 * 「文本 → 出链 / 标签」**按文档类型各实现一份**（`06 §7.2`）。
 *
 * ★ 这就是那个接缝：`LinkIndex` 只认这个函数，不认 `.nboard` / `.nestmind`。
 *   白板的实现在本文件（`extractBoardDoc`），脑图那份在 `mind/io/extractLinks.ts`。
 * ★ 不传时的默认值 = 白板那份（本文件的老本行）：既有调用与单测一个字都不用改。
 */
export type LinkExtractor = (sourcePath: string, text: string) => ExtractedDoc | null;

/**
 * 把 wikilink 文本解析成 vault 路径。
 *
 * ★ 由调用方注入：`integration/` 不该 import `obsidian` 去查 `metadataCache`，
 *   而"这个名字指哪个文件"只有 Obsidian 知道（最短唯一名、别名、大小写）。
 *   生产实现见 `main.ts` 的 `linkResolver`。
 */
export type LinkResolver = (target: string, sourcePath: string) => string | null;

/**
 * 一份文档扫出来的东西。
 *
 * 不存文档标题：标题已经逐条拷进 `LinkHit.docTitle`（反查表与列表都直接读它），
 * 再存一份就要在改名、移动时同步两处 —— 一份能推导出来的数据不值得维护两次。
 */
interface DocRecord {
  links: LinkHit[];
  tags: Set<string>;
  /** 卡片级标签命中（带 `docPath` / `docTitle`，与 `LinkHit` 同一条"文档中立"的路子） */
  tagHits: TagHit[];
}

/** 一条卡片级标签命中（侧栏标签面板用） */
export interface TagHit extends ExtractedTag {
  /** 写它的那份文档（vault 相对路径） */
  docPath: string;
  docTitle: string;
}

export interface LinkIndexOptions {
  /** 列出全部白板路径（vault 相对） */
  list: () => Promise<string[]>;
  /**
   * 读一块白板。读回 `null`、或**直接抛**，都视为"读不到"并跳过它 ——
   * 适配器对"文件不在了"这两种风格都有人用，调用方不该被迫统一。
   */
  read: (path: string) => Promise<string | null>;
  /** wikilink → vault 路径；缺省时全部退回按文件名匹配 */
  resolve?: LinkResolver;
  /**
   * 「文本 → 出链 / 标签」的按类型实现（见 {@link LinkExtractor}）。
   * 缺省 = 白板那份（本文件的老本行）⇒ 既有调用不变。
   */
  extract?: LinkExtractor;
  /** 每片处理多少份文档（默认 20） */
  chunkSize?: number;
  /** 让出主线程的方式（测试注入点）。默认 `requestIdleCallback` → `setTimeout` 兜底 */
  scheduleIdle?: (task: () => void) => void;
}

/** 索引的规模（侧栏标注"扫了多少块板"要用真实数字） */
export interface LinkIndexStats {
  boards: number;
  links: number;
  tags: number;
  /** 还没解析出路径的出链数 —— 这个数字大，说明 `metadataCache` 还没就绪 */
  unresolved: number;
}

const DEFAULT_CHUNK_SIZE = 20;
const IDLE_TIMEOUT_MS = 500;

/**
 * 跨白板链接索引。
 *
 * 生命周期：`rebuild()` 全量扫一遍 → 之后靠 `updateFromBoard`（保存）/ `update`（外部改动）
 * / `remove` / `renamePath` 增量维护，与 `BoardRegistry` 的维护方式是同一套事件源。
 */
export class LinkIndex {
  private readonly records = new Map<string, DocRecord>();
  /** 反查表：解析出的路径 → 出链 */
  private readonly byResolved = new Map<string, LinkHit[]>();
  /** 反查表：wikilink 目标**文件名** → 出链（解析不出路径时的退路） */
  private readonly byName = new Map<string, LinkHit[]>();
  private readonly listeners = new Set<() => void>();
  /** 「文本 → 出链 / 标签」的实现（按文档类型注入，缺省白板那份） */
  private readonly extractor: LinkExtractor;

  private generation = 0;
  private ready = false;
  private scanned = 0;

  constructor(private readonly options: LinkIndexOptions) {
    this.extractor = options.extract ?? extractBoardDoc;
  }

  // ── 构建 ────────────────────────────────────────────────────

  /**
   * 全量重建。分片扫描，**每片提交一次**，所以调用方 `void index.rebuild()` 也不会卡 UI。
   *
   * ★ `generation` 计数器用于"扫到一半又来了一个 rebuild"（用户改设置触发的重建）：
   *   旧的那次会在下一片开头发现自己的世代过期并**直接放弃**，绝不与新的那次
   *   交替往 `records` 里写 —— 否则结果会是一半旧库一半新库的混合体。
   */
  async rebuild(): Promise<void> {
    const generation = ++this.generation;
    const chunkSize = Math.max(1, this.options.chunkSize ?? DEFAULT_CHUNK_SIZE);

    this.ready = false;
    this.scanned = 0;

    let paths: string[];
    try {
      paths = await this.options.list();
    } catch {
      // 列不出文件（适配器异常）不该让插件加载失败：留一个空索引，侧栏显示"没有反链"
      this.records.clear();
      this.publish();
      this.ready = true;
      return;
    }

    const collected = new Map<string, DocRecord>();
    for (let start = 0; start < paths.length; start += chunkSize) {
      if (generation !== this.generation) return;

      for (const path of paths.slice(start, start + chunkSize)) {
        const record = await this.readRecord(path);
        if (record) collected.set(path, record);
      }

      this.scanned = Math.min(start + chunkSize, paths.length);
      // 换掉整张表而不是增量塞：`records` 必须与 `byResolved` / `byName` 严格同源
      this.records.clear();
      for (const [path, record] of collected) this.records.set(path, record);
      this.publish();
      await this.yieldIdle();
    }

    if (generation !== this.generation) return;
    this.ready = true;
    this.publish();
  }

  // ── 增量维护（T5.02） ───────────────────────────────────────

  /**
   * 按磁盘内容重索引一块板（外部 `modify` / `create`）。
   *
   * 读不出来（文件被删/被占）时**当作删除**：留着旧记录比没有记录更糟 ——
   * 那会让反链指向一块已经不存在的板。
   */
  async update(path: string): Promise<void> {
    const record = await this.readRecord(path);
    this.setRecord(path, record);
  }

  /**
   * 用**内存模型**重索引一块板，免读盘（`repository` 的 `saved` 事件）。
   *
   * ★ 保存频率远高于外部改动，走磁盘读会把自动保存变成"每次都多读一次自己的文件"。
   */
  updateFromBoard(path: string, board: BoardFile): void {
    const doc = extractBoardFile(board, path);
    this.setRecord(path, recordOf(doc, path, this.options.resolve));
  }

  remove(path: string): void {
    if (!this.records.delete(path)) return;
    this.publish();
  }

  /** 文档改名：只换 key，不重扫（内容一个字节都没变） */
  renamePath(oldPath: string, newPath: string): void {
    const record = this.records.get(oldPath);
    if (!record) return;
    this.records.delete(oldPath);

    // 记录里嵌着 `docPath`，逐个改写；`resolved` 也可能因"来源路径变了"而变，
    // 但那要重扫才知道，这里不假装重算 —— 下一次 `reresolve()`/保存会修正
    const moved: DocRecord = {
      tags: record.tags,
      links: record.links.map((hit) => ({ ...hit, docPath: newPath })),
      // 标签命中也嵌着 `docPath`：改名时不改的话，面板点开它会打开一个不存在的路径
      tagHits: record.tagHits.map((hit) => ({ ...hit, docPath: newPath })),
    };
    this.records.set(newPath, moved);
    this.publish();
  }

  /**
   * 用当前的 `resolve` 重新解析全部原始目标（**不重读文件**）。
   *
   * ★ 存在的理由很具体：插件加载时 `metadataCache` 往往还没建好，第一次扫描
   *   会把几乎所有链接都解析成 `null`。此时它们靠文件名匹配勉强可用，但那不是
   *   最终答案 —— `metadataCache.on('resolved')` 之后调一次本方法，就能把
   *   "同名不同目录"这类情况纠正过来。重解析只碰字符串，成本可忽略。
   */
  reresolve(): void {
    const resolve = this.options.resolve;
    if (!resolve) return;

    let changed = false;
    for (const [path, record] of this.records) {
      let boardChanged = false;
      const links = record.links.map((hit) => {
        const resolved = resolve(hit.target, path);
        if (resolved === hit.resolved) return hit;
        boardChanged = true;
        return { ...hit, resolved };
      });
      if (!boardChanged) continue;
      record.links = links;
      changed = true;
    }
    // 一个字都没变就不广播：`metadataCache` 的 `resolved` 会连着触发多次，
    // 每次都重画一遍侧栏会让列表在启动时闪个不停
    if (changed) this.publish();
  }

  // ── 查询 ────────────────────────────────────────────────────

  /**
   * 「谁提到了这个笔记」。
   *
   * ★ 两条来路合并：**精确**（`resolved === notePath`）与**兜底**（解析不出、但
   *   wikilink 的文件名对得上）。两者互斥，不会重复计数 —— 解析成功的链接
   *   不该再靠文件名匹配进来一次（那样同名文件会把它算两遍）。
   */
  backlinksOf(notePath: string): LinkHit[] {
    const exact = this.byResolved.get(notePath) ?? [];
    const base = splitName(notePath).base;
    const loose =
      base.length === 0 ? [] : (this.byName.get(base) ?? []).filter((hit) => hit.resolved === null);
    return [...exact, ...loose];
  }

  /** 有哪些白板的内联卡用过这个标签（供侧栏"按标签"分组） */
  boardsWithTag(tag: string): string[] {
    const paths: string[] = [];
    for (const [path, record] of this.records) {
      if (record.tags.has(tag)) paths.push(path);
    }
    return paths;
  }

  /** 索引里的全部内联标签（去重、已排序） */
  tags(): string[] {
    const all = new Set<string>();
    for (const record of this.records.values()) {
      for (const tag of record.tags) all.add(tag);
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }

  /** 某块板的内联标签 */
  tagsOf(path: string): string[] {
    return [...(this.records.get(path)?.tags ?? [])].sort((a, b) => a.localeCompare(b));
  }

  /**
   * 某份文档里**每一处**写下的标签（卡片级；`F1` 追记的侧栏标签面板用它展开）。
   *
   * ★ 与 `tagsOf` 的分工：那个答"这块板有哪些标签"（去重），这个答"分别写在哪张卡上"。
   *   两者都从同一份 `tagHits` 来 —— 不会再出现"标签列表里有、展开却找不到"。
   */
  tagHitsOf(path: string): TagHit[] {
    return [...(this.records.get(path)?.tagHits ?? [])];
  }

  /** 全部出链（调试 / 统计用） */
  allLinks(): LinkHit[] {
    const all: LinkHit[] = [];
    for (const record of this.records.values()) all.push(...record.links);
    return all;
  }

  /**
   * 某块板的内联出链（按卡、按出现顺序）。
   *
   * ★ 索引笔记（`T7.01`）按它写正文。返回的是**副本**：索引笔记那边会按解析结果
   *   去重、排序，那是它的排版自由，不该有机会动到索引内部的数组。
   */
  linksOf(path: string): LinkHit[] {
    return [...(this.records.get(path)?.links ?? [])];
  }

  stats(): LinkIndexStats {
    let links = 0;
    let tags = 0;
    let unresolved = 0;
    for (const record of this.records.values()) {
      links += record.links.length;
      tags += record.tags.size;
      for (const hit of record.links) if (hit.resolved === null) unresolved += 1;
    }
    return { boards: this.records.size, links, tags, unresolved };
  }

  /** 全量扫描是否走完（没走完时侧栏要显示"正在扫描 n/m"而不是"没有反链"） */
  get isReady(): boolean {
    return this.ready;
  }

  /** 已扫描的板数（扫描途中显示进度用） */
  get scannedBoards(): number {
    return this.scanned;
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.generation += 1;
    this.records.clear();
    this.byResolved.clear();
    this.byName.clear();
    this.listeners.clear();
  }

  // ── 内部 ────────────────────────────────────────────────────

  private async readRecord(path: string): Promise<DocRecord | null> {
    let raw: string | null;
    try {
      raw = await this.options.read(path);
    } catch {
      // ★ 读**抛错**与读回 null 在此同义。适配器对"文件不在了"既可能返回 null
      //   也可能抛（`MemoryVaultIO` 就是抛），调用方不该为这两种风格各写一遍判断。
      //   更要紧的是：这里是 `vault.on(...)` 事件链的一环，一个读异常冒出去会打断
      //   整条链 —— 反链少一条可以，事件处理器挂掉不行。
      return null;
    }
    if (raw === null) return null;
    // ★ 认哪种文档由注入的 `extract` 说了算：`.nboard` 走白板那份、`.nestmind` 走脑图那份
    //   （两份都由 `main.ts` 按扩展名分派）。解析不出就跳过这一份。
    const doc = this.extractor(path, raw);
    if (!doc) return null;
    return recordOf(doc, path, this.options.resolve);
  }

  private setRecord(path: string, record: DocRecord | null): void {
    if (record) this.records.set(path, record);
    else if (!this.records.delete(path)) return;
    this.publish();
  }

  /** 由 `records` 重算反查表并广播 */
  private publish(): void {
    this.byResolved.clear();
    this.byName.clear();

    for (const record of this.records.values()) {
      for (const hit of record.links) {
        if (hit.resolved !== null) pushInto(this.byResolved, hit.resolved, hit);
        const base = splitName(hit.target).base;
        if (base.length > 0) pushInto(this.byName, base, hit);
      }
    }

    for (const list of this.byResolved.values()) list.sort(compareHits);
    for (const list of this.byName.values()) list.sort(compareHits);

    // 先复制再遍历：监听者在回调里退订是正常用法（视图关闭时就会这么做）
    for (const listener of [...this.listeners]) listener();
  }

  private yieldIdle(): Promise<void> {
    const schedule = this.options.scheduleIdle ?? defaultScheduleIdle;
    return new Promise<void>((resolve) => {
      schedule(() => resolve());
    });
  }
}

/**
 * 白板那份 `extract`：`.nboard` 文本 → 出链 / 标签（**默认实现**）。
 *
 * 解析不出白板就返回 `null`（调用方跳过它）；其余细节与老版本逐字一致 ——
 * 这一版只是把它从 `LinkIndex` 的私有流程里搬成一个可替换的端口。
 */
export function extractBoardDoc(boardPath: string, text: string): ExtractedDoc | null {
  const board = parseBoardFile(text);
  if (!board) return null;
  return extractBoardFile(board, boardPath);
}

/**
 * 扫出来的东西 → 索引记录。
 *
 * ★ 补上三件 `extract` 管不着的事：**这是哪份文档**（路径 + 标题）、
 *   **解析成哪个文件**（`resolve`），以及标签换成 `Set`（查询要按标签找文档）。
 *   `extract` 只管"从文本里认出链接与标签"，这一层只管"把它放进索引的形状里"。
 */
function recordOf(doc: ExtractedDoc, path: string, resolve: LinkResolver | undefined): DocRecord {
  return {
    tags: new Set(doc.tags),
    // 提取器没给卡片级信息时**替它造**：文档级标签照样列得出来（见 `ExtractedDoc.tagHits`）
    tagHits: (doc.tagHits ?? doc.tags.map((tag) => ({ tag, anchorId: '', label: '' }))).map(
      (hit) => ({ ...hit, docPath: path, docTitle: doc.title }),
    ),
    links: doc.links.map((link) => ({
      ...link,
      docPath: path,
      docTitle: doc.title,
      // 解析失败不丢边（见 `reresolve` 的注释）
      resolved: resolve ? resolve(link.target, path) : null,
    })),
  };
}

/** 白板模型 → 扫出来的东西（**不解析路径** —— 那是索引那边的事） */
function extractBoardFile(board: BoardFile, boardPath: string): ExtractedDoc {
  const title = board.meta.title;
  const links: ExtractedLink[] = [];
  const tags = new Set<string>();

  const tagHits: ExtractedTag[] = [];
  const seenTagHits = new Set<string>();
  /** 卡片正文（有 md 的那几类）与标签各扫各的口径，见下 */
  for (const card of board.cards) {
    // ★ **标签：全部卡型**（`F1`）。与插件自己的标签口径同一份实现（`tagsOfCard`
    //   —— 过滤条 / 搜索用的就是它）：不然会出现"过滤条里搜得到 `#纪要`、OB 里搜不到"
    //   这种没法解释的不一致。白板里任何一张卡上写过这个标签，都该在库里找得到它。
    for (const tag of tagsOfCard(card)) {
      tags.add(tag);
      // 同一张卡上同一个标签只记一条（标题里写过、正文里又写一次是常事）
      const key = `${card.id}\u0000${tag}`;
      if (seenTagHits.has(key)) continue;
      seenTagHits.add(key);
      tagHits.push({ tag, anchorId: card.id, label: card.title });
    }

    // ★ **链接：只扫 `note`**（内联卡，`F10-08` 的原话）。`todo` / `swatch` / `ink`
    //   的正文也存在文件里、也可能写 `[[链接]]`，但把它们算进来的话，侧栏上
    //   "内联卡反链"这个说法就不成立了 —— 要么扩大范围并改名，要么守住边界，这里选后者。
    //   （标签与链接在这里**故意不同口径**：反链是"这句话提到了那篇笔记"，用户是在
    //    便签里写句子的；而标签是"这块板属于哪个议题"，哪张卡上写都作数。）
    if (card.type !== 'note') continue;

    const scan = scanInlineText(card.content.md);
    for (const hit of scan.links) {
      links.push({
        excerpt: hit.excerpt,
        target: hit.target,
        anchorId: card.id,
        label: card.title,
      });
    }
  }

  // `boardPath` 现在只用来认"这是哪一份文档"（`meta` 里没有它），
  // 保留参数是为了与脑图那份**同一个签名**（端口的一致性比省一个参数重要）
  void boardPath;

  return { title, links, tags: [...tags], tagHits };
}

/** 稳定的展示顺序：先按文档标题，再按那一处的标题，最后按原始目标 */
function compareHits(a: LinkHit, b: LinkHit): number {
  return (
    a.docTitle.localeCompare(b.docTitle) ||
    a.label.localeCompare(b.label) ||
    a.target.localeCompare(b.target) ||
    a.anchorId.localeCompare(b.anchorId)
  );
}

function pushInto(map: Map<string, LinkHit[]>, key: string, hit: LinkHit): void {
  const list = map.get(key);
  if (list) list.push(hit);
  else map.set(key, [hit]);
}

/** 默认的让出主线程方式：空闲回调优先，没有就退化成"下一个宏任务" */
function defaultScheduleIdle(task: () => void): void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;

  if (typeof idle === 'function') idle(task, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(task, 0);
}
