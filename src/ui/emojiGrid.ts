/**
 * emoji **网格**（`C3`，用户 2026-09-18："标记调整，支持目前的 emoji，界面美化"）。
 *
 * ── 它替换掉的那一版 ─────────────────────────────────────────
 *
 * 白板的图标选择器从前是 `SuggestModal` + 一行一个的清单：一列文字长得都差不多，
 * 找一个"🔵"要在一列里扫。同一份数据在**脑图**那边却是**按类分组**的
 * （`EMOJI_GROUPS` 就是为它挑的，`08 §3.1`）—— 同一个东西两种待遇，说明缺的只是呈现。
 * 现在两处共用这一份分组数据，网格摆在那一列的位置上。
 *
 * ── 三条设计取舍 ────────────────────────────────────────────
 *
 * 1. **不 import `obsidian`、不碰视图**：本文件只把分组数据画成 DOM。
 *    于是"哪些格子被过滤掉了""当前选中的那个有没有被标出来"都能在假 DOM 下单测
 *    （模态框那层反而测不了 —— 它一 import 就离不了真实运行时）。
 * 2. **输入框的两种含义**（与 `emojiSuggestions` 同一条口径）：
 *    输入框里是**一个 emoji** ⇒ 最前面钉一格"就是它"（系统表情面板挑出来的必须选得中）；
 *    是**文字** ⇒ 按分组标题过滤（"时间""办公"都能把那一组筛出来）。
 *    ★ 两种都不是（比如打了一串没人匹配的字）⇒ **照旧显示全部**：
 *      让人对着一片空白猜"我是不是打错了"，比多看到几行更难受。
 * 3. **当前已选的那一格用一圈选中环标出来**，而不是列表里的 `✓` 前缀 ——
 *    网格里加一个字会把那一格撑变形，整片对齐就毁了。
 */

import { EMOJI_GROUPS, normalizeIcon, type EmojiGroupKey } from '../util/emoji';

/** 一个"像 emoji"的判断：含扩展象形字符（`😀` / `🔵` / `✅`…） */
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

export interface EmojiGridOptions {
  /** 当前已选的那个（空串 / 不给 = 没选） */
  current?: string;
  /** 分组标题（**已经翻译过**的）。标题由调用方给，本文件不认识 i18n */
  titleOf: (key: EmojiGroupKey) => string;
  onPick: (emoji: string) => void;
}

export interface EmojiGridHandle {
  /** 网格根节点（调用方负责插进自己的容器） */
  element: HTMLElement;
  /** 按输入框的内容重算可见性（空串 = 全部可见） */
  filter(query: string): void;
}

interface GroupView {
  key: EmojiGroupKey;
  /** 整组的外壳（标题 + 网格）：过滤时整体显示 / 隐藏 */
  section: HTMLElement;
  /** 标题文本（按它做文字过滤） */
  title: string;
}

export function buildEmojiGrid(doc: Document, options: EmojiGridOptions): EmojiGridHandle {
  const root = doc.createElement('div');
  root.className = 'nestboard-emoji-panel';

  /**
   * 钉在最前面那一格（输入框里是一个 emoji 时才有）。
   *
   * ★ 建一次、**一直留在 DOM 里**：每敲一个字都重造节点会让输入框失去焦点（光标跳走），
   *   而"边打边筛"恰恰要求焦点一直待在输入框里。不可见时靠 `.is-hidden` 收掉。
   * ★ 先建（先挂）在组之前：它要出现在**最前面**，而 DOM 顺序就决定了视觉顺序 ——
   *   不靠 CSS 的 `order` 去把它"提"上来。
   */
  const pinned = buildCell(doc, '', options);
  pinned.classList.add('is-pinned');
  pinned.classList.add('is-hidden');
  root.appendChild(pinned);

  const groups: GroupView[] = [];

  for (const group of EMOJI_GROUPS) {
    const title = options.titleOf(group.key);
    const section = doc.createElement('section');
    section.className = 'nestboard-emoji-section';
    section.dataset.group = group.key;

    const heading = doc.createElement('div');
    heading.className = 'nestboard-emoji-group-title';
    heading.textContent = title;
    section.appendChild(heading);

    const grid = doc.createElement('div');
    grid.className = 'nestboard-emoji-grid';
    for (const emoji of group.emojis) {
      grid.appendChild(buildCell(doc, emoji, options));
    }
    section.appendChild(grid);
    root.appendChild(section);
    groups.push({ key: group.key, section, title });
  }

  const filter = (query: string): void => {
    const typed = normalizeIcon(query);

    if (typed.length === 0) {
      pinned.classList.add('is-hidden');
      for (const group of groups) group.section.classList.remove('is-hidden');
      return;
    }

    // ① 输入框里是一个 emoji ⇒ 钉一格"就是它"（清单里有没有都选得中）
    const asEmoji = PICTOGRAPHIC_RE.test(typed);
    if (asEmoji) {
      applyCell(pinned, typed, options.current);
      pinned.classList.remove('is-hidden');
    } else {
      pinned.classList.add('is-hidden');
    }

    // ② 按**分组标题**过滤；一条都没匹配上就照旧显示全部（见文件头第 2 条）
    const matched = groups.filter((group) => group.title.includes(typed));
    const visible = matched.length > 0 ? new Set(matched.map((group) => group.key)) : null;
    for (const group of groups) {
      // ★ 钉着的那一格本身就来自输入框：此时把清单全留出来，用户才看得到"还能挑别的"
      const show = visible === null ? true : visible.has(group.key);
      group.section.classList.toggle('is-hidden', !show);
    }
  };

  filter('');

  return { element: root, filter };
}

/** 建一格（点击 = 选中；指针按下时挡住冒泡，别让它变成拖卡片 / 拖节点） */
function buildCell(doc: Document, emoji: string, options: EmojiGridOptions): HTMLElement {
  const cell = doc.createElement('button');
  cell.type = 'button';
  cell.className = 'nestboard-emoji-cell';
  applyCell(cell, emoji, options.current);
  cell.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  cell.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    const value = cell.textContent ?? '';
    if (value.length > 0) options.onPick(value);
  });
  return cell;
}

/** 把某一格设成某个 emoji（并更新"当前选中"那一圈） */
function applyCell(cell: HTMLElement, emoji: string, current?: string): void {
  cell.textContent = emoji;
  cell.classList.toggle('is-current', emoji.length > 0 && emoji === current);
}
