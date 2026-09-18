/**
 * 评论卡（T7.05 / `F2.9`）—— **本地备注线程**。
 *
 * ── 一张卡 = 一条线程 ──────────────────────────────────────────
 *
 * | 模式 | 渲染 | 交互 |
 * |---|---|---|
 * | `display` | 逐条（时间 + 正文）；空线程给一句引导 | 底部「写一条备注」→ 进编辑态 |
 * | `edit` | 同上 + 每条一个「×」+ 底部输入框 | `Enter` 提交、`Shift+Enter` 换行、`Esc` 退出 |
 *
 * ★ **输入法组词期间不接管按键**：那时的 `Enter` / `Esc` 属于候选词窗口（确认 / 取消），
 *   不属于这张卡（与 `MiniMarkdownEditor` 同一条守卫）。
 *
 * ★ **写入只有两种：追加一条、删掉一条。** 正文不交给 `MiniMarkdownEditor`
 *   （与待办卡相反）：待办卡的内容是"一份文档"，整篇改写是常态；而这里的每一条
 *   一旦写下就带着时间戳，整篇改写等于"时间线上的一句话变成另一句话"。
 *   把写入收敛成两个动作之后，"条目顺序 = 时间顺序"这条不变式不用维护就成立。
 *
 * ★ 显示态**不放常驻输入框**，只放一行「写一条备注」：一个 textarea 会把卡片
 *   下半张脸的拖拽区吃掉，而写备注是偶尔为之的动作。点它才进编辑态、才出现输入框
 *   并自动聚焦 —— 与便签卡"双击才出现编辑器"是同一条取舍。于是"双击这张卡"
 *   与"点那行入口"落到同一个结果上：光标已经在新备注里等着了。
 *
 * ★ `resolved` 只在卡面上**显示**（角标 + 置灰），切换它的入口在卡片右键菜单
 *   （`action: 'toggleCommentResolved'` → 视图改内容）。理由与同步便签的"取消同步"
 *   一样：写内容的能力只有视图有，而卡片定义只描述"菜单里有什么"。
 *
 * ★ 不 import `obsidian`：Markdown 渲染由 `CardRenderContext.renderMarkdown` 注入，
 *   所以本文件的追加 / 删除 / 时间格式化与渲染判定都能在 node 下直接单测。
 */

import { ID_PREFIX } from '../constants';
import type { CommentContent, CommentEntry } from '../model/schema';
import type { Size } from '../util/geometry';
import { createId } from '../util/id';
import { t } from '../util/i18n';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 新建评论卡的默认尺寸（与 `model/factories.ts` 的 `DEFAULT_CARD_SIZES.comment` 一致） */
export const COMMENT_DEFAULT_SIZE: Size = { width: 300, height: 200 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（否则污染复用池节点） */
const COMMENT_CLASSES = [
  'nestboard-comment',
  'nestboard-comment-display',
  'nestboard-comment-edit',
  'is-empty',
  'is-resolved',
] as const;

// ─────────────────────────────────────────────────────────────
// 纯逻辑（可单测）
// ─────────────────────────────────────────────────────────────

/**
 * 造一条备注。
 *
 * `at` 可注入**只为可测试性**（与 `util/id.ts` 的 `createId` 同一套约定）：
 * 生产代码永远走默认值，测试才断言得了"时间戳真的被记住了"而没有 `Date.now()` 抖动。
 */
export function createCommentEntry(text: string, at: number = Date.now()): CommentEntry {
  return { id: createId(ID_PREFIX.comment, at), text, at };
}

/**
 * 追加一条。
 *
 * ★ **空 / 纯空白不落条目**：那只会得到一条读不出内容、也点不中的空行。
 * ★ 返回**新数组**（不就地 `push`）：卡片内容对象是不共享的，就地改会让
 *   "内容指纹变没变"分不清 —— 而重绘与否正是看它。
 */
export function appendCommentEntry(
  entries: readonly CommentEntry[],
  text: string,
  at: number = Date.now(),
): CommentEntry[] {
  const body = text.trim();
  if (body.length === 0) return [...entries];
  return [...entries, createCommentEntry(body, at)];
}

/** 删掉某一条。按 `id` 而不是下标 —— 下标在"删掉一条"之后就整体错位了 */
export function removeCommentEntry(entries: readonly CommentEntry[], id: string): CommentEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * `at` → 卡面上那一行小字 `09-13 10:05`（**本地时间**）。
 *
 * ★ 不用 `toLocaleString`：它跟着系统语言与区域变（同一份数据在两台机器上长得不一样），
 *   而这里要的只是"什么时候写的"这一个事实。要完整时间就悬停看
 *   {@link formatCommentTimeFull}。规矩与 `io/AttachmentManager.timestampPrefix` 一致。
 */
export function formatCommentTime(at: number): string {
  const when = new Date(at);
  const date = `${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return `${date} ${time}`;
}

/** 完整时间 `2026-09-13 10:05`：卡面放不下，挂在悬停提示与 Markdown 导出上 */
export function formatCommentTimeFull(at: number): string {
  return `${new Date(at).getFullYear()}-${formatCommentTime(at)}`;
}

/** 时间戳读不出来（`at <= 0`，见 `model/validate.ts`）时卡面上写什么 */
export function commentTimeLabel(at: number): string {
  return at > 0 ? formatCommentTime(at) : t('card.comment.unknownTime');
}

// ─────────────────────────────────────────────────────────────
// 卡片定义
// ─────────────────────────────────────────────────────────────

export const commentCard: CardTypeDefinition<'comment'> = {
  type: 'comment',

  get displayName(): string {
    return t('card.type.comment');
  },

  icon: 'message-square',
  defaultSize: COMMENT_DEFAULT_SIZE,
  // ★ 落卡**不进**编辑态（O13）：新评论是一张空线程，而编辑态会吃掉下半张脸的
  //   拖拽区 —— 刚放下就拖不动，是这一条 bug 的原话。右键 / 双击照样能写。
  autoEditOnCreate: false,

  createDefaultContent(): CommentContent {
    return { entries: [], resolved: false };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-comment');
    el.classList.remove(
      'nestboard-comment-display',
      'nestboard-comment-edit',
      'is-empty',
      'is-resolved',
    );
    delete el.dataset.placeholder;
    delete el.dataset.commentBadge;

    // 「已解决」是**内容**决定的，两种模式都得看得出来（与同步便签的角标同一个道理）。
    // 角标文案走 `data-*` + CSS `content: attr(...)`：它是装饰，不该进无障碍树
    if (card.content.resolved) {
      el.classList.add('is-resolved');
      el.dataset.commentBadge = t('card.comment.resolved');
    }

    if (ctx.mode === 'edit') renderEditor(el, card.content, ctx);
    else renderDisplay(el, card.content, ctx);
  },

  contextMenu(card, ctx) {
    const { resolved } = card.content;
    return [
      {
        id: 'toggle-comment-resolved',
        title: resolved ? t('menu.card.commentReopen') : t('menu.card.commentResolve'),
        icon: resolved ? 'rotate-ccw' : 'check-square',
        // 多选下"解决"说不清是哪一条线程 —— 与便签卡"编辑内容"同一条置灰规矩
        disabled: ctx.multiple,
        action: 'toggleCommentResolved',
      },
    ];
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...COMMENT_CLASSES);
    delete el.dataset.placeholder;
    delete el.dataset.commentBadge;
    el.replaceChildren();
  },

  toMarkdown(card): string {
    return card.content.entries
      .map((entry) =>
        entry.at > 0 ? `- ${formatCommentTimeFull(entry.at)} ${entry.text}` : `- ${entry.text}`,
      )
      .join('\n');
  },
};

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

/** 显示态：线程 + 一行「写一条备注」入口 */
function renderDisplay(el: HTMLElement, content: CommentContent, ctx: CardRenderContext): void {
  el.classList.add('nestboard-comment-display');
  const doc = el.ownerDocument;
  const nodes: Node[] = [];

  if (content.entries.length === 0) {
    // 空线程给一句引导，而不是一片"这张卡坏了"似的空白
    el.classList.add('is-empty');
    el.dataset.placeholder = 'true';
    const empty = doc.createElement('div');
    empty.className = 'nestboard-comment-empty';
    empty.textContent = t('card.comment.empty');
    nodes.push(empty);
  } else {
    nodes.push(buildThread(doc, content, ctx, false));
  }

  nodes.push(buildAddEntry(doc, ctx));
  el.replaceChildren(...nodes);
}

/** 编辑态：线程（每条带「×」）+ 输入框（自动聚焦） */
function renderEditor(el: HTMLElement, content: CommentContent, ctx: CardRenderContext): void {
  el.classList.add('nestboard-comment-edit');
  const doc = el.ownerDocument;

  const input = doc.createElement('textarea');
  input.className = 'nestboard-comment-input';
  input.rows = 1;
  input.placeholder = t('card.comment.placeholder');
  input.setAttribute('aria-label', t('card.comment.placeholder'));

  const submit = (): void => {
    const next = appendCommentEntry(content.entries, input.value);
    // 空 / 纯空白：什么都没变，也就不该让卡片白重画一次
    if (next.length === content.entries.length) return;
    ctx.updateContent({ entries: next });
  };

  // 输入框里的按下不能冒泡给画布，否则拖不动光标、只会拖整张卡（与待办卡的复选框同规矩）
  input.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  input.addEventListener('click', (event: Event) => event.stopPropagation());
  input.addEventListener('keydown', (event: Event) => {
    const key = event as KeyboardEvent;
    // ★ 输入法组词中一律放行（与 `MiniMarkdownEditor` / 色板卡同一条守卫）：
    //   此刻的 `Enter` 是在**确认候选词**、`Esc` 是在**取消候选词**，
    //   抢过来会变成"打个中文字，候选词一确认就替用户提交了"。
    if (key.isComposing || key.keyCode === 229) return;
    if (key.key === 'Escape') {
      // `Esc` = 这条不写了；草稿随重绘一起消失（与 `MiniMarkdownEditor` 的取消同义）
      key.preventDefault();
      key.stopPropagation();
      ctx.setMode('display');
      return;
    }
    // `Enter` 提交、`Shift+Enter` 换行 —— 与聊天输入框一致：一行的空间里 Shift 是分行键
    if (key.key === 'Enter' && !key.shiftKey) {
      key.preventDefault();
      key.stopPropagation();
      submit();
    }
  });

  el.replaceChildren(buildThread(doc, content, ctx, true), input);
  input.focus();
}

/** 线程本体（两种模式共用）。逐条画：时间戳 + Markdown 正文 */
function buildThread(
  doc: Document,
  content: CommentContent,
  ctx: CardRenderContext,
  editing: boolean,
): HTMLElement {
  const thread = doc.createElement('div');
  thread.className = 'nestboard-comment-thread';
  for (const entry of content.entries) {
    thread.appendChild(buildEntry(doc, entry, content, ctx, editing));
  }
  return thread;
}

function buildEntry(
  doc: Document,
  entry: CommentEntry,
  content: CommentContent,
  ctx: CardRenderContext,
  editing: boolean,
): HTMLElement {
  const row = doc.createElement('div');
  row.className = 'nestboard-comment-entry';

  const time = doc.createElement('span');
  time.className = 'nestboard-comment-time';
  time.textContent = commentTimeLabel(entry.at);
  if (entry.at > 0) time.title = formatCommentTimeFull(entry.at);

  const text = doc.createElement('div');
  text.className = 'nestboard-comment-text';
  // 异步渲染（双链要等索引），过期结果由视图注入的 `renderMarkdown` 丢弃 —— 同便签卡
  void ctx.renderMarkdown(entry.text, text);

  row.appendChild(time);
  row.appendChild(text);

  if (editing) row.appendChild(buildRemoveButton(doc, entry, content, ctx));
  return row;
}

/** 「×」：删掉这一条。只在编辑态出现 —— 删历史该是个要动手的决定 */
function buildRemoveButton(
  doc: Document,
  entry: CommentEntry,
  content: CommentContent,
  ctx: CardRenderContext,
): HTMLElement {
  const remove = doc.createElement('button');
  remove.className = 'nestboard-comment-remove';
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = t('card.comment.remove');
  remove.setAttribute('aria-label', t('card.comment.remove'));

  remove.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  remove.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    ctx.updateContent({ entries: removeCommentEntry(content.entries, entry.id) });
  });
  return remove;
}

/**
 * 显示态底部的「写一条备注」。
 *
 * ★ 它不是按钮而是**一行长得像输入框的入口**：不写内容，只把卡片切进编辑态；
 *   真正的 textarea 到那时才出现并自动聚焦。见文件头的两条取舍。
 */
function buildAddEntry(doc: Document, ctx: CardRenderContext): HTMLElement {
  const add = doc.createElement('div');
  add.className = 'nestboard-comment-add';
  add.setAttribute('role', 'button');
  add.setAttribute('tabindex', '0');
  add.textContent = t('card.comment.add');

  const enter = (event: Event): void => {
    event.stopPropagation();
    ctx.setMode('edit');
  };
  add.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  add.addEventListener('click', enter);
  add.addEventListener('keydown', (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
    event.preventDefault();
    enter(event);
  });

  return add;
}
