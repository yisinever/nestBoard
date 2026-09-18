import { describe, expect, it } from 'vitest';
import { BoardRegistry } from '../../io/BoardRegistry';
import { createBoardFile, createCard } from '../../model/factories';
import { serializeBoard } from '../../io/BoardRepository';
import type { BoardFile } from '../../model/schema';
import { MemoryVaultIO } from '../helpers/memoryVault';

function makeBoard(
  id: string,
  title: string,
  extra: { parent?: string; cards?: number; updatedAt?: string } = {},
): BoardFile {
  const board = createBoardFile({
    revision: 1,
    meta: { id, title, parent: extra.parent ?? null },
    cards: Array.from({ length: extra.cards ?? 0 }, () => createCard('note')),
  });
  if (extra.updatedAt) board.meta.updatedAt = extra.updatedAt;
  return board;
}

describe('BoardRegistry（T1.15）', () => {
  it('扫描全部 .nboard，建立 id ↔ path 映射', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A')),
      'Boards/Sub/B.nboard': serializeBoard(makeBoard('nb_b', 'B')),
      'Notes/普通笔记.md': '# 不是白板',
    });
    const registry = new BoardRegistry(vault);

    await registry.build();

    expect(registry.all()).toHaveLength(2);
    expect(registry.getById('nb_a')?.path).toBe('Boards/A.nboard');
    expect(registry.getByPath('Boards/Sub/B.nboard')?.title).toBe('B');
    expect(registry.has('Notes/普通笔记.md')).toBe(false);
  });

  it('卡片计数懒加载：扫描阶段是 null，调用后才统计', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', { cards: 3 })),
    });
    const registry = new BoardRegistry(vault);
    await registry.build();

    expect(registry.getByPath('Boards/A.nboard')?.cardCount).toBeNull();
    await expect(registry.ensureCardCount('Boards/A.nboard')).resolves.toBe(3);
    expect(registry.getByPath('Boards/A.nboard')?.cardCount).toBe(3);
  });

  it('缺乏 meta.id 的文件不进入索引，并记入 warnings（不静默丢弃）', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A')),
      'Boards/坏.nboard': JSON.stringify({ spec: 'nestboard/1', version: 1, cards: [] }),
    });
    const registry = new BoardRegistry(vault);
    await registry.build();

    expect(registry.all()).toHaveLength(1);
    expect(registry.warningsList().map((warning) => warning.path)).toEqual(['Boards/坏.nboard']);
  });

  it('同一 id 出现在两个路径（复制文件）→ 保留先到的，后者告警', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_same', 'A')),
      'Boards/A 副本.nboard': serializeBoard(makeBoard('nb_same', 'A 副本')),
    });
    const registry = new BoardRegistry(vault);
    await registry.build();

    expect(registry.all()).toHaveLength(1);
    expect(registry.getById('nb_same')?.path).toBe('Boards/A.nboard');
    expect(registry.warningsList()[0].message).toContain('重复');
  });

  it('父子关系：childrenOf / topLevel，父板不存在时降级为顶层', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', { updatedAt: '2026-01-01' })),
      'Boards/B.nboard': serializeBoard(
        makeBoard('nb_b', 'B', { parent: 'Boards/A.nboard', updatedAt: '2026-02-01' }),
      ),
      'Boards/C.nboard': serializeBoard(
        makeBoard('nb_c', 'C', { parent: 'Boards/已删除.nboard', updatedAt: '2026-03-01' }),
      ),
    });
    const registry = new BoardRegistry(vault);
    await registry.build();

    expect(registry.childrenOf('Boards/A.nboard').map((entry) => entry.title)).toEqual(['B']);
    // A 与 C（父板缺失被降级）都是顶层，按 updatedAt 倒序
    expect(registry.topLevel().map((entry) => entry.title)).toEqual(['C', 'A']);
    expect(registry.warningsList()[0].message).toContain('父白板不存在');
  });

  it('movePath 改名后保持 id，并同步子板的 parent', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A')),
      'Boards/B.nboard': serializeBoard(makeBoard('nb_b', 'B', { parent: 'Boards/A.nboard' })),
    });
    const registry = new BoardRegistry(vault);
    await registry.build();

    registry.movePath('Boards/A.nboard', 'Boards/Renamed.nboard');

    expect(registry.getById('nb_a')?.path).toBe('Boards/Renamed.nboard');
    expect(registry.getByPath('Boards/B.nboard')?.parent).toBe('Boards/Renamed.nboard');
  });

  it('updateFromBoard 免磁盘读刷新元信息', async () => {
    const vault = new MemoryVaultIO({ 'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A')) });
    const registry = new BoardRegistry(vault);
    await registry.build();

    const board = makeBoard('nb_a', '改名后', { cards: 2 });
    registry.updateFromBoard('Boards/A.nboard', board);

    const entry = registry.getByPath('Boards/A.nboard');
    expect(entry?.title).toBe('改名后');
    expect(entry?.cardCount).toBe(2);
  });

  it('remove 后查不到', async () => {
    const vault = new MemoryVaultIO({ 'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A')) });
    const registry = new BoardRegistry(vault);
    await registry.build();

    registry.remove('Boards/A.nboard');
    expect(registry.getById('nb_a')).toBeNull();
    expect(registry.all()).toEqual([]);
  });
});
