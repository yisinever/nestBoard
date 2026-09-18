/**
 * 引用卡（T1.42–T1.45、T2.01）—— `F1.05`，Whiteboard 增强版的核心差异点。
 *
 * 与便签卡的本质区别：**内容不是存在白板里的，而是指向一篇真实 `.md`**。
 * 于是它天然继承 Vault 的一切 —— 双链、标签、Dataview、反向链接面板 ——
 * 而白板只负责"截取一小片给你看"。
 *
 * | 职责 | 落在哪 |
 * |---|---|
 * | 三种呈现（摘要 / 缩略图 / 全文内嵌） | 本文件 `render` |
 * | 双击打开源笔记（T1.43） | 本文件 `onDoubleClick` → `VaultBridge.open` |
 * | 源文件被外部改动后刷新（T1.44） | 本文件 `render` 里的 `watch` + 50ms 去抖 |
 * | 断链提示与一键重连（T1.45） | 本文件 `noteRefState` + 消息块里的"重新链接" |
 * | 卡内轻量编辑 + CAS 写回（T2.01） | 本文件 `renderEditor` / `commit` |
 *
 * 三条承接而来的设计：
 *
 * 1. **不 import `obsidian`**：读 Vault / 打开笔记 / 解析资源路径全部走
 *    `CardRenderContext.notes`（`VaultBridge`）。因此 `noteRefState` / `excerptOf`
 *    这些判定能在 node 下直接单测（`03 §7.2`）。
 * 2. **异步内容的两个坑都在这处理**：
 *    - *过期结果*：`read()` 是异步的，返回时卡片可能已被回收复用给别的卡。
 *      每个槽位元素配一个自增 token，异步回来先对 token，对不上就整个丢弃。
 *    - *高度*：`render()` 返回时槽位还是空的，卡片层量到 0。内容画完后调
 *      `ctx.contentReady()` 让它重量一次（否则引用卡的自动高度永远不生效）。
 * 3. **建节点一律走 `el.ownerDocument`，不用全局 `document`**：单测跑在 node 里
 *    （没有全局 `document`），卡片定义要想被测就得自己带着 document 走。
 *    与 `file.ts` / `boardRef.ts` / `image.ts` 是同一种写法。
 */

import { isNotePath } from '../model/drop';
import type { CardOfType, NoteRefContent } from '../model/schema';
import type { Size } from '../util/geometry';
import { t, type MessageKey } from '../util/i18n';
import { MiniMarkdownEditor } from '../editor/MiniMarkdownEditor';
import type {
  BacklinkBridge,
  BacklinkHit,
  CardActionContext,
  CardRenderContext,
  CardTypeDefinition,
  CardTypeMenuItem,
  NoteWriteResult,
  VaultBridge,
} from './registry';

/** 新建引用卡的默认尺寸：够放一个标题 + 五六行摘要 */
export const NOTE_REF_DEFAULT_SIZE: Size = { width: 280, height: 170 };

/** `vault.modify` 去抖窗口（T1.44）。Obsidian 保存一次会连发多个事件 */
export const NOTE_REF_SYNC_DEBOUNCE_MS = 50;

/** 本定义往槽位元素上加的 class，`destroy()` 必须原样摘掉 */
const NOTE_REF_CLASSES = [
  'nestboard-note-ref',
  'nestboard-note-ref-missing',
  'nestboard-note-ref-empty',
  'nestboard-note-ref-edit',
] as const;

// ─────────────────────────────────────────────────────────────
// 纯逻辑（可单测）
// ─────────────────────────────────────────────────────────────

/** 引用卡此刻该画什么。三种状态的全部判定都在这里，`render` 只负责照着画 */
export type NoteRefState = 'empty' | 'missing' | 'ready';

/**
 * @param exists Vault 查询函数；传 `null` 表示没有 Vault 桥（单测场景）——
 *               此时一律当作"能读"，因为"读不到"是运行时才知道的事。
 */
export function noteRefState(
  content: Pick<NoteRefContent, 'path'>,
  exists: ((path: string) => boolean) | null,
): NoteRefState {
  if (content.path.length === 0) return 'empty';
  if (!exists) return 'ready';
  return exists(content.path) ? 'ready' : 'missing';
}

/**
 * 取前 `lines` 行正文当摘要。
 *
 * 刻意**不**渲染 Markdown 而是降级成纯文本：摘要块在缩放 30% 时也要一眼可读，
 * 夹杂标题层级/表格线只会变成噪声。frontmatter 必须剥掉，否则摘要第一行
 * 永远是 `tags: [...]`，等于没有摘要。
 */
export function excerptOf(markdown: string, lines: number): string {
  if (lines <= 0) return '';
  const body = stripFrontmatter(markdown);
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const cleaned = stripInlineMarkdown(raw);
    if (cleaned.length === 0) continue;
    out.push(cleaned);
    if (out.length >= lines) break;
  }
  return out.join('\n');
}

/** 剥掉开头的 YAML frontmatter（`---` 到下一个 `---`） */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return markdown;
  const after = markdown.indexOf('\n', end + 1);
  return after === -1 ? '' : markdown.slice(after + 1);
}

/** 行内 Markdown → 纯文本（标题号、列表符、引用符、强调、链接语法） */
export function stripInlineMarkdown(line: string): string {
  let out = line.trim();
  out = out.replace(/^#{1,6}\s*/, '');
  out = out.replace(/^(?:[-*+]|\d+\.)\s+/, '');
  out = out.replace(/^>\s?/, '');
  // `![[图.png|alt]]` / `[[笔记|别名]]` → 别名优先，其次目标名
  out = out.replace(
    /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, alias?: string) => alias ?? target,
  );
  out = out.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, alias?: string) => alias ?? target,
  );
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/[*_`~]/g, '');
  return out.trim();
}

const WIKI_IMAGE = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/;
const MD_IMAGE = /!\[[^\]]*\]\(([^)\s]+)/;

/** 找正文里第一张图片链接，作为缩略图来源。找不到返回 `null` */
export function firstImageLink(markdown: string): string | null {
  const wiki = WIKI_IMAGE.exec(markdown);
  if (wiki) return wiki[1].split('#')[0].trim();
  const md = MD_IMAGE.exec(markdown);
  return md ? md[1] : null;
}

/** 路径 → wikilink 目标：Obsidian 的 wikilink **不带** `.md` 扩展名 */
export function toWikilinkTarget(path: string): string {
  return path.replace(/\.md$/i, '');
}

// ─────────────────────────────────────────────────────────────
// 定位到笔记的某一处（T7.10 / `F10-07`）
//
// 引用卡的 `subpath` 存的是 Obsidian 的**子路径**：`#标题`（可多级 `#父#子`）
// 或 `#^块id`。这块只做"文本 → 目标"与"目标 → 文本切片"两件纯事：
//  * 卡面显示哪一段由 `sliceBySubpath` 决定（摘要 / 缩略图 / 全文内嵌都走它）；
//  * 菜单里能选哪些目标由 `listNoteRefAnchors` 列出。
// 两者都不认识 Obsidian 的 API，所以能在 node 下单测（`03 §7.2`）。
// ─────────────────────────────────────────────────────────────

/** 标题行：`## 标题` */
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
/**
 * 块 id 标记：`^id` 落在某一行的**末尾**（前面可以有空白）。
 * ★ 必须是行尾：Obsidian 的块标记就是这个写法，正文中间的 `^` 是普通字符
 *   （`3^2` 不该被当成"块 2"）。
 */
const BLOCK_MARK = /(?:^|\s)\^([A-Za-z0-9_-]+)\s*$/;

/** 引用卡要显示的范围 */
export type NoteRefTarget =
  /** 整篇笔记 */
  | { kind: 'whole' }
  /** `#标题` / `#父#子` —— 从该标题到下一个同级（或更高级）标题 */
  | { kind: 'heading'; levels: string[] }
  /** `#^块id` —— 该块所在的那一段连续非空行 */
  | { kind: 'block'; id: string };

/**
 * 解析 `subpath`。
 *
 * ★ 认不出来的一律当"整篇"（而不是报错）：`subpath` 可能来自手改过的文件、
 *   也可能来自别的工具写的 `[[笔记#随便什么东西]]`。显示整篇永远比显示一片
 *   空白更有用，而"这条定位看不懂"这件事由 `sliceBySubpath` 的 `found` 说。
 */
export function parseNoteRefTarget(subpath: string | null | undefined): NoteRefTarget {
  if (!subpath) return { kind: 'whole' };
  const trimmed = subpath.trim();
  if (!trimmed.startsWith('#')) return { kind: 'whole' };

  const body = trimmed.slice(1);
  if (body.startsWith('^')) {
    const id = body.slice(1).trim();
    return id.length > 0 ? { kind: 'block', id } : { kind: 'whole' };
  }

  const levels = body
    .split('#')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return levels.length > 0 ? { kind: 'heading', levels } : { kind: 'whole' };
}

/** 菜单 / 选择器里能列出的一个可引用目标 */
export interface NoteRefAnchor {
  /** 写回 `subpath` 的值；`null` = 整篇笔记 */
  subpath: string | null;
  kind: 'whole' | 'heading' | 'block';
  /** 标题文本 / 块 id；`whole` 是空串（文案由 UI 层按 `kind` 取） */
  label: string;
  /** 标题层级 `1`–`6`；`whole` / `block` 为 `0` */
  level: number;
}

/**
 * 列出笔记里所有可引用的目标：开头永远是「整篇笔记」，随后按正文顺序
 * 依次是各级标题与带块 id 的块。
 *
 * ★ 标题的 `subpath` 写成**完整层级链**（`#父#子`）而不是单独的 `#子`：
 *   Obsidian 就是靠层级数量 + 逐级匹配定位的，只写 `#子` 在"父标题下有一个叫
 *   `子` 的、别处也有一个"时会指错。
 * ★ 已知取舍：两个**同名同级**的标题会生成同一个 `subpath`（Obsidian 靠序号消歧，
 *   那套语法不属于"子路径"）。与其猜一个序号，不如让它们指向第一个 —— 至少是
 *   一个说得通的位置。
 */
export function listNoteRefAnchors(markdown: string): NoteRefAnchor[] {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const out: NoteRefAnchor[] = [{ subpath: null, kind: 'whole', label: '', level: 0 }];
  // 当前的层级链：下标 `i` 是第 `i+1` 级标题。
  const stack: string[] = [];

  for (const raw of lines) {
    const heading = HEADING_LINE.exec(raw);
    if (heading) {
      const level = heading[1].length;
      const title = stripInlineMarkdown(heading[2]);
      // 更深的那几级全部作废（它们已经不属于这条链了）
      stack.length = level - 1;
      // 跳级（`#` 之后直接 `###`）时中间没有标题占位 —— 补空串。
      // 不补的话 `#${stack.join('#')}` 会比实际层级少一段，指到别处去
      while (stack.length < level - 1) stack.push('');
      stack.push(title);
      out.push({ subpath: `#${stack.join('#')}`, kind: 'heading', label: title, level });
      continue;
    }

    const block = BLOCK_MARK.exec(raw);
    if (block) {
      out.push({ subpath: `#^${block[1]}`, kind: 'block', label: block[1], level: 0 });
    }
  }

  return out;
}

/** 切片结果 */
export interface NoteRefSlice {
  /** 要显示的正文。定位不到时是**整篇**（配合 `found: false` 给一句提示） */
  markdown: string;
  /** 是否真的切到了目标位置。`kind: 'whole'` 恒为 `true` */
  found: boolean;
}

/**
 * 按 `subpath` 从整篇正文里切出要显示的一段。
 *
 * ★ 定位不到时返回**整篇**而不是空串：源笔记被改过、块 id 被删掉是常事，
 *   此时卡片显示整篇 + 一句"定位目标不在了"，比显示一片空白更有用 ——
 *   至少用户还看得见这篇笔记的内容，也看得见该去重选了。
 */
export function sliceBySubpath(markdown: string, subpath: string | null): NoteRefSlice {
  const target = parseNoteRefTarget(subpath);
  if (target.kind === 'whole') return { markdown, found: true };

  const lines = markdown.split(/\r?\n/);
  const range =
    target.kind === 'block' ? blockRange(lines, target.id) : headingSection(lines, target.levels);
  if (!range) return { markdown, found: false };

  // 块 id 的 `^id` 标记是**给人认的**，不该出现在卡面上；顺带把行尾空白收干净，
  // 否则摘要第一行会带着一串空格（`stripInlineMarkdown` 只 trim 两端）
  return {
    markdown: lines
      .slice(range.start, range.end + 1)
      .map((line) => line.replace(BLOCK_MARK, '').trimEnd())
      .join('\n'),
    found: true,
  };
}

/** 带这个块 id 的那一段**连续非空行** */
function blockRange(lines: readonly string[], id: string): { start: number; end: number } | null {
  let marked = -1;
  for (let index = 0; index < lines.length; index++) {
    const match = BLOCK_MARK.exec(lines[index]);
    if (match && match[1] === id) {
      marked = index;
      break;
    }
  }
  if (marked === -1) return null;

  // ★ "块"取整段连续非空行（段落就是这个定义）。对列表项来说这会把整张清单
  //   一起带走 —— 这是刻意的：清单的前几条往往是理解这一条所必需的上下文，
  //   只截出一行经常让引用卡变成一句没头没尾的话
  let start = marked;
  while (start > 0 && lines[start - 1].trim().length > 0) start--;
  let end = marked;
  while (end < lines.length - 1 && lines[end + 1].trim().length > 0) end++;
  return { start, end };
}

/** 逐级匹配标题链，直到下一个**同级或更高级**的标题为止 */
function headingSection(
  lines: readonly string[],
  levels: readonly string[],
): { start: number; end: number } | null {
  let searchFrom = 0;
  let start = -1;

  for (let depth = 1; depth <= levels.length; depth++) {
    const want = levels[depth - 1];
    let found = -1;
    for (let index = searchFrom; index < lines.length; index++) {
      const heading = HEADING_LINE.exec(lines[index]);
      if (!heading) continue;
      const level = heading[1].length;
      // 还没找到本级就撞上了更浅的标题 → 这条链在正文里根本不存在
      if (level < depth) break;
      if (level === depth && stripInlineMarkdown(heading[2]) === want) {
        found = index;
        break;
      }
    }
    if (found === -1) return null;
    start = found;
    searchFrom = found + 1;
  }

  const level = levels.length;
  let end = lines.length - 1;
  for (let index = start + 1; index < lines.length; index++) {
    const heading = HEADING_LINE.exec(lines[index]);
    if (heading && heading[1].length <= level) {
      end = index - 1;
      break;
    }
  }
  return { start, end };
}

/** `/a/b/笔记.md` → `笔记` */
export function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/\.md$/i, '');
}

// ─────────────────────────────────────────────────────────────
// 异步生命周期：每个槽位元素一份 token + 一个退订函数
// ─────────────────────────────────────────────────────────────

/**
 * 槽位 → 当前异步轮次号。
 *
 * 元素被回收复用给别的卡时 token 不复位（单调递增），于是"上一任租客"的
 * `read()` 回调回来必然对不上号，自动作废。
 */
const tokens = new WeakMap<HTMLElement, number>();

/** 槽位 → 当前 `watch` 的退订函数（T1.44） */
const watchers = new WeakMap<HTMLElement, () => void>();

function beginToken(el: HTMLElement): number {
  const next = (tokens.get(el) ?? 0) + 1;
  tokens.set(el, next);
  return next;
}

function disposeWatcher(el: HTMLElement): void {
  const dispose = watchers.get(el);
  if (!dispose) return;
  watchers.delete(el);
  dispose();
}

// ─────────────────────────────────────────────────────────────
// 反链角标（T5.04 / F10-03）
// ─────────────────────────────────────────────────────────────

/** 槽位 → 当前反链订阅的退订函数。与 `watchers` 同规矩：节点回收时必须退订 */
const backlinkWatchers = new WeakMap<HTMLElement, () => void>();

/**
 * 槽位 → 上一次画出来的反链「签名」（`是否扫完 + 条数`）。
 *
 * ★ 索引**每扫完一片就广播一次**，而绝大多数时候这件事与眼前这张卡无关。
 *   没有这道闸，画布上每一张引用卡都会跟着重建几十次角标 DOM —— 纯浪费。
 */
const backlinkStamps = new WeakMap<HTMLElement, string>();

/** 槽位 → 反链角标节点。重画时靠它摘掉上一份（不必 `querySelector`，单测的假 DOM 也没有它） */
const backlinkFooters = new WeakMap<HTMLElement, HTMLElement>();

/**
 * 已展开反链列表的卡片 id。
 *
 * ★ 纯展示态、**不落盘**（展开与否不值得写进 `.nboard`，也不该因为一次重画就合上），
 *   所以只能活在内存里。放在模块级而不是节点上：角标会随索引变化被重画，
 *   挂在节点上的状态会在那次重画后丢掉 —— 用户看到的是"列表自己合上了"。
 */
const expandedBacklinks = new Set<string>();

function disposeBacklinks(el: HTMLElement): void {
  const dispose = backlinkWatchers.get(el);
  if (dispose) {
    backlinkWatchers.delete(el);
    dispose();
  }
  backlinkStamps.delete(el);
  backlinkFooters.delete(el);
}

/**
 * 写回失败时暂存的草稿：`cardId` → 用户写进去、但没能落盘的正文（T2.01）。
 *
 * ★ 这份草稿是**唯一**的副本 —— 源笔记没写进去，`.nboard` 里也不会有一份。
 *   所以宁可"下次编辑这张卡时又把它翻出来"（一次多余、但看得见、而且能一键丢弃的
 *   打扰），也绝不静默丢掉用户打过的字。
 *
 * `reason` 决定提示条怎么说，因为它直接对应"用户下一步该做什么"：
 * 冲突 → 去看看新版本；文件没了 → 去重连；写入失败 → 查权限 / 磁盘。
 */
interface PendingDraft {
  text: string;
  reason: Exclude<NoteWriteResult, 'written'>;
}

const pendingDrafts = new Map<string, PendingDraft>();

/** 每种失败原因对应的文案键 */
const DRAFT_MESSAGE: Record<PendingDraft['reason'], MessageKey> = {
  conflict: 'card.noteRef.conflict',
  missing: 'card.noteRef.writeMissing',
  failed: 'card.noteRef.writeFailed',
};

// ─────────────────────────────────────────────────────────────
// 卡片定义
// ─────────────────────────────────────────────────────────────

export const noteRefCard: CardTypeDefinition<'noteRef'> = {
  type: 'noteRef',

  get displayName(): string {
    return t('card.type.noteRef');
  },

  icon: 'file-symlink',
  defaultSize: NOTE_REF_DEFAULT_SIZE,

  createDefaultContent(): NoteRefContent {
    return { path: '', subpath: null, mode: 'summary', excerptLines: 6 };
  },

  render(el: HTMLElement, card: CardOfType<'noteRef'>, ctx: CardRenderContext): void {
    disposeWatcher(el);
    disposeBacklinks(el);
    el.classList.add('nestboard-note-ref');
    el.classList.remove('nestboard-note-ref-missing', 'nestboard-note-ref-empty');

    const notes = ctx.notes ?? null;
    const state = noteRefState(card.content, notes ? (path) => notes.exists(path) : null);

    if (state === 'empty') {
      el.classList.add('nestboard-note-ref-empty');
      renderMessage(el, t('card.noteRef.empty'), card, ctx);
      return;
    }
    if (state === 'missing') {
      el.classList.add('nestboard-note-ref-missing');
      renderMessage(el, t('card.noteRef.missing', { path: card.content.path }), card, ctx);
      return;
    }
    if (!notes) {
      renderMessage(el, t('card.noteRef.loadFailed'), card, ctx);
      return;
    }

    // 编辑态走另一条路（T2.01）：读回源笔记 → 交给轻量编辑器 → 提交时 CAS 写回。
    // 提前返回还有一个关键作用：下面那段 `watch` 订阅不会执行 —— 正在打字时被一次
    // 外部改动重绘掉编辑器，等于当场丢掉用户刚敲的字。冲突留给提交时的 CAS 去发现。
    if (ctx.mode === 'edit') {
      renderEditor(el, card, notes, ctx);
      return;
    }

    // ★ 先清空槽位再画。真实的卡片层在调 `render()` 之前已经清过一遍，但卡片定义
    //   自己也得撑得住"同一个槽位重画"（单测就是这么做的）—— 不清的话，
    //   正文盒与反链角标会一层叠一层
    el.textContent = '';

    const box = el.ownerDocument.createElement('div');
    box.className = 'nestboard-note-ref-body';
    el.appendChild(box);

    const token = beginToken(el);
    const paint = (): void => {
      void notes.read(card.content.path).then((markdown) => {
        if (tokens.get(el) !== token) return; // 卡片已被回收 / 已重画
        void renderInto(box, card.content, markdown, ctx).then(() => {
          if (tokens.get(el) !== token) return;
          // 反链角标挂在**正文盒内部**的末尾（见 `mountBacklinks` 的注释），
          // 所以必须等 `renderInto` 把盒子清空重建之后再挂
          mountBacklinks(el, box, card, ctx);
          ctx.contentReady?.(); // 内容才刚落地 → 让卡片层重量一次高度（T1.38）
        });
      });
    };
    paint();

    // T1.44：源笔记被外部改动 → 只重画这一张卡。
    // 去抖 50ms 是必须的：Obsidian 一次保存会连发若干 modify。
    let timer: number | null = null;
    const dispose = notes.watch(card.content.path, () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        paint();
      }, NOTE_REF_SYNC_DEBOUNCE_MS);
    });
    watchers.set(el, () => {
      if (timer !== null) window.clearTimeout(timer);
      dispose();
    });
  },

  measure(el: HTMLElement): number {
    return el.scrollHeight;
  },

  /**
   * 引用卡的标题就是那篇笔记的文件名（`O38`）。
   *
   * ★ 与白板卡（`O37`）同一条病：卡面第一行写的就是**文件名**
   *   （`renderInto` 里的 `basenameOf(content.path)`），而 `card.title` 从不显示 ——
   *   改标题只写 `card.title` 的话，用户看到的是"打完字卡面没变、文件也没动"。
   * ★ 拖一篇 `.md` 进画布得到的**就是引用卡**（`model/drop.ts` 的 `NOTE_EXTENSIONS`），
   *   所以"文档卡改标题没有同步到文件名"这条反馈的落点在这里，不在文件卡上。
   * ★ 只认笔记（`.md` / `.markdown`）：`relink` 成别的文件时，标题不该去改那个文件。
   * ★ 引用**某一段**（`subpath`）的卡同样算：它指向的是同一个文件，标题说的也是那篇笔记
   *   —— 段位角标（`#标题` / `^块`）在名字后面另挂，与文件名是两回事。
   * ★ 路径跟随由 `RenameWatcher.retargetBoard` 负责（名单里本来就有 `noteRef`），
   *   这里一个字都不写 —— 含别的白板里指向同一篇笔记的那些卡。
   */
  titleFilePath(card): string | null {
    const path = card.content.path;
    return isNotePath(path) ? path : null;
  },

  contextMenu(card, menuCtx): CardTypeMenuItem[] {
    const noSource = card.content.path.length === 0;
    return [
      {
        id: 'edit-content',
        title: t('menu.card.editContent'),
        icon: 'pencil',
        // 断链时不给：编辑器读不到正文，进去只会看到"无法读取笔记"
        disabled: menuCtx.multiple || noSource,
        action: 'editContent',
      },
      {
        id: 'open-source',
        title: t('menu.card.openSource'),
        icon: 'external-link',
        disabled: menuCtx.multiple || noSource,
        action: 'openSource',
      },
      {
        id: 'relink',
        title: t('menu.card.relink'),
        icon: 'link',
        disabled: menuCtx.multiple,
        action: 'relink',
      },
      {
        // 引用块（T7.10 / `F10-07`）：把卡片定位到某个标题 / 某个块。
        // ★ 断链时不给：目标清单要从源笔记里读出来，读不到就只剩"整篇"一项，
        //   那等于把用户引到一条没有出口的路上（先重连，再选块）
        id: 'pick-block',
        title: t('menu.card.pickBlock'),
        icon: 'list',
        disabled: menuCtx.multiple || noSource,
        action: 'pickBlock',
      },
    ];
  },

  onDoubleClick(card, ctx: CardActionContext): boolean {
    const notes = ctx.notes;
    if (!notes || card.content.path.length === 0) return false;
    // 断链时不开（开了只会得到"文件不存在"的空标签），让用户走右键重连
    if (!notes.exists(card.content.path)) return false;
    notes.open(card.content.path, card.content.subpath, false);
    return true;
  },

  relink(card, ctx: CardActionContext): boolean {
    const notes = ctx.notes;
    if (!notes) return false;
    void pickAndApply(card, notes, (patch) => ctx.applyContent(patch));
    return true;
  },

  destroy(el: HTMLElement): void {
    disposeWatcher(el);
    // 反链订阅也要一起退：卡片回收进池子后索引还在广播，留着就是白跑
    disposeBacklinks(el);
    tokens.delete(el);
    el.classList.remove(...NOTE_REF_CLASSES);
  },

  toMarkdown(card): string {
    return `![[${toWikilinkTarget(card.content.path)}${card.content.subpath ?? ''}]]`;
  },
};

// ─────────────────────────────────────────────────────────────
// 渲染实现
// ─────────────────────────────────────────────────────────────

function renderMessage(
  el: HTMLElement,
  text: string,
  card: CardOfType<'noteRef'>,
  ctx: CardRenderContext,
): void {
  el.textContent = '';

  const box = el.ownerDocument.createElement('div');
  box.className = 'nestboard-note-ref-message';
  box.textContent = text;
  el.appendChild(box);

  const button = el.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'nestboard-note-ref-relink';
  button.textContent = t('card.noteRef.relink');
  // 按钮在卡片内部：不拦 pointerdown 的话，点一下会先被卡片层的拖动接管，
  // 变成"按一下就挪了卡"。click 上的 stopPropagation 挡不住 pointerdown。
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const notes = ctx.notes;
    if (notes) void pickAndApply(card, notes, (patch) => ctx.updateContent(patch));
  });
  el.appendChild(button);
}

/**
 * 弹选择器 → 写回 `path` / `subpath`。
 *
 * 两条入口共用：渲染块里的"重新链接"按钮（走 `CardRenderContext`）与
 * 右键菜单的"重新链接"（走 `CardActionContext`）。两条路的上下文接口不同，
 * 所以这里只依赖"一个 VaultBridge + 一个写回函数"这两个最小要素。
 */
async function pickAndApply(
  card: CardOfType<'noteRef'>,
  notes: VaultBridge,
  apply: (patch: Partial<NoteRefContent>) => void,
): Promise<void> {
  const picked = await notes.pickNote(card.content.path.length > 0 ? card.content.path : null);
  if (picked === null || picked === card.content.path) return;
  // 换了目标笔记，旧的 `#标题` 定位基本不再成立 → 一并清掉
  apply({ path: picked, subpath: null });
}

/** @returns 内容是否已经**画完**（`cover` 模式下图片未 load 完也算画完） */
async function renderInto(
  box: HTMLElement,
  content: NoteRefContent,
  markdown: string | null,
  ctx: CardRenderContext,
): Promise<void> {
  box.textContent = '';

  const name = box.ownerDocument.createElement('div');
  name.className = 'nestboard-note-ref-name';
  name.textContent = basenameOf(content.path);
  // 定位到某一处时在标题后面挂一个角标（T7.10）：卡片看起来和"整篇"完全一样，
  // 不给角标的话用户没法从卡面判断这张卡到底截了哪一段 —— 只能靠双击跳过去看
  const target = parseNoteRefTarget(content.subpath);
  if (target.kind !== 'whole') {
    const badge = box.ownerDocument.createElement('span');
    badge.className = 'nestboard-note-ref-target';
    badge.textContent = target.kind === 'block' ? `^${target.id}` : target.levels.join(' › ');
    name.appendChild(badge);
  }
  box.appendChild(name);

  if (markdown === null) {
    box.textContent = t('card.noteRef.loadFailed');
    return;
  }

  // ★ 一切内容都从**切片**上取（缩略图 / 摘要 / 全文内嵌）：
  //   三个模式各取各的原始正文，就会出现"摘要截了那一段、内嵌却是整篇"这种分叉
  const slice = sliceBySubpath(markdown, content.subpath);
  if (!slice.found) {
    const hint = box.ownerDocument.createElement('div');
    hint.className = 'nestboard-note-ref-target-missing';
    hint.textContent = t('card.noteRef.targetMissing');
    box.appendChild(hint);
  }

  if (content.mode === 'cover') {
    const image = firstImageLink(slice.markdown);
    const url = image ? (ctx.notes?.resourceUrl(image) ?? null) : null;
    if (url) {
      const thumb = box.ownerDocument.createElement('img');
      thumb.className = 'nestboard-note-ref-thumb';
      thumb.src = url;
      thumb.alt = '';
      thumb.loading = 'lazy';
      box.appendChild(thumb);
    }
  }

  const excerpt = box.ownerDocument.createElement('div');
  excerpt.className = 'nestboard-note-ref-excerpt';

  if (content.mode === 'embed') {
    // 全文内嵌：交回视图的 MarkdownRenderer（内嵌笔记 / 图片 / 双链都会活）
    excerpt.classList.add('nestboard-note-ref-embed');
    box.appendChild(excerpt);
    await ctx.renderMarkdown(slice.markdown, excerpt);
    return;
  }

  const text = excerptOf(slice.markdown, content.excerptLines);
  if (text.length === 0) {
    excerpt.dataset.placeholder = 'true';
    excerpt.textContent = t('card.note.empty');
  } else {
    excerpt.textContent = text;
  }
  box.appendChild(excerpt);
}

// ─────────────────────────────────────────────────────────────
// 反链角标（T5.04 / F10-03）
// ─────────────────────────────────────────────────────────────

/**
 * 在引用卡底部挂上「N 条反链」角标，点开是"哪几块板的哪张卡提过这篇笔记"。
 *
 * ## 为什么挂在 `box` 里而不是 `el` 上
 *
 * `.nestboard-note-ref-body` 是一条 flex 列，且被要求撑满整卡高（`height: 100%`）。
 * 只有把角标挂成它的**最后一个 flex 子项**（`flex: 0 0 auto`）才能既贴着摘要、
 * 又不被摘要的 `flex: 1` 吃掉。挂在 `el` 上则是和 `box` 争夺那 100% 高度。
 *
 * ## 为什么只有"正常显示"这一种状态挂它
 *
 * 空引用 / 断链 / 读不到正文时，卡片本身已经在报错、并给了「重新链接」出口。
 * 那几种状态的当务之急是"先把引用修好"，再叠一行反链只会把这张卡变成一锅粥。
 *
 * ## 为什么每张卡各订各的，而不是在视图层统一重画
 *
 * 索引是**分片**扫出来的，广播时没人知道哪张卡受影响。让每张卡自己按"这篇笔记的
 * 反链条数"过滤，代价是每个可见的引用卡多一个监听器，换来的是"谁变了谁重画"——
 * 不必让视图去反查"我这张卡对应哪篇笔记"。
 */
function mountBacklinks(
  el: HTMLElement,
  box: HTMLElement,
  card: CardOfType<'noteRef'>,
  ctx: CardRenderContext,
): void {
  const bridge = ctx.backlinks;
  const path = card.content.path;
  // 没有桥（单测 / 嵌入视图）或这张卡还没指向任何笔记：一个节点都不画
  if (!bridge || path.length === 0) return;

  // 每次重挂都先退掉上一份订阅：`paint` 除了被 `watch` 触发，源笔记改动
  // （上面那条 `watch`）也会重新走到这里，不退订就会一层层攒监听器
  disposeBacklinks(el);

  const draw = (hits: readonly BacklinkHit[]): void => {
    backlinkFooters.get(el)?.remove();
    backlinkFooters.delete(el);
    // 没有反链就不画角标 —— 每张引用卡底部都悬着一条「0 条反链」是纯噪声
    if (hits.length === 0) return;

    const footer = buildBacklinks(el.ownerDocument, card, hits, bridge, () => {
      // 展开 / 收起只改高度、不改条数，所以绕过签名直接重画同一份数据，
      // 再让卡片层重量一次（新高度要靠这一步才生效，T1.38）
      draw(bridge.list(path));
      ctx.contentReady?.();
    });
    box.appendChild(footer);
    backlinkFooters.set(el, footer);
  };

  const paint = (): void => {
    const hits = bridge.list(path);
    // 签名带上 `ready`：扫描途中"0 条"是暂时的，扫完必须允许重画一次
    const stamp = `${bridge.ready ? 'ready' : 'scanning'}:${hits.length}`;
    if (backlinkStamps.get(el) === stamp) return;
    backlinkStamps.set(el, stamp);
    draw(hits);
  };

  paint();
  backlinkWatchers.set(el, bridge.watch(paint));
}

/** 搭出角标本体（一个可展开的按钮 + 展开时的列表） */
function buildBacklinks(
  doc: Document,
  card: CardOfType<'noteRef'>,
  hits: readonly BacklinkHit[],
  bridge: BacklinkBridge,
  onToggle: () => void,
): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'nestboard-note-ref-links';

  const expanded = expandedBacklinks.has(card.id);

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nestboard-note-ref-links-toggle';
  // 折叠状态要让读屏知道（无障碍，`02 §7`）：光靠一个三角方向不够
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  toggle.textContent = `${expanded ? '▾' : '▸'} ${t('card.noteRef.backlinks', {
    count: hits.length,
  })}`;
  // 按钮长在卡片里：不拦 pointerdown 的话，按下去会先被卡片层的拖动接管（同 `relink`）
  toggle.addEventListener('pointerdown', (event) => event.stopPropagation());
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    // 展开态记在 `card.id` 上而不是元素上：角标会被索引变化重画，挂在元素上会丢
    if (expandedBacklinks.has(card.id)) expandedBacklinks.delete(card.id);
    else expandedBacklinks.add(card.id);
    onToggle();
  });
  root.appendChild(toggle);

  if (!expanded) return root;

  const list = doc.createElement('div');
  list.className = 'nestboard-note-ref-links-list';
  for (const hit of hits) list.appendChild(buildBacklinkItem(doc, hit, bridge));
  root.appendChild(list);
  return root;
}

/** 一条反链：板名 + 卡名 + 原话，整块可点，点一下跳过去 */
function buildBacklinkItem(doc: Document, hit: BacklinkHit, bridge: BacklinkBridge): HTMLElement {
  const item = doc.createElement('button');
  item.type = 'button';
  item.className = 'nestboard-note-ref-link';
  // 悬停能看到完整路径 —— `F7-04` 要的"白板位置"是路径，不是那个可能重名的标题
  item.title = hit.boardPath;

  const board = doc.createElement('div');
  board.className = 'nestboard-note-ref-link-board';
  // 板可能还没起名（`meta.title` 为空）：退回路径，至少能认出是哪块板
  board.textContent = hit.boardTitle.length > 0 ? hit.boardTitle : hit.boardPath;
  item.appendChild(board);

  if (hit.cardTitle.length > 0) {
    const title = doc.createElement('div');
    title.className = 'nestboard-note-ref-link-title';
    title.textContent = hit.cardTitle;
    item.appendChild(title);
  }

  const excerpt = doc.createElement('div');
  excerpt.className = 'nestboard-note-ref-link-excerpt';
  excerpt.textContent = hit.excerpt;
  item.appendChild(excerpt);

  item.addEventListener('pointerdown', (event) => event.stopPropagation());
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    bridge.open(hit.boardPath, hit.cardId);
  });
  return item;
}

// ─────────────────────────────────────────────────────────────
// 卡片内轻量编辑（T2.01 / `F2-2-3`）
// ─────────────────────────────────────────────────────────────

/**
 * 编辑态：把源笔记正文交给 `MiniMarkdownEditor`。
 *
 * ★ 读正文是异步的，所以编辑器只能"等到再挂"。期间卡片层量高度会拿到 0 ——
 *   不打紧：`CardLayer.measureContent` 在编辑态**本来就跳过**（里面是 `height: 100%`
 *   的输入框，量出来的高度恒等于卡片当前高度，一旦"量到多少就把卡长到多少"，
 *   就会变成每量一次涨一点的自激循环）。
 *
 * ★ 挂载后**不订阅** `watch`：外部改动若触发重绘，正在打字的人会连同编辑器一起
 *   被拆掉、输入全丢。冲突交给提交时的 CAS 发现，而不是靠重绘。
 */
function renderEditor(
  el: HTMLElement,
  card: CardOfType<'noteRef'>,
  notes: VaultBridge,
  ctx: CardRenderContext,
): void {
  el.classList.add('nestboard-note-ref-edit');
  const token = beginToken(el);

  const mount = (markdown: string): void => {
    // 读回来的路上卡片可能已经被重绘成别的形态，那次重绘自己会重挂编辑器
    if (tokens.get(el) !== token) return;
    el.textContent = '';

    // 与展示态共用 `.nestboard-note-ref-body`：那套 `flex` 列布局本来就是为
    // "上方固定块 + 下方可伸缩内容"写的，编辑器正好是这个形状
    const box = el.ownerDocument.createElement('div');
    box.className = 'nestboard-note-ref-body';
    el.appendChild(box);

    const pending = pendingDrafts.get(card.id);
    if (pending) {
      box.appendChild(
        conflictBar(box.ownerDocument, pending, () => {
          // 明确的"我不要了"：删掉草稿后**当场重挂**，否则这条提示会一直挂在那儿
          pendingDrafts.delete(card.id);
          mount(markdown);
        }),
      );
    }

    const host = el.ownerDocument.createElement('div');
    host.className = 'nestboard-note-ref-editor';
    box.appendChild(host);

    // ★ 有草稿时以**草稿**为准：那才是用户写的那一版；`markdown` 只是此刻磁盘上的内容，
    //   它同时充当本次提交的比较基准
    new MiniMarkdownEditor({
      host,
      value: pending?.text ?? markdown,
      onSubmit: (value) => {
        void commit(card, notes, ctx, markdown, value);
      },
      onExit: () => ctx.setMode('display'),
    }).focus();
  };

  void notes.read(card.content.path).then((markdown) => {
    if (tokens.get(el) !== token) return;
    if (markdown === null) {
      // 读不到就退回消息块：让用户看到"笔记读不出来"，而不是一个永远空着的输入框
      el.classList.remove('nestboard-note-ref-edit');
      renderMessage(el, t('card.noteRef.loadFailed'), card, ctx);
      return;
    }
    mount(markdown);
    ctx.contentReady?.();
  });
}

/**
 * 提交编辑：以"进入编辑时读到的那一版"为基准做 CAS 写回（T2.01）。
 *
 * ★ 三条失败路径**统一处理**成"留下草稿 + 重开编辑态还给他"：
 *   写不进去的具体原因不重要，用户打过的字不能因为一次权限错误就没了。
 *   唯一例外是写成功 —— 那时把草稿删掉，卡片会由 `watch` 自己刷成新内容。
 *
 * ★ 这里不校验 `el` 上的 token：`onSubmit` 之后编辑器必定先走了 `onExit`，
 *   显示态的重绘早就把 token 翻过一轮了，拿它判断只会永远为真。
 *   恢复编辑态走的是 `card.id`，与槽位元素是否被复用无关。
 */
async function commit(
  card: CardOfType<'noteRef'>,
  notes: VaultBridge,
  ctx: CardRenderContext,
  base: string,
  value: string,
): Promise<void> {
  const result = await notes.writeIfUnchanged(card.content.path, base, value);
  if (result === 'written') {
    pendingDrafts.delete(card.id);
    return;
  }

  pendingDrafts.set(card.id, { text: value, reason: result });
  // 重新进入编辑态：`renderEditor` 会把草稿 + 提示条一起画出来。
  // 卡片若在写入期间被删掉，`enterEditMode` 会因为找不到这张卡而拒绝，不会留下坏状态
  ctx.setMode('edit');
}

/**
 * 草稿提示条：一条说明 + 一个"丢弃"出口。
 *
 * ★ 必须有出口。一个只能在"重新落盘成功"之后才消失的警告，遇上用户已经不想保留
 *   那份改动（比如他其实是想把文件删了重写）时就是个死结。
 */
function conflictBar(doc: Document, pending: PendingDraft, onDiscard: () => void): HTMLElement {
  const bar = doc.createElement('div');
  bar.className = 'nestboard-note-ref-conflict';
  // 提示条会被读屏念出来（无障碍，02 §7）
  bar.setAttribute('role', 'status');

  const text = doc.createElement('span');
  text.className = 'nestboard-note-ref-conflict-text';
  text.textContent = t(DRAFT_MESSAGE[pending.reason]);
  bar.appendChild(text);

  const discard = doc.createElement('button');
  discard.type = 'button';
  discard.className = 'nestboard-note-ref-discard';
  discard.textContent = t('card.noteRef.discard');
  // 按钮长在卡片里：不拦下 pointer 事件的话，按下去会先被卡片层的拖动手势接管，
  // 变成"拖着卡片跑"而不是"点按钮"
  discard.addEventListener('pointerdown', (event) => event.stopPropagation());
  discard.addEventListener('click', (event) => {
    event.stopPropagation();
    onDiscard();
  });
  bar.appendChild(discard);

  return bar;
}
