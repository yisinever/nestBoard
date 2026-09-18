/**
 * 轻量 Markdown 编辑器（T1.33 / `F2.1`）—— **"编辑一段 Markdown"的公共实现**。
 *
 * ★ 它在 `06 §7.4` 里从 `cards/editor/` 搬到了 `src/editor/`（P4）：
 *   白板卡片与**脑图节点内容区**都要用它，而 `src/mind/**` 不许 import 白板的
 *   `cards/**`（eslint 钉着）—— 两边都要用的东西只能住在共享层
 *   （与 `Viewport` 搬到 `canvas/` 同一条理由）。调用方只有三件事：
 *   `host` / `value` / 两个回调，**不需要注入任何桥**。
 *
 * ── 为什么是 textarea，而不是 contenteditable ────────────────
 *
 * 卡片内容要原样写进 `.nboard`，**源码就是唯一的真相**。用 `<textarea>` 直接编辑源码：
 *
 *   * 输入法（中文 / 日文）零特殊处理 —— contenteditable 的组词、光标、撤销全是坑；
 *   * 原生撤销栈、原生文本选择、原生无障碍能力全部免费拿到；
 *   * 显示态另有 Obsidian 的 `MarkdownRenderer` 负责，编辑器不必懂 Markdown AST。
 *
 * 代价是做不了"行首标记就地变标题字号"这类**行内重排**（textarea 是一整块文本）。
 * 那是 CodeMirror 级别的活，不属于本 Sprint 的"轻量"。
 *
 * ── 那"行首快捷输入 → 实时转换"落在哪（`01 F2.1`） ────────
 *
 * 落在**输入规则**上 —— 敲完标记立刻规范化，用户看到的就是转换结果：
 *
 * | 敲入 | 立即变成 | 理由 |
 * |---|---|---|
 * | `* ` / `+ ` | `- ` | `- ` 是无序列表的唯一规范写法 |
 * | `1) ` | `1. ` | 有序列表统一用 `.` |
 * | `[ ] ` / `[x] ` | `- [ ] ` / `- [x] ` | 待办项 = 无序列表 + 复选框 |
 * | `####### ` | `###### ` | 标题最多 6 级，多写的 `#` 会被当成正文 |
 *
 * 再加四条**块级按键行为**，这才是"轻量编辑器"真正省事的地方：
 *
 *   1. `Enter` 续行：`- ` / `1. ` / `- [ ] ` / `> ` 之后回车自动续上标记（有序序号 +1）；
 *   2. `Enter` 退出：标记后面是空的，再回车就拆掉标记（否则列表进得去出不来）；
 *   3. `Tab` / `⇧Tab`：列表项（或多行选中）缩进 / 反缩进 2 空格；
 *   4. 在围栏内的空白行按 `Enter` 自动补上闭合围栏，代码块不用手打 ``` 收尾。
 *
 * ── 两条纪律 ────────────────────────────────────────────────
 *
 * 1. **改写走 `execCommand('insertText')`**：直接写 `textarea.value` 会清空浏览器的
 *    原生撤销栈（用户按 ⌘Z 什么都撤不回来）。`execCommand` 走原生编辑流水线，
 *    撤销栈保持连续；拿不到它、或它没生效时**回退为直接改写** —— 结果依然正确，
 *    只是丢了撤销粒度，**降级方向是安全的**。
 * 2. **围栏内一律放行**：代码块里的 `- ` 不是列表、`* ` 不是强调。识别到围栏内就只
 *    保留"空白行收尾"，其余交给浏览器默认行为。
 *
 * ★ 不 import `obsidian`：文案走 `util/i18n`，其余全是标准 DOM。纯函数
 *   （`parseLine` / `resolveInputRule` / `indentLines` / `fenceMask` …）可在 node 下直接单测。
 */

import { t } from '../util/i18n';

/** 缩进单位。Markdown 里 2 空格足够表达层级，且不会撑爆卡片宽度 */
export const INDENT_UNIT = '  ';

const FENCE = '```';

// ── 行 / 块文法（纯函数） ──────────────────────────────────────

export type BlockKind = 'plain' | 'heading' | 'bullet' | 'task' | 'ordered' | 'quote' | 'fence';

export interface LineBlock {
  kind: BlockKind;
  /** 行首缩进（原样保留，不规范化 Tab / 空格） */
  indent: string;
  /** 标记文本（不含缩进），如 `- `、`1. `、`- [ ] `、`# `、`> `、` ``` ` */
  marker: string;
  /** 正文起点（相对整行的下标）；`plain` 时等于缩进长度 */
  contentStart: number;
}

const INDENT_RE = /^[ \t]*/;
const FENCE_RE = /^(`{3,}|~{3,})/;
/** ATX 标题的标记后面必须有空白或行尾 —— `#标题` 在 CommonMark 里是正文 */
const HEADING_RE = /^#{1,6}(?=\s|$)/;
const TASK_RE = /^([-*+])\s+\[([ xX])\]\s+/;
const BULLET_RE = /^([-*+])\s+/;
const ORDERED_RE = /^(\d{1,9})[.)]\s+/;
const QUOTE_RE = /^>\s?/;

/** 解析一行文本的行首块结构。识别不出来就是 `plain` */
export function parseLine(line: string): LineBlock {
  const indent = INDENT_RE.exec(line)?.[0] ?? '';
  const rest = line.slice(indent.length);
  const base = indent.length;
  const block = (kind: BlockKind, marker: string): LineBlock => ({
    kind,
    indent,
    marker,
    contentStart: base + marker.length,
  });

  const fence = FENCE_RE.exec(rest);
  if (fence) return block('fence', fence[0]);

  const heading = HEADING_RE.exec(rest);
  if (heading) {
    // 标记连同它后面那个空格一起算：`# ` 的正文从空格之后开始
    const marker = rest.slice(0, heading[0].length) + (rest[heading[0].length] === ' ' ? ' ' : '');
    return block('heading', marker);
  }

  const task = TASK_RE.exec(rest);
  if (task) return block('task', task[0]);

  const bullet = BULLET_RE.exec(rest);
  if (bullet) return block('bullet', bullet[0]);

  const ordered = ORDERED_RE.exec(rest);
  if (ordered) return block('ordered', ordered[0]);

  const quote = QUOTE_RE.exec(rest);
  if (quote) return block('quote', quote[0]);

  return block('plain', '');
}

/**
 * 每行是否处于**代码围栏内部**。
 *
 * 开标记行算"外部"（它自己还要参与 ` ``` ` 的展开规则），闭标记行算"内部"
 * （它同样不该被套上列表续行）。这个划分让 `handleEnter` 只需一次判断就能分流。
 */
export function fenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let open: { char: string; length: number } | null = null;

  for (const line of lines) {
    const marker = FENCE_RE.exec(line.trimStart())?.[0];
    if (!open) {
      if (marker) open = { char: marker[0], length: marker.length };
      mask.push(false);
      continue;
    }
    mask.push(true);
    if (marker && marker[0] === open.char && marker.length >= open.length) open = null;
  }
  return mask;
}

export function splitLines(value: string): string[] {
  return value.split('\n');
}

export interface LineLocation {
  /** 行下标（从 0 起） */
  index: number;
  /** 该行首字符在整段文本中的下标 */
  start: number;
  /** 该行末字符（不含 `\n`）的下标 */
  end: number;
}

/**
 * 定位光标落在哪一行。每次按键都会跑一遍，所以是 O(n) ——
 * 便签正文在 10KB 量级，实测远低于 `02 §8.1` 的 50ms 预算；
 * 只有变成"整块白板一个文本"时才有必要换成增量维护。
 */
export function locateLine(value: string, offset: number): LineLocation {
  const clamped = Math.max(0, Math.min(offset, value.length));
  let index = 0;
  let start = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (value[i] === '\n') {
      index += 1;
      start = i + 1;
    }
  }
  const next = value.indexOf('\n', start);
  return { index, start, end: next === -1 ? value.length : next };
}

/** 取出 `[start, end]` 覆盖到的所有行 */
export function affectedLines(value: string, start: number, end: number): string[] {
  const first = locateLine(value, start);
  const last = locateLine(value, end);
  return splitLines(value).slice(first.index, last.index + 1);
}

/** 标记后面没内容了 —— 回车时应当"退出列表"而不是继续 */
export function isBlankItem(line: string, block: LineBlock): boolean {
  switch (block.kind) {
    case 'bullet':
    case 'task':
    case 'ordered':
    case 'quote':
      return line.slice(block.contentStart).trim() === '';
    default:
      return false;
  }
}

/** 回车续行时新行要带的前缀；`null` 表示这个块不续行 */
export function nextLineMarker(block: LineBlock): string | null {
  switch (block.kind) {
    case 'bullet':
      return `${block.indent}- `;
    case 'task':
      // 已勾选的项后面跟着的必定是个新任务，所以固定回未勾选
      return `${block.indent}- [ ] `;
    case 'ordered': {
      const current = Number.parseInt(block.marker, 10);
      return `${block.indent}${(Number.isFinite(current) ? current : 0) + 1}. `;
    }
    case 'quote':
      return `${block.indent}> `;
    default:
      return null;
  }
}

/** 行首输入规则：`prefix` = 行首到光标之间的文本（**不含**刚按下的那个空格） */
const INPUT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^([ \t]*)\*$/, '$1- '],
  [/^([ \t]*)\+$/, '$1- '],
  [/^([ \t]*)(\d{1,9})\)$/, '$1$2. '],
  [/^([ \t]*)\[ \]$/, '$1- [ ] '],
  [/^([ \t]*)\[x\]$/i, '$1- [x] '],
  [/^([ \t]*)(#{7,})$/, '$1###### '],
];

/**
 * 命中规则时返回**替换 `[行首, 光标)` 的文本**（含用户刚敲的空格），否则 `null`。
 *
 * 规则要求整段前缀就是标记本身，所以行中间的 `* ` 不会被误伤（`abc* ` 不匹配）。
 */
export function resolveInputRule(prefix: string): string | null {
  for (const [pattern, replacement] of INPUT_RULES) {
    if (pattern.test(prefix)) return prefix.replace(pattern, replacement);
  }
  return null;
}

export interface EditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function stripIndent(line: string, unit: string): string {
  if (line.startsWith('\t')) return line.slice(1);
  if (line.startsWith(unit)) return line.slice(unit.length);
  if (line.startsWith(' ')) return line.slice(1);
  return line;
}

/** 给选区覆盖到的每一行加一级缩进，并让选区跟着一起右移 */
export function indentLines(
  value: string,
  start: number,
  end: number,
  unit: string = INDENT_UNIT,
): EditResult {
  const first = locateLine(value, start);
  const last = locateLine(value, end);
  const lines = splitLines(value).map((line, i) =>
    i >= first.index && i <= last.index ? unit + line : line,
  );

  const count = last.index - first.index + 1;
  return {
    value: lines.join('\n'),
    selectionStart: start + unit.length,
    selectionEnd: end + unit.length * count,
  };
}

/** 反缩进：每行最多去掉一级，已经是顶格的行原样保留 */
export function outdentLines(
  value: string,
  start: number,
  end: number,
  unit: string = INDENT_UNIT,
): EditResult {
  const first = locateLine(value, start);
  const last = locateLine(value, end);

  let firstShift = 0;
  let totalShift = 0;
  const lines = splitLines(value).map((line, i) => {
    if (i < first.index || i > last.index) return line;
    const stripped = stripIndent(line, unit);
    const removed = line.length - stripped.length;
    if (i === first.index) firstShift = removed;
    totalShift += removed;
    return stripped;
  });

  return {
    value: lines.join('\n'),
    selectionStart: Math.max(first.start, start - firstShift),
    selectionEnd: Math.max(first.start, end - totalShift),
  };
}

/**
 * `Tab` 是否该被编辑器吃掉。
 *
 * 单行的普通段落**不吃** —— Tab 在那边是"把焦点移走"的无障碍通道，
 * 而 PDF 大纲式的"随处 Tab 插缩进"会把键盘用户困在编辑器里（`01 P5`）。
 */
export function shouldIndentOnTab(value: string, start: number, end: number): boolean {
  const first = locateLine(value, start);
  const last = locateLine(value, end);
  if (last.index > first.index) return true;
  return parseLine(splitLines(value)[first.index] ?? '').kind !== 'plain';
}

/** `⇧Tab`：只要覆盖的行里有一行带缩进就接管，否则让浏览器把焦点送回上一个控件 */
export function shouldOutdentOnTab(value: string, start: number, end: number): boolean {
  return affectedLines(value, start, end).some((line) => /^[ \t]/.test(line));
}

// ── 编辑器本体 ────────────────────────────────────────────────

export interface MiniMarkdownEditorOptions {
  /** 挂载宿主（卡片内容槽）。编辑器只往里放一块 textarea */
  host: HTMLElement;
  /** 初始源码 */
  value: string;
  /** 内容确有改动时提交（未改动不会调用，避免"点进点出"把文件标脏） */
  onSubmit: (value: string) => void;
  /** 请求退出编辑态：提交、取消、失焦都会各调用一次 */
  onExit: () => void;
  /**
   * 失焦时**先问一句**："这一下算离开编辑吗"（O02）。
   *
   * 默认（不传）= 老规矩：失焦即提交并退出。待办卡的编辑态里有两个输入框
   * （标题 + 清单），从清单点到标题只是**换了一格**，而默认行为会先提交
   * —— 提交的约定是"这次编辑到此为止"（`BoardView.updateCardContent` 会顺手
   * 清掉编辑态），用户看到的就是"点一下标题，清单没了"。
   *
   * ★ 返回 `true` 时**既不提交也不退出**：内容原地留着，交给这次编辑真正的
   *   收口处（那边会把两格合并成一次 patch —— 见 `cards/todo.ts` 的收口表）。
   */
  keepEditingOnBlur?: (event: FocusEvent) => boolean;
}

/**
 * 把一块 textarea 变成"带块级行为的 Markdown 源码编辑器"。
 *
 * 它同时是**编辑会话**的主人：聚焦、提交、取消都由它在这里收口，
 * 卡片定义只负责接线（`onSubmit → ctx.updateContent` / `onExit → ctx.setMode`）。
 * 这样待办卡（T3.01）等其它需要编辑正文的类型可以原样复用。
 */
export class MiniMarkdownEditor {
  private readonly host: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly initial: string;
  private readonly onSubmit: (value: string) => void;
  private readonly onExit: () => void;
  private readonly keepEditingOnBlur?: (event: FocusEvent) => boolean;
  /** 提交只认第一次：Esc 之后 DOM 被换掉还会补一个 blur 上来 */
  private finished = false;

  constructor(options: MiniMarkdownEditorOptions) {
    this.host = options.host;
    this.initial = options.value;
    this.onSubmit = options.onSubmit;
    this.onExit = options.onExit;
    this.keepEditingOnBlur = options.keepEditingOnBlur;

    const textarea = this.host.ownerDocument.createElement('textarea');
    textarea.className = 'nestboard-mde-input';
    textarea.value = options.value;
    // 卡片正文不需要拼写检查：满屏红波浪线比错字更干扰（Obsidian 的编辑区同样关掉）
    textarea.spellcheck = false;
    if (options.value.trim().length === 0) textarea.placeholder = t('card.note.placeholder');
    this.host.appendChild(textarea);
    this.textarea = textarea;

    // 只挂在这块 textarea 上：它随内容槽一起被清掉，不需要额外的 dispose 通道
    textarea.addEventListener('keydown', this.onKeyDown);
    textarea.addEventListener('blur', this.onBlur);
  }

  /** 聚焦并把光标放到末尾。延迟一轮微任务：渲染时节点还没进文档，立刻 focus 会被抢走 */
  focus(): void {
    queueMicrotask(() => {
      if (this.finished) return;
      const el = this.textarea;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }

  /** 当前源码（给外部读取用） */
  get value(): string {
    return this.textarea.value;
  }

  // ── 按键分流 ────────────────────────────────────────────────

  private readonly onBlur = (event: FocusEvent): void => {
    // 焦点只是挪到了**同一张卡里的另一格**（待办卡的标题框）：这一下既不是提交、
    // 也不是离开 —— 整张卡什么时候收口由卡片自己说了算（O02）
    if (this.keepEditingOnBlur?.(event) === true) return;
    this.finish();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // 输入法组词中：此时的按键不代表最终文本，任何改写都会打断候选词
    if (event.isComposing || event.keyCode === 229) return;

    const { key, metaKey, ctrlKey, shiftKey, altKey } = event;

    if (key === 'Escape') {
      // 编辑态的 Esc 归输入框：不能再往上传，否则画布的状态机会把它当成"清空选区"
      event.stopPropagation();
      event.preventDefault();
      this.finish();
      return;
    }

    if (key === 'Enter' && (metaKey || ctrlKey)) {
      event.preventDefault();
      this.finish();
      return;
    }

    // ⌘Z / ⌘A / ⌘C 等一律交给浏览器原生行为，编辑器不参与
    if (metaKey || ctrlKey) return;

    if (key === 'Enter' && !shiftKey && !altKey) {
      if (this.handleEnter()) event.preventDefault();
      return;
    }

    if (key === 'Tab') {
      if (this.handleTab(shiftKey)) event.preventDefault();
      return;
    }

    if (key === ' ' && this.applyInputRule()) event.preventDefault();
  };

  /** `Shift+Enter` 是软换行，交默认行为 —— 列表项里插一行不断列表就靠它 */
  private handleEnter(): boolean {
    const el = this.textarea;
    const { selectionStart, selectionEnd } = el;
    if (selectionStart !== selectionEnd) return false;

    const value = el.value;
    const lines = splitLines(value);
    const loc = locateLine(value, selectionStart);
    const line = lines[loc.index] ?? '';
    const block = parseLine(line);

    if (fenceMask(lines)[loc.index]) {
      // 代码块里只剩一条便捷操作：空白行且其后无内容 → 这一行直接变成闭合围栏。
      // 不做"任意空白行都收尾"：那会把用户代码里有意留的空行截断成两个块
      if (line.trim() === '' && value.slice(loc.end).trim() === '') {
        this.replaceRange(loc.start, loc.end, `${block.indent}${FENCE}`);
        return true;
      }
      return false;
    }

    if (isBlankItem(line, block)) {
      // 空标记再回车 = 退出列表：拆掉标记，光标停在缩进之后
      this.replaceRange(loc.start, selectionStart, block.indent);
      return true;
    }

    const marker = nextLineMarker(block);
    if (marker === null) return false;

    // 只带上标记，行内剩下的内容由浏览器正常换行处理
    this.replaceRange(selectionStart, selectionStart, `\n${marker}`);
    return true;
  }

  private handleTab(shift: boolean): boolean {
    const el = this.textarea;
    const { value, selectionStart, selectionEnd } = el;

    if (shift) {
      if (!shouldOutdentOnTab(value, selectionStart, selectionEnd)) return false;
      this.applyEdit(outdentLines(value, selectionStart, selectionEnd, INDENT_UNIT));
      return true;
    }

    if (!shouldIndentOnTab(value, selectionStart, selectionEnd)) return false;
    this.applyEdit(indentLines(value, selectionStart, selectionEnd, INDENT_UNIT));
    return true;
  }

  private applyInputRule(): boolean {
    const el = this.textarea;
    const { selectionStart, selectionEnd } = el;
    if (selectionStart !== selectionEnd) return false;

    const value = el.value;
    const loc = locateLine(value, selectionStart);
    // 围栏内不是 Markdown：代码里的 `* ` 就是两个字符
    if (fenceMask(splitLines(value))[loc.index]) return false;

    const replacement = resolveInputRule(value.slice(loc.start, selectionStart));
    if (replacement === null) return false;

    this.replaceRange(loc.start, selectionStart, replacement);
    return true;
  }

  // ── 文本改写 ────────────────────────────────────────────────

  /** 替换 `[start, end)` 并把光标放到插入内容之后 */
  private replaceRange(start: number, end: number, text: string): void {
    const el = this.textarea;
    el.setSelectionRange(start, end);
    if (this.insertText(text)) {
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
      return;
    }

    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
  }

  /** 整体替换 + 还原选区（`Tab` 缩进一次就是一步撤销，而不是按行碎成好几步） */
  private applyEdit(result: EditResult): void {
    const el = this.textarea;
    el.setSelectionRange(0, el.value.length);
    if (!this.insertText(result.value)) el.value = result.value;
    el.setSelectionRange(result.selectionStart, result.selectionEnd);
  }

  /**
   * 走浏览器原生编辑流水线插入文本，保留撤销栈。
   *
   * 用"文本是否真的变了"作为成功判据：`execCommand` 在元素失焦等情况下会返回
   * `true` 却什么都不做，只看返回值会静默丢字。
   */
  private insertText(text: string): boolean {
    const el = this.textarea;
    const doc = el.ownerDocument as Document & {
      execCommand?: (command: string, ui?: boolean, value?: string) => boolean;
    };
    if (typeof doc.execCommand !== 'function') return false;

    const before = el.value;
    if (!doc.execCommand('insertText', false, text)) return false;
    return el.value !== before;
  }

  // ── 编辑会话 ────────────────────────────────────────────────

  private finish(): void {
    if (this.finished) return;
    this.finished = true;

    const value = this.textarea.value;
    // 没改就不写：否则每次点进点出都会递增 revision、把文件标脏
    if (value !== this.initial) this.onSubmit(value);
    this.onExit();
  }
}
