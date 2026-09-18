/**
 * Home 白板与收件箱（T5.07 / `F7-03` / `F11-09`）。
 *
 * 这里最要紧的一条是 **`ensureHomeBoard` 绝不覆盖已有文件**：
 * 它是全功能里唯一一条"按用户填的路径去写盘"的路径，写错一次就是用户的白板没了。
 * 其余几条钉的是"没配置 = 关掉"（而不是"热心地把功能打开"）与收件箱落点的算法。
 *
 * 本模块零 `obsidian` 运行时依赖，一个假 plugin 就能测完（同 `newBoard.test.ts`）。
 */

import { describe, expect, it } from 'vitest';

import {
  ensureHomeBoard,
  boardTitleFromPath,
  unsortedColumnOf,
  unsortedDropPoint,
} from '../../io/homeBoard';
import { UNSORTED_COLUMN_TITLE } from '../../constants';
import { createBoardFile, createColumn } from '../../model/factories';
import type { BoardFile } from '../../model/schema';
import type NestboardPlugin from '../../main';

interface Harness {
  plugin: NestboardPlugin;
  created: { path: string; board: BoardFile }[];
  upserted: string[];
  /** 让 `exists` 说"盘上有" */
  putOnDisk: (path: string) => void;
}

/**
 * 只造 `ensureHomeBoard` 真正会碰的那几样能力。
 *
 * ★ `registry.getByPath` 与 `vaultIO.exists` 是两个**独立**的事实（"索引里有没有"vs
 *   "盘上有没有"），所以这里分开造假：整个覆盖 bug 就藏在他俩不一致的时候。
 */
function fakePlugin(
  options: { home?: string; registered?: string[]; onDisk?: string[] } = {},
): Harness {
  const registered = new Set(options.registered ?? []);
  const onDisk = new Set(options.onDisk ?? []);
  const created: { path: string; board: BoardFile }[] = [];
  const upserted: string[] = [];

  const plugin = {
    settings: {
      homeBoardPath: options.home ?? 'Boards/Home.nboard',
      newBoardFolder: 'Boards',
      defaultBackground: 'dots',
    },
    vaultIO: {
      exists: async (candidate: string) => onDisk.has(candidate),
    },
    repository: {
      createBoard: async (path: string, board: BoardFile) => {
        created.push({ path, board });
        onDisk.add(path);
        registered.add(path);
      },
    },
    registry: {
      getByPath: (path: string) =>
        registered.has(path) ? { path, title: 'x', cardCount: 0 } : null,
      upsert: async (path: string) => {
        upserted.push(path);
        registered.add(path);
      },
    },
  };

  return {
    plugin: plugin as unknown as NestboardPlugin,
    created,
    upserted,
    putOnDisk: (path: string) => onDisk.add(path),
  };
}

function boardWith(title: string, columns: BoardFile['columns']): BoardFile {
  return createBoardFile({ meta: { title }, columns });
}

describe('boardTitleFromPath', () => {
  it('去掉目录与扩展名', () => {
    expect(boardTitleFromPath('Boards/Home.nboard')).toBe('Home');
  });

  it('中文路径一样处理', () => {
    expect(boardTitleFromPath('资料/我的白板.nboard')).toBe('我的白板');
  });

  it('大小写扩展名也认', () => {
    expect(boardTitleFromPath('Boards/Home.NBOARD')).toBe('Home');
  });

  it('没有扩展名时整名返回（不切掉一半）', () => {
    expect(boardTitleFromPath('Boards/Home')).toBe('Home');
  });

  it('顶层文件（没有目录）', () => {
    expect(boardTitleFromPath('Home.nboard')).toBe('Home');
  });
});

describe('unsortedColumnOf / unsortedDropPoint', () => {
  it('按标题找到收件箱那一栏', () => {
    const board = boardWith('Home', [
      createColumn({ title: 'TODO' }),
      createColumn({ title: UNSORTED_COLUMN_TITLE }),
    ]);
    expect(unsortedColumnOf(board)?.title).toBe(UNSORTED_COLUMN_TITLE);
  });

  it('标题两侧空白照收（用户手工改标题时很容易带个空格）', () => {
    const board = boardWith('Home', [createColumn({ title: ` ${UNSORTED_COLUMN_TITLE} ` })]);
    expect(unsortedColumnOf(board)).not.toBeNull();
  });

  it('没有收件箱 → null（调用方回落视口中心，而不是报错）', () => {
    const board = boardWith('Home', [createColumn({ title: '别的栏' })]);
    expect(unsortedColumnOf(board)).toBeNull();
    expect(unsortedDropPoint(board)).toBeNull();
  });

  it('落点 = 收件箱那一栏的**中心**（卡片归属是按落点命中的栏判的）', () => {
    const column = createColumn({ title: UNSORTED_COLUMN_TITLE, x: 100, y: 200 });
    const board = boardWith('Home', [column]);

    expect(unsortedDropPoint(board)).toEqual({
      x: column.x + column.width / 2,
      y: column.y + column.height / 2,
    });
  });

  it('空板 → null', () => {
    expect(unsortedDropPoint(boardWith('Home', []))).toBeNull();
  });
});

describe('ensureHomeBoard', () => {
  it('没配置（`homeBoardPath` 为空串）→ null，且**什么都不建**', async () => {
    const { plugin, created, upserted } = fakePlugin({ home: '' });

    expect(await ensureHomeBoard(plugin)).toBeNull();
    expect(created).toEqual([]);
    expect(upserted).toEqual([]);
  });

  it('已在索引里 → 直接返回，一次写操作都不发生（绝大多数调用走这条）', async () => {
    const { plugin, created, upserted } = fakePlugin({
      registered: ['Boards/Home.nboard'],
    });

    expect(await ensureHomeBoard(plugin)).toBe('Boards/Home.nboard');
    expect(created).toEqual([]);
    expect(upserted).toEqual([]);
  });

  it('盘上有、索引里没有 → **只登记，绝不覆盖**（这一条是整份文件的安全底线）', async () => {
    const { plugin, created, upserted } = fakePlugin({ onDisk: ['Boards/Home.nboard'] });

    expect(await ensureHomeBoard(plugin)).toBe('Boards/Home.nboard');
    expect(created).toEqual([]); // ← 用户已经放好东西的那块板，一个字节都不许动
    expect(upserted).toEqual(['Boards/Home.nboard']);
  });

  it('盘上也没有 → 按 exactPath 建一块，带一栏收件箱，并登记', async () => {
    const { plugin, created, upserted } = fakePlugin();

    expect(await ensureHomeBoard(plugin)).toBe('Boards/Home.nboard');
    expect(created).toHaveLength(1);
    expect(created[0]?.path).toBe('Boards/Home.nboard'); // 它就在用户填的那个路径上
    expect(created[0]?.board.meta.title).toBe('Home'); // 标题取自文件名
    expect(created[0]?.board.columns.map((column) => column.title)).toEqual([
      UNSORTED_COLUMN_TITLE,
    ]);
    expect(upserted).toEqual(['Boards/Home.nboard']);
  });

  it('路径在子目录里也照办（`exactPath` 不套新建目录的设置）', async () => {
    const { plugin, created } = fakePlugin({ home: '我的白板/工作台.nboard' });

    expect(await ensureHomeBoard(plugin)).toBe('我的白板/工作台.nboard');
    expect(created[0]?.path).toBe('我的白板/工作台.nboard');
    expect(created[0]?.board.meta.title).toBe('工作台');
  });

  it('建板失败就抛（原因不能被吞掉，调用方要拿去提示用户）', async () => {
    const { plugin } = fakePlugin();
    (plugin.repository as unknown as { createBoard: () => Promise<void> }).createBoard = () =>
      Promise.reject(new Error('disk full'));

    await expect(ensureHomeBoard(plugin)).rejects.toThrow('disk full');
  });

  it('重复调用只建一次（第二次走"已在索引里"那条）', async () => {
    const { plugin, created } = fakePlugin();

    await ensureHomeBoard(plugin);
    await ensureHomeBoard(plugin);

    expect(created).toHaveLength(1);
  });

  it('收件箱那一栏是**空栏**：Home 不是"预置一张示例卡"的样板间', async () => {
    const { plugin, created } = fakePlugin();

    await ensureHomeBoard(plugin);

    expect(created[0]?.board.cards).toEqual([]);
    expect(created[0]?.board.columns).toHaveLength(1);
  });

  it('建出来的板是同一个 `UNSORTED_COLUMN_TITLE` —— 否则 addFilesToUnsorted 找不到落点', async () => {
    const { plugin, created } = fakePlugin();

    await ensureHomeBoard(plugin);

    const board = created[0]?.board as BoardFile;
    expect(unsortedDropPoint(board)).not.toBeNull();
  });
});
