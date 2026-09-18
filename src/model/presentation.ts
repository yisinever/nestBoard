/**
 * 演示路径（J-06 / J-07）的**模型层**：谁在路径里、是第几步、顺序怎么调。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM。顺序规则里全是容易出错又必须回归的地方
 *   ——"步骤号有空洞时怎么办""一张都没编过时讲什么""删掉当前那张之后停在哪"——
 *   它们必须能在 node 下单测，否则这类缺陷只能靠人眼看一整遍演示才可能发现。
 * ★ "一张都没编过"时的回退顺序（`readingOrder`）也在本文件：它要认分栏，
 *   分栏是**一块**而不是"逐行扫"里的一堆散卡（理由见那个函数）。
 *
 * ★ 与相机无关：从当前视口飞到目标视口的数学在 `view/presentCamera.ts`。
 *   本文件只回答"下一步是哪张卡"，那一头只回答"怎么飞过去"。
 */

import { cardsInColumn } from './columns';
import type { BoardFile, Card } from './schema';

/**
 * 读一张卡的演示步骤号（防御性读取）。
 *
 * ★ 类型上 `presentStep` 已经是 `number | null`（`validate` 也收紧过），这里再查一遍
 *   是因为**内存里的对象不一定来自 `validate`**：撤销栈里的旧快照、手写的测试夹具
 *   都可能带着 `undefined`。一个 `undefined` 混进排序会把 `-` 算成 `NaN`，
 *   整个顺序当场乱掉 —— 那种"偶尔顺序不对"是最难查的一类。
 */
export function presentStepOf(card: Card): number | null {
  const value = card.presentStep;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 阅读顺序：先上后下、先左后右，完全重合时按 `id`。
 *
 * ★ 与 `cardLayer` 的 `z` 序不同：`z` 是**叠放**次序（后加的在上），
 *   而演示要的是"人读板子的次序"。用 `z` 讲一块排版好的板子，很可能是从
 *   最后画的那张开始 —— 与纸面上的阅读方向完全相反。
 * ★ `id` 兜底保证**排序稳定**：两张卡坐标完全相同时，顺序不能一帧一个样。
 * ★ 这是**单张卡之间**的比较函数，只在"两块的重心恰好被判定为同一行"（见
 *   `readingOrder`）以及显式步骤号撞号时用。
 */
export function compareReadingOrder(a: Card, b: Card): number {
  return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 阅读块：零配置演示顺序的**排序单位**。
 *
 * 一个分栏整体算一块（栏里几十张卡不会被拆开），没归栏的卡各算一块。
 */
interface ReadingBlock {
  /** 块的排序纵坐标（分栏取"栏上边"与"栏内最高的卡"里更靠上的那个） */
  y: number;
  /** 块的排序横坐标（分栏取栏的左边） */
  x: number;
  /** 同高同左时的兜底键，保证顺序稳定（栏用栏 id，单卡用卡 id） */
  key: string;
  cards: Card[];
}

function compareReadingBlocks(a: ReadingBlock, b: ReadingBlock): number {
  return a.y - b.y || a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * 阅读顺序（"一张都没编过"时演示讲的那一套）：**按块从上到下、从左到右**，
 * 块内再按块自己的顺序。
 *
 * ★ **分栏是一块**，不是"一张张参与全局排序"（`compareReadingOrder` 那套是**逐行扫**）：
 *   并排的两个分栏里，栏内成员是"同高一行行堆叠"的，逐行扫会得到
 *   "左栏第 1 张 → 右栏第 1 张 → 左栏第 2 张……"这种**左右横跳**的顺序 ——
 *   讲一块排好版的白板时，这正是最反直觉的那种结果。按块排则是"一栏讲完再讲下一栏"。
 * ★ 栏外的卡（含"标题卡压在所有分栏上方"、以及 `columnId` 指向一个**已不存在的栏**）
 *   按各自的位置参与块级排序：所以栏上方的标题卡会**先讲**，而不是被推到分栏后面。
 * ★ 每张卡**恰好出现一次**：先收分栏成员，剩下的卡兜底成"单卡块"——
 *   哪怕 `columnId` 是个坏值也不会把卡弄丢（丢卡＝演示里凭空少讲一张）。
 */
export function readingOrder(board: BoardFile): Card[] {
  const blocks: ReadingBlock[] = [];
  const placed = new Set<string>();

  for (const column of board.columns ?? []) {
    const members = cardsInColumn(board, column.id);
    if (members.length === 0) continue;
    for (const card of members) placed.add(card.id);
    blocks.push({
      y: Math.min(column.y, ...members.map((card) => card.y)),
      x: column.x,
      key: column.id,
      cards: members,
    });
  }

  for (const card of board.cards) {
    if (placed.has(card.id)) continue;
    blocks.push({ y: card.y, x: card.x, key: card.id, cards: [card] });
  }

  return blocks.sort(compareReadingBlocks).flatMap((block) => block.cards);
}

/**
 * 显式演示路径：设过 `presentStep` 的卡，按步骤号升序。
 *
 * ★ 同号时按阅读顺序兜底：手改文件很容易写出两张都标 `2` 的卡，
 *   不兜底的话它们的先后取决于数组顺序（也就是文件里的书写顺序）。
 */
export function explicitPresentSteps(board: BoardFile): Card[] {
  return board.cards
    .filter((card) => presentStepOf(card) !== null)
    .sort((a, b) => (presentStepOf(a) ?? 0) - (presentStepOf(b) ?? 0) || compareReadingOrder(a, b));
}

/**
 * 演示顺序。
 *
 * ★ **一张都没编过就按阅读顺序讲全部**：演示模式的常见用法是"打开板子直接开讲"，
 *   要求先逐张右键编好顺序，等于把最轻的那条路径堵死。而只要编过哪怕一张，
 *   就严格按编过的来 —— "编了一半"绝不该把剩下的一半也捎带上
 *   （用户没说它们要出现在演示里）。
 * ★ 回退走 `readingOrder`（**按块**：分栏是一块），不是逐张卡的逐行扫 ——
 *   见那个函数上的说明。
 */
export function presentationOrder(board: BoardFile): Card[] {
  const explicit = explicitPresentSteps(board);
  if (explicit.length > 0) return explicit;
  return readingOrder(board);
}

/** 追加到路径末尾时该分配的步骤号：现有最大值 + 1（一张都没有时从 1 开始） */
export function nextPresentStep(board: BoardFile): number {
  let max = 0;
  for (const card of board.cards) {
    const step = presentStepOf(card);
    if (step !== null && step > max) max = step;
  }
  return max + 1;
}

/** 把一张卡放进演示路径的指定步骤；`step` 为 `null` 时移出。无变化返回 `false` */
export function setPresentStep(board: BoardFile, cardId: string, step: number | null): boolean {
  const card = board.cards.find((item) => item.id === cardId);
  if (!card) return false;
  const next = step === null ? null : Math.max(1, Math.round(step));
  if (presentStepOf(card) === next) return false;
  card.presentStep = next;
  return true;
}

/**
 * 把若干张卡**按传入顺序追加**到演示路径末尾（已在路径里的跳过）。
 *
 * ★ 追加而不是重排：用户点"加入演示"时心里想的是"这些是下一批要讲的"，
 *   悄悄把它们插到最前面会打乱已经排好的顺序。
 */
export function addToPresentation(board: BoardFile, cardIds: readonly string[]): boolean {
  let changed = false;
  let step = nextPresentStep(board);
  for (const id of cardIds) {
    const card = board.cards.find((item) => item.id === id);
    if (!card || presentStepOf(card) !== null) continue;
    card.presentStep = step++;
    changed = true;
  }
  return changed;
}

/** 把若干张卡移出演示路径（不在路径里的跳过）。有变化返回 `true` */
export function removeFromPresentation(board: BoardFile, cardIds: readonly string[]): boolean {
  let changed = false;
  for (const id of cardIds) {
    if (setPresentStep(board, id, null)) changed = true;
  }
  return changed;
}

/** 清空整条演示路径 */
export function clearPresentSteps(board: BoardFile): boolean {
  let changed = false;
  for (const card of board.cards) {
    if (presentStepOf(card) === null) continue;
    card.presentStep = null;
    changed = true;
  }
  return changed;
}

/**
 * 把一张卡在演示路径里前移 / 后移一位（`delta` = -1 前移、+1 后移）。
 *
 * ★ 先**整体重编号成 1..n** 再交换两个值：步骤号允许有空洞或重复（手改过文件、
 *   中间删过卡），直接交换两张卡上的原值会让重复号越换越乱
 *   （两张卡都是 `2`，换完还是 `2`）。
 * ★ 到头的方向返回 `false` 而不是绕到另一端：演示顺序是一条有始有终的线，
 *   "第一张再前移就变成最后一张"会让用户彻底搞不清自己刚才改了什么。
 */
export function movePresentStep(board: BoardFile, cardId: string, delta: -1 | 1): boolean {
  const ordered = explicitPresentSteps(board);
  const index = ordered.findIndex((card) => card.id === cardId);
  if (index < 0) return false;
  const target = index + delta;
  if (target < 0 || target >= ordered.length) return false;

  ordered.forEach((card, i) => {
    card.presentStep = i + 1;
  });
  const moved = ordered[index];
  const swapped = ordered[target];
  const value = moved.presentStep;
  moved.presentStep = swapped.presentStep;
  swapped.presentStep = value;
  return true;
}

/**
 * 下一步的下标（到头**停住**，不循环）。
 *
 * ★ 不循环是刻意的：讲到末尾再按 `→` 应该"没反应"，而不是**跳回第一张** ——
 *   后者在直播里是灾难（画面突然飞回开头，而讲的人还在说最后一张的内容）。
 */
export function nextStepIndex(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(current + 1, total - 1);
}

/** 上一步的下标（到第一张停住） */
export function previousStepIndex(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(current - 1, 0);
}

/**
 * `1`~`9` 数字键 → 步骤下标（`0` 起）；超出范围或不是 1~9 返回 `null`。
 *
 * ★ 只认单个数字：`1` 是最常见的第一步，`0` 容易与"回零 / 重置"混淆，故不收。
 * ★ 返回 `null` 而不是夹到最近的一步：用户按 `7` 而只有 3 步时，
 *   跳到第 3 步会让他以为"7 就是第 3 步"。什么都不做才说得清"没有第 7 步"。
 */
export function stepIndexFromDigit(digit: string, total: number): number | null {
  if (digit.length !== 1 || digit < '1' || digit > '9') return null;
  const index = Number(digit) - 1;
  return index < total ? index : null;
}

/**
 * 当前正在讲的那张卡被删掉后，该停在哪一步。
 *
 * ★ 停在**原位**（而不是回到第一张）：删除通常意味着"这张不重要了，继续"。
 *   回第一张则会把整场演示打断 —— 而撤销一次误删之后，原位也更容易接上。
 */
export function clampStepIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(index, 0), total - 1);
}
