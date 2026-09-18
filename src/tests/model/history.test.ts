/**
 * 撤销重做框架单元测试（`T1.48` / `T4.18`，`F3` / `02 §4.1` 的 `⌘Z` / `⌘⇧Z`）。
 *
 * 这是**唯一**一条"用户按 `⌘Z` 之后数据会不会回来"的路径，而且它是快照法 ——
 * 快照法本身不会写错逆操作，但**快照之外的簿记**很容易错：字节账、合并窗口、
 * 上限淘汰、peek/commit 两步之间的栈状态。这些错了不会立刻崩，而是表现为
 * "撤销几步之后就有一步退不回去""内存缓慢涨上去"。所以这里逐条钉住。
 *
 * 另外两条刻意保留的行为（不是 bug）：
 *   · `meta` / `view` / `settings` **不参与撤销**（`⌘Z` 把白板标题改回去，用户会觉得见了鬼）；
 *   · 写回失败时栈**原样不动**（撤销失败但栈已经弹掉，用户就再也退不回去了）。
 */

import { describe, expect, it } from 'vitest';
import { HISTORY_BYTES_BUDGET, HISTORY_LIMIT } from '../../constants';
import { createBoardFile, createCard, createEdge, createGroup } from '../../model/factories';
import { HistoryStack, restoreContent, serializeContent } from '../../model/history';
import type { BoardFile } from '../../model/schema';

/* ── 测试夹具 ───────────────────────────────────────────── */

/** 一块"有内容"的板：1 卡 + 1 连线 + 1 编组（四个数组都非空，列数为 0） */
function contentBoard(): BoardFile {
  const board = createBoardFile({ meta: { title: '原始标题' } });
  board.cards = [createCard('note', { id: 'c1' })];
  board.columns = [];
  board.edges = [
    createEdge(
      { cardId: 'c1', side: 'right' },
      { cardId: '', side: 'left', point: { x: 320, y: 40 } },
    ),
  ];
  board.groups = [createGroup(['c1'])];
  return board;
}

/** 定尺字符串：长度可控，方便按字节算预算 */
const sized = (n: number, ch = 'a'): string => ch.repeat(n);

/** 手工注入的时钟 */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

function stackOf(options: ConstructorParameters<typeof HistoryStack>[0] = {}): HistoryStack {
  return new HistoryStack(options);
}

/* ── 序列化 / 写回 ──────────────────────────────────────── */

describe('serializeContent', () => {
  it('只装四个数组，`meta` / `view` / `settings` 一个都不进快照', () => {
    const board = contentBoard();
    const raw = serializeContent(board);

    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      'cards',
      'columns',
      'edges',
      'groups',
    ]);
  });

  it('改动 `meta` / `view` / `settings` 不会让快照变样（否则撤销会回滚白板标题）', () => {
    const board = contentBoard();
    const before = serializeContent(board);

    board.meta.title = '改过的标题';
    board.view.x = 999;
    board.settings.snapToGrid = !board.settings.snapToGrid;

    expect(serializeContent(board)).toBe(before);
  });

  it('改动四个数组里的任何一个都会让快照变样', () => {
    const board = contentBoard();
    const before = serializeContent(board);

    board.cards = [...board.cards, createCard('note', { id: 'c2' })];

    expect(serializeContent(board)).not.toBe(before);
  });
});

describe('restoreContent', () => {
  it('写回四个数组，并返回 true', () => {
    const board = contentBoard();
    const raw = serializeContent(board);

    board.cards = [];
    board.edges = [];
    board.groups = [];

    expect(restoreContent(board, raw)).toBe(true);
    expect(board.cards).toHaveLength(1);
    expect(board.edges).toHaveLength(1);
    expect(board.groups).toHaveLength(1);
  });

  it('**只**替换四个数组：`meta` / `view` / `settings` 一个都不碰', () => {
    const board = contentBoard();
    const raw = serializeContent(board);

    board.meta.title = '撤销不该动我';
    board.view = { x: 12, y: 34, zoom: 2, background: 'grid' };
    board.settings.readOnly = true;

    restoreContent(board, raw);

    expect(board.meta.title).toBe('撤销不该动我');
    expect(board.view).toMatchObject({ x: 12, y: 34, zoom: 2, background: 'grid' });
    expect(board.settings.readOnly).toBe(true);
  });

  it('坏 JSON → false，且白板**原样不动**（宁可放弃撤销，也不能留半截状态）', () => {
    const board = contentBoard();
    const cards = board.cards;

    expect(restoreContent(board, '{不是 JSON')).toBe(false);
    expect(board.cards).toBe(cards);
    expect(board.groups).toHaveLength(1);
  });

  it('不是对象（null / 字符串 / 数字）→ false', () => {
    const board = contentBoard();

    expect(restoreContent(board, 'null')).toBe(false);
    expect(restoreContent(board, '"just a string"')).toBe(false);
    expect(restoreContent(board, '42')).toBe(false);
  });

  it('对象但缺任一数组 → false，且**一个数组都不写**（不能只写一半）', () => {
    const board = contentBoard();
    const cards = board.cards;
    const groups = board.groups;

    const missing: string[] = [
      JSON.stringify({ columns: [], edges: [], groups: [] }),
      JSON.stringify({ cards: [], edges: [], groups: [] }),
      JSON.stringify({ cards: [], columns: [], groups: [] }),
      JSON.stringify({ cards: [], columns: [], edges: [] }),
    ];
    for (const raw of missing) expect(restoreContent(board, raw)).toBe(false);

    expect(board.cards).toBe(cards);
    expect(board.groups).toBe(groups);
  });

  it('数组位置上的非数组值（`{}` / 字符串）也当缺数组处理', () => {
    const board = contentBoard();
    const raw = JSON.stringify({ cards: {}, columns: [], edges: [], groups: [] });

    expect(restoreContent(board, raw)).toBe(false);
  });
});

/* ── 栈的基本行为 ───────────────────────────────────────── */

describe('HistoryStack · 基本', () => {
  it('新栈：两面都不能走，标签为 null，深度为 0', () => {
    const stack = stackOf();

    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
    expect(stack.undoLabel).toBeNull();
    expect(stack.redoLabel).toBeNull();
    expect(stack.undoDepth).toBe(0);
    expect(stack.redoDepth).toBe(0);
    expect(stack.peekUndo()).toBeNull();
    expect(stack.peekRedo()).toBeNull();
  });

  it('提交一条 → 能撤销、标签与深度都对', () => {
    const stack = stackOf();

    expect(stack.submit({ label: '移动卡片', before: 'A', after: 'B' })).toBe(true);

    expect(stack.canUndo).toBe(true);
    expect(stack.undoLabel).toBe('移动卡片');
    expect(stack.undoDepth).toBe(1);
    expect(stack.canRedo).toBe(false);
    expect(stack.peekUndo()).toMatchObject({ label: '移动卡片', before: 'A', after: 'B' });
  });

  it('内容没变（before === after）→ 丢弃，返回 false，不占格', () => {
    const stack = stackOf();

    expect(stack.submit({ label: '空操作', before: 'SAME', after: 'SAME' })).toBe(false);

    expect(stack.canUndo).toBe(false);
    expect(stack.undoDepth).toBe(0);
  });

  it('默认值取自 constants（不传 options 时用的是发布值）', () => {
    const clocked = clock();
    const stack = stackOf({ now: clocked.now });

    // 连提 limit 条，第 limit + 1 条应把最旧的挤掉
    for (let i = 0; i < HISTORY_LIMIT; i += 1) {
      stack.submit({ label: `第 ${i} 次`, before: `b${i}`, after: `a${i}` });
    }
    expect(stack.undoDepth).toBe(HISTORY_LIMIT);

    stack.submit({ label: '溢出的一条', before: 'xb', after: 'xa' });
    expect(stack.undoDepth).toBe(HISTORY_LIMIT);
    expect(stack.undoLabel).toBe('溢出的一条');
  });

  it('提交新改动 → 重做栈立刻作废（与所有编辑器的约定一致）', () => {
    const stack = stackOf();
    stack.submit({ label: '第一步', before: 'A', after: 'B' });
    stack.commitUndo();
    expect(stack.canRedo).toBe(true);

    stack.submit({ label: '新的一步', before: 'B', after: 'C' });

    expect(stack.canRedo).toBe(false);
    expect(stack.redoDepth).toBe(0);
    expect(stack.undoLabel).toBe('新的一步');
  });
});

/* ── peek / commit 两步 ────────────────────────────────── */

describe('HistoryStack · peek 与 commit 两步走', () => {
  it('peek 取出但**不移除**（写回内容可能失败，栈必须原样留着）', () => {
    const stack = stackOf();
    stack.submit({ label: '移动卡片', before: 'A', after: 'B' });

    expect(stack.peekUndo()?.before).toBe('A');
    expect(stack.peekUndo()?.before).toBe('A');
    expect(stack.undoDepth).toBe(1);
  });

  it('commitUndo → 从撤销栈挪到重做栈，标签跟着走', () => {
    const stack = stackOf();
    stack.submit({ label: '第一步', before: 'A', after: 'B' });
    stack.submit({ label: '第二步', before: 'B', after: 'C' });

    const entry = stack.commitUndo();

    expect(entry?.label).toBe('第二步');
    expect(stack.undoDepth).toBe(1);
    expect(stack.redoDepth).toBe(1);
    expect(stack.undoLabel).toBe('第一步');
    expect(stack.redoLabel).toBe('第二步');
  });

  it('commitRedo → 挪回撤销栈，且能来回横跳', () => {
    const stack = stackOf();
    stack.submit({ label: '第一步', before: 'A', after: 'B' });
    stack.commitUndo();

    expect(stack.commitRedo()?.label).toBe('第一步');
    expect(stack.undoDepth).toBe(1);
    expect(stack.redoDepth).toBe(0);

    stack.commitUndo();
    expect(stack.redoDepth).toBe(1);
  });

  it('空栈上 commit 返回 null，且不改变任何状态', () => {
    const stack = stackOf();

    expect(stack.commitUndo()).toBeNull();
    expect(stack.commitRedo()).toBeNull();
    expect(stack.undoDepth).toBe(0);
    expect(stack.redoDepth).toBe(0);
  });

  it('撤销到底之后再 commitUndo → null，栈不出现"负数深度"', () => {
    const stack = stackOf();
    stack.submit({ label: '第一步', before: 'A', after: 'B' });
    stack.commitUndo();

    expect(stack.commitUndo()).toBeNull();
    expect(stack.undoDepth).toBe(0);
    expect(stack.redoDepth).toBe(1);
  });

  it('"撤销失败"的走法：只 peek 不 commit → 栈完全不动，可以重试', () => {
    const stack = stackOf();
    const board = contentBoard();
    stack.submit({ label: '第一步', before: serializeContent(board), after: 'B' });

    const entry = stack.peekUndo();
    // 调用方的写回失败（坏快照）→ 不 commit
    expect(restoreContent(board, '{坏了')).toBe(false);
    expect(stack.peekUndo()).toBe(entry);
    expect(stack.undoDepth).toBe(1);
    expect(stack.canRedo).toBe(false);
  });
});

/* ── 合并（连按 10 次方向键 = 一步） ───────────────────── */

describe('HistoryStack · mergeKey 合并', () => {
  it('同 mergeKey 且在窗口内 → 合成一条，起点保持第一次、终点是最后一次', () => {
    const time = clock();
    const stack = stackOf({ now: time.now, mergeWindowMs: 600, limit: 99 });

    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p0', after: 'p1' });
    time.advance(100);
    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p1', after: 'p2' });
    time.advance(100);
    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p2', after: 'p3' });

    expect(stack.undoDepth).toBe(1);
    const entry = stack.peekUndo();
    expect(entry?.before).toBe('p0');
    expect(entry?.after).toBe('p3');
  });

  it('合并会刷新时间戳：连着慢慢按也不会"隔一段就断成一步"', () => {
    const time = clock();
    const stack = stackOf({ now: time.now, mergeWindowMs: 600, limit: 99 });

    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p0', after: 'p1' });
    time.advance(500); // 距上一条 500 ≤ 600 → 合并，并把 at 推到 500
    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p1', after: 'p2' });
    time.advance(500); // 若 at 没被刷新（1000 > 600）这里就会断成两步
    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p2', after: 'p3' });

    expect(stack.undoDepth).toBe(1);
    expect(stack.peekUndo()?.after).toBe('p3');
  });

  it('超出合并窗口 → 断成两条', () => {
    const time = clock();
    const stack = stackOf({ now: time.now, mergeWindowMs: 600, limit: 99 });

    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p0', after: 'p1' });
    time.advance(601);
    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p1', after: 'p2' });

    expect(stack.undoDepth).toBe(2);
  });

  it('`mergeKey` 不填 → 永不合并（每次都是独立一步）', () => {
    const time = clock();
    const stack = stackOf({ now: time.now, limit: 99 });

    stack.submit({ label: '重命名', before: 'p0', after: 'p1' });
    stack.submit({ label: '重命名', before: 'p1', after: 'p2' });

    expect(stack.undoDepth).toBe(2);
  });

  it('`mergeKey` 不同 → 不合并（移动 A 之后再移动 B 是两步）', () => {
    const time = clock();
    const stack = stackOf({ now: time.now, limit: 99 });

    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p0', after: 'p1' });
    stack.submit({ label: '移动卡片', mergeKey: 'move:c2', before: 'p1', after: 'p2' });

    expect(stack.undoDepth).toBe(2);
  });

  it('中间隔了别的操作 → 同键也不合并（栈顶不是它）', () => {
    const time = clock();
    const stack = stackOf({ now: time.now, limit: 99 });

    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p0', after: 'p1' });
    stack.submit({ label: '改颜色', mergeKey: 'color:c1', before: 'p1', after: 'p2' });
    stack.submit({ label: '移动卡片', mergeKey: 'move:c1', before: 'p2', after: 'p3' });

    expect(stack.undoDepth).toBe(3);
  });

  it('合并**不影响**已存在的重做栈（合并只是把最后一步的终点往后挪）', () => {
    const time = clock();
    const stack = stackOf({ now: time.now, limit: 99 });

    stack.submit({ label: '第一步', before: 'A', after: 'B' });
    stack.commitUndo();
    expect(stack.redoDepth).toBe(1);

    // 合并发生在"栈顶同键"时；这里栈已空 → 走普通提交，重做栈被丢掉
    stack.submit({ label: '第二步', mergeKey: 'k', before: 'B', after: 'C' });
    expect(stack.redoDepth).toBe(0);
  });
});

/* ── 两道闸门：条数上限 + 体积预算 ─────────────────────── */

describe('HistoryStack · 上限与预算', () => {
  it('超过 limit → 从**最旧**的开始丢，最近的永远能撤销', () => {
    const stack = stackOf({ limit: 3 });

    for (const n of ['1', '2', '3', '4', '5']) {
      stack.submit({ label: `第 ${n} 步`, before: `b${n}`, after: `a${n}` });
    }

    expect(stack.undoDepth).toBe(3);
    expect(stack.undoLabel).toBe('第 5 步');
    // 连撤三次应依次是 5 → 4 → 3
    expect(stack.commitUndo()?.label).toBe('第 5 步');
    expect(stack.commitUndo()?.label).toBe('第 4 步');
    expect(stack.commitUndo()?.label).toBe('第 3 步');
    expect(stack.canUndo).toBe(false);
  });

  it('超过体积预算 → 同样从最旧开始丢（宁可少撤几步，也不吃光内存）', () => {
    // 每条 (before.length + after.length) = 10 + 10 = 20 字节；预算 50 → 只留 2 条
    const stack = stackOf({ limit: 100, bytesBudget: 50 });

    for (const n of ['1', '2', '3']) {
      stack.submit({ label: `第 ${n} 步`, before: sized(10), after: sized(10, 'b') });
    }

    expect(stack.undoDepth).toBe(2);
    expect(stack.undoLabel).toBe('第 3 步');
  });

  it('单条就超预算 → 栈被清空（也不会留下一条"撤不回去"的假记录）', () => {
    const stack = stackOf({ limit: 100, bytesBudget: 10 });

    stack.submit({ label: '巨无霸', before: sized(50), after: sized(50, 'b') });

    expect(stack.undoDepth).toBe(0);
    expect(stack.canUndo).toBe(false);
  });

  it('合并要**如实改字节账**：变长的合并照样会触发淘汰', () => {
    // 第一条 10 + 20 = 30 字节；合并后 after 变 40 → 账变 50 > 预算 45 → 应被淘汰
    const time = clock();
    const stack = stackOf({
      now: time.now,
      limit: 100,
      bytesBudget: 45,
      mergeWindowMs: 600,
    });

    stack.submit({ label: '移动卡片', mergeKey: 'k', before: sized(10), after: sized(20, 'b') });
    expect(stack.undoDepth).toBe(1);

    stack.submit({
      label: '移动卡片',
      mergeKey: 'k',
      before: sized(20, 'b'),
      after: sized(40, 'c'),
    });

    // 若合并漏算字节（账还停在 30 ≤ 45），这里就会是 1
    expect(stack.undoDepth).toBe(0);
  });

  it('合并变短也一样如实记账（不许把字节账算大）', () => {
    // 第一条 10 + 40 = 50 字节（超预算 45 → 淘汰）；这里反过来验证账在变小：
    // 预算 60 → 第一条 50 留下；合并后 after 20 → 账 30，仍然只有 1 条、不该被淘汰
    const time = clock();
    const stack = stackOf({
      now: time.now,
      limit: 100,
      bytesBudget: 60,
      mergeWindowMs: 600,
    });

    stack.submit({ label: '移动卡片', mergeKey: 'k', before: sized(10), after: sized(40, 'b') });
    expect(stack.undoDepth).toBe(1);

    stack.submit({
      label: '移动卡片',
      mergeKey: 'k',
      before: sized(40, 'b'),
      after: sized(20, 'c'),
    });

    expect(stack.undoDepth).toBe(1);
    expect(stack.peekUndo()?.after).toBe(sized(20, 'c'));
  });

  it('撤销把记录挪到重做栈时，字节账**不能被算重**', () => {
    // 预算恰好只装 1 条（20 字节）。撤销后记录进了重做栈 —— 账仍是 20，不该被当成 0 或 40。
    const stack = stackOf({ limit: 100, bytesBudget: 20 });
    stack.submit({ label: '第一步', before: sized(10), after: sized(10, 'b') });
    expect(stack.undoDepth).toBe(1);

    stack.commitUndo();
    expect(stack.redoDepth).toBe(1);

    // 再提一条：若账算成 40（重复计），两条都会被淘汰；正确账是 20 + 20 = 40 > 20，
    // 淘汰最旧的（即重做栈里那条吗？不 —— 淘汰只扫撤销栈）→ 撤销栈留 1 条
    stack.submit({ label: '第二步', before: sized(10, 'b'), after: sized(10, 'c') });

    expect(stack.undoDepth).toBe(1);
    expect(stack.undoLabel).toBe('第二步');
    // 新提交会丢掉重做栈（字节随之释放），所以重做栈是空的
    expect(stack.redoDepth).toBe(0);
  });

  it('丢重做栈会**释放**它占的字节（否则预算会被永远收不回来地吃掉）', () => {
    const stack = stackOf({ limit: 100, bytesBudget: 20 });

    // 先塞满：1 条（20 字节）
    stack.submit({ label: '第一步', before: sized(10), after: sized(10, 'b') });
    // 挪到重做栈：撤销栈空了，但账仍是 20
    stack.commitUndo();

    // 新提交：账 20 + 20 = 40 → 淘汰最旧的撤销栈条目 → 撤销栈 1 条
    stack.submit({ label: '第二步', before: sized(10, 'b'), after: sized(10, 'c') });
    // 若 dropRedo 没释放字节：账会停在 20（重做栈那 20 被算进预算）→ 再提一条就会把"第二步"挤掉
    stack.submit({ label: '第三步', before: sized(10, 'c'), after: sized(10, 'd') });

    expect(stack.undoDepth).toBe(1);
    expect(stack.undoLabel).toBe('第三步');
  });
});

/* ── clear ─────────────────────────────────────────────── */

describe('HistoryStack · clear（换板 / 外部重载）', () => {
  it('两面都清空、标签归 null（快照指向的是上一块板，留着就是错的）', () => {
    const stack = stackOf();
    stack.submit({ label: '第一步', before: 'A', after: 'B' });
    stack.submit({ label: '第二步', before: 'B', after: 'C' });
    stack.commitUndo();

    stack.clear();

    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
    expect(stack.undoLabel).toBeNull();
    expect(stack.redoLabel).toBeNull();
    expect(stack.undoDepth).toBe(0);
    expect(stack.redoDepth).toBe(0);
  });

  it('clear 之后字节账也归零（重新提交不受旧账影响）', () => {
    const stack = stackOf({ limit: 100, bytesBudget: 20 });
    stack.submit({ label: '第一步', before: sized(10), after: sized(10, 'b') });

    stack.clear();
    stack.submit({ label: '新的第一步', before: sized(10, 'c'), after: sized(10, 'd') });

    expect(stack.undoDepth).toBe(1);
    expect(stack.undoLabel).toBe('新的第一步');
  });
});

/* ── 端到端：与真实白板配合走一趟 ─────────────────────── */

describe('撤销 / 重做端到端（配合真实 BoardFile）', () => {
  it('改 → 撤 → 重做，内容完全回到两个端点', () => {
    const board = contentBoard();
    const stack = stackOf();

    const before = serializeContent(board);
    board.cards = [...board.cards, createCard('note', { id: 'c2', title: '新卡' })];
    const after = serializeContent(board);
    stack.submit({ label: '新建便签', before, after });

    // 撤销
    const undo = stack.peekUndo();
    expect(undo).not.toBeNull();
    expect(restoreContent(board, undo?.before ?? '')).toBe(true);
    stack.commitUndo();
    expect(board.cards.map((card) => card.id)).toEqual(['c1']);

    // 重做
    const redo = stack.peekRedo();
    expect(restoreContent(board, redo?.after ?? '')).toBe(true);
    stack.commitRedo();
    expect(board.cards.map((card) => card.id)).toEqual(['c1', 'c2']);
    expect(board.cards[1]?.title).toBe('新卡');
  });

  it('多步撤销要**逐步**回退，而不是一步回到最初', () => {
    const board = contentBoard();
    const stack = stackOf();

    const s0 = serializeContent(board);
    board.cards = [...board.cards, createCard('note', { id: 'c2' })];
    stack.submit({ label: '加 c2', before: s0, after: serializeContent(board) });

    const s1 = serializeContent(board);
    board.cards = [...board.cards, createCard('note', { id: 'c3' })];
    stack.submit({ label: '加 c3', before: s1, after: serializeContent(board) });

    const undo1 = stack.peekUndo();
    restoreContent(board, undo1?.before ?? '');
    stack.commitUndo();
    expect(board.cards.map((card) => card.id)).toEqual(['c1', 'c2']);

    const undo2 = stack.peekUndo();
    restoreContent(board, undo2?.before ?? '');
    stack.commitUndo();
    expect(board.cards.map((card) => card.id)).toEqual(['c1']);
  });

  it('快照是**纯数据**：撤销写回后与原数组内容相等（不是同一个引用，改一个不影响另一个）', () => {
    const board = contentBoard();
    const stack = stackOf();

    const before = serializeContent(board);
    board.cards = [...board.cards, createCard('note', { id: 'c2' })];
    stack.submit({ label: '加 c2', before, after: serializeContent(board) });

    restoreContent(board, before);
    expect(board.cards).not.toBe(undefined);

    // 撤销后再改一次，不影响已存下来的快照
    board.cards = [];
    expect(restoreContent(board, before)).toBe(true);
    expect(board.cards).toHaveLength(1);
  });

  it('默认预算下 1 条快照的字节量远小于预算（预算量级的兜底不至于一提交就淘汰）', () => {
    const board = contentBoard();
    const raw = serializeContent(board);
    expect(HISTORY_BYTES_BUDGET).toBeGreaterThan(raw.length * 100);
  });
});
