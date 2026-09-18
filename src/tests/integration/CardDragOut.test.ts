import { describe, expect, it } from 'vitest';

import { CardDragOut } from '../../integration/CardDragOut';
import type { CardDragOutPorts } from '../../integration/CardDragOut';

/**
 * 记录每个端口被怎么调用。
 *
 * `CardDragOut` 不碰 DOM、不认卡片，只被宿主喂 `begin` / `update` / `finish`，
 * 所以这里也不需要 jsdom —— 落点判定（哪个 `data-path` → 哪个文件夹）在
 * `model/dragOut.test.ts` 里已经钉死，这里只验证"什么时候问、问了回什么、回调几次"。
 */
function createPorts(overrides: Partial<CardDragOutPorts> = {}): {
  ports: CardDragOutPorts;
  highlights: (string | null)[];
  exports: { cardIds: readonly string[]; folder: string }[];
} {
  const highlights: (string | null)[] = [];
  const exports: { cardIds: readonly string[]; folder: string }[] = [];
  const ports: CardDragOutPorts = {
    pathAt: overrides.pathAt ?? (() => null),
    isFolder: overrides.isFolder ?? (() => false),
    onHighlight: (folder) => highlights.push(folder),
    onExport: (cardIds, folder) => exports.push({ cardIds, folder }),
  };
  return { ports, highlights, exports };
}

describe('CardDragOut · 落点与高亮（T6.10 / F6-04）', () => {
  it('悬到文件夹上 → 高亮该文件夹', () => {
    const { ports, highlights } = createPorts({
      pathAt: () => 'Notes',
      isFolder: () => true,
    });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 20);

    expect(highlights).toEqual(['Notes']);
    expect(dragOut.active).toBe(true);
  });

  it('悬到文件上 → 高亮它所在的目录（不是文件自己）', () => {
    const { ports, highlights } = createPorts({
      pathAt: () => 'Notes/A.md',
      isFolder: () => false,
    });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 20);

    expect(highlights).toEqual(['Notes']);
  });

  it('每帧都调 `update`，但落点没变时代价为零（只回调一次）', () => {
    const { ports, highlights } = createPorts({
      pathAt: () => 'Notes',
      isFolder: () => true,
    });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 20);
    dragOut.update(11, 21);
    dragOut.update(12, 22);

    expect(highlights).toEqual(['Notes']);
  });

  it('落点换了 → 先收起旧的再亮新的；离开条目 → 收起', () => {
    const { ports, highlights } = createPorts({ isFolder: () => true });
    ports.pathAt = (x) => (x < 100 ? 'Notes' : null);
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 0); // Notes
    dragOut.update(50, 0); // 还是 Notes（去重）
    dragOut.update(200, 0); // 离开了

    expect(highlights).toEqual(['Notes', null]);
    expect(dragOut.active).toBe(false);
  });

  it('`begin` 之前不响应 `update`（手势还没开始）', () => {
    const { ports, highlights } = createPorts({ pathAt: () => 'Notes', isFolder: () => true });
    const dragOut = new CardDragOut(ports);

    dragOut.update(10, 20);

    expect(highlights).toEqual([]);
  });
});

describe('CardDragOut · 松手（导出）', () => {
  it('悬在文件夹上松手 → 导出这几张卡并返回 `true`（宿主应当取消这次移动）', () => {
    const { ports, exports, highlights } = createPorts({
      pathAt: () => 'Notes',
      isFolder: () => true,
    });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1', 'c2']);
    dragOut.update(10, 20);
    const handled = dragOut.finish();

    expect(handled).toBe(true);
    expect(exports).toEqual([{ cardIds: ['c1', 'c2'], folder: 'Notes' }]);
    // 收尾把高亮清干净，不会在侧栏留下一个亮着的文件夹
    expect(highlights.at(-1)).toBeNull();
    expect(dragOut.active).toBe(false);
  });

  it('拖回画布内松手 → 什么都不做并返回 `false`（天然就是"取消"）', () => {
    const { ports, exports } = createPorts({ pathAt: () => null });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 20);
    const handled = dragOut.finish();

    expect(handled).toBe(false);
    expect(exports).toEqual([]);
  });

  it('空选（理论上不该发生）不导出：宁可不做事，也不写出"未命名"文件', () => {
    const { ports, exports } = createPorts({ pathAt: () => 'Notes', isFolder: () => true });
    const dragOut = new CardDragOut(ports);

    dragOut.begin([]);
    dragOut.update(10, 20);

    expect(dragOut.finish()).toBe(false);
    expect(exports).toEqual([]);
  });

  it('`finish` 之后这次手势就结束了（再调 `finish` 不会再导出一次）', () => {
    const { ports, exports } = createPorts({ pathAt: () => 'Notes', isFolder: () => true });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 20);
    expect(dragOut.finish()).toBe(true);
    expect(dragOut.finish()).toBe(false);

    expect(exports).toHaveLength(1);
  });
});

describe('CardDragOut · 收尾与 Alt', () => {
  it('`cancel` 清掉高亮与卡片清单，之后 `finish` 不再导出', () => {
    const { ports, exports, highlights } = createPorts({
      pathAt: () => 'Notes',
      isFolder: () => true,
    });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 20);
    dragOut.cancel();

    expect(highlights).toEqual(['Notes', null]);
    expect(dragOut.active).toBe(false);
    expect(dragOut.finish()).toBe(false);
    expect(exports).toEqual([]);
  });

  it('`cancel` 时本来没高亮 → 不产生多余的清除回调', () => {
    const { ports, highlights } = createPorts();
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.cancel();

    expect(highlights).toEqual([]);
  });

  it('`begin` 先清掉上一次的残留高亮（换一次手势重新开始）', () => {
    const { ports, highlights } = createPorts({ pathAt: () => 'Notes', isFolder: () => true });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 20);
    dragOut.begin(['c2']); // 上一次还没 finish 就开始新手势

    expect(highlights).toEqual(['Notes', null]);
  });

  it('`suspend` 收起落点但不结束拖动：Alt 松开后还能重新变回"可能导出"', () => {
    const { ports, exports, highlights } = createPorts({
      pathAt: () => 'Notes',
      isFolder: () => true,
    });
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.update(10, 20);
    dragOut.suspend(); // 拖到一半按下 Alt → 语义变成"板内复制"，高亮收掉

    expect(highlights).toEqual(['Notes', null]);
    expect(dragOut.active).toBe(false);

    dragOut.update(10, 20); // Alt 松开 → 重新悬到同一个文件夹上
    expect(highlights).toEqual(['Notes', null, 'Notes']);

    expect(dragOut.finish()).toBe(true);
    expect(exports).toEqual([{ cardIds: ['c1'], folder: 'Notes' }]);
  });

  it('本来就没高亮时 `suspend` 是空操作', () => {
    const { ports, highlights } = createPorts();
    const dragOut = new CardDragOut(ports);

    dragOut.begin(['c1']);
    dragOut.suspend();

    expect(highlights).toEqual([]);
  });

  it('`active` 只在悬着落点时才是 `true`（画布内的落点提示据此让路）', () => {
    const { ports } = createPorts({ pathAt: () => 'Notes', isFolder: () => true });
    const dragOut = new CardDragOut(ports);

    expect(dragOut.active).toBe(false);
    dragOut.begin(['c1']);
    expect(dragOut.active).toBe(false);
    dragOut.update(10, 20);
    expect(dragOut.active).toBe(true);
    dragOut.cancel();
    expect(dragOut.active).toBe(false);
  });
});
