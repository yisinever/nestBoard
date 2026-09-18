/**
 * 白板级待办聚合（T3.03 / `F2.5`）。
 *
 * 「本白板未完成待办」浮层回答的是"这块板上还剩什么没做"，而这件事**跨卡片**：
 * 单张待办卡只知道自己那几行。聚合因此落在 model 层（纯函数、可单测），
 * 浮层只负责画。
 *
 * ★ 只聚合**当前白板**：嵌套子板是另一块板、另一份文件，它的待办属于它自己。
 *   把子板的条目混进来，用户点一条就会"跳到一个看不见的地方"（当前视图里
 *   根本没有那张卡），比没有这个列表更让人困惑。
 *
 * ★ 排序按**版面**（上 → 下、左 → 右）而不是 `board.cards` 的顺序：后者是插入顺序，
 *   与位置无关 —— 按它排会出现"列表里挨着的两条，在板上隔了一屏"。
 */

import type { BoardFile, CardOf } from './schema';

/** 一条未完成的待办（跨卡聚合后的一行） */
export interface OpenTodoEntry {
  /** 所属卡片 id（浮层据此把视口挪过去） */
  cardId: string;
  /** 卡片标题；空串 = 这张卡没有标题，显示层用自己的兜底文案 */
  cardTitle: string;
  /** 该项在 `content.items` 里的下标 —— 勾选时按它定位 */
  index: number;
  /**
   * 条目原文，**含**前导缩进。
   *
   * 缩进是 `TodoItem.text` 的存储格式（见 `cards/todo.ts` 的文件头说明），
   * 所以这里原样带出、由显示层决定要不要画出来 —— model 层不该替 UI 做这个决定。
   */
  text: string;
}

/** 板上所有未完成的待办项（按版面排序；没有就返回空数组） */
export function collectOpenTodos(board: BoardFile): OpenTodoEntry[] {
  const entries: OpenTodoEntry[] = [];
  for (const card of sortedTodoCards(board)) {
    card.content.items.forEach((item, index) => {
      if (item.done) return;
      entries.push({ cardId: card.id, cardTitle: card.title, index, text: item.text });
    });
  }
  return entries;
}

/**
 * 未完成 / 已完成项数。
 *
 * 单独给一个"只数不造列表"的入口：顶栏徽标与命令可用性判断每帧都可能问到它，
 * 而造一遍 `OpenTodoEntry[]` 要分配数组与字符串。
 */
export function todoTotals(board: BoardFile): { open: number; done: number } {
  let open = 0;
  let done = 0;
  for (const card of board.cards) {
    if (card.type !== 'todo') continue;
    for (const item of card.content.items) {
      if (item.done) done += 1;
      else open += 1;
    }
  }
  return { open, done };
}

/**
 * 待办卡按版面排序。
 *
 * `filter` 已经产出了一个**新数组**，所以随后的 `sort` 不会就地打乱 `board.cards`
 * —— 这一点很关键：`board.cards` 的顺序被撤销栈与连线对位依赖着。
 */
function sortedTodoCards(board: BoardFile): CardOf<'todo'>[] {
  return board.cards
    .filter((card): card is CardOf<'todo'> => card.type === 'todo')
    .sort((a, b) => a.y - b.y || a.x - b.x);
}
