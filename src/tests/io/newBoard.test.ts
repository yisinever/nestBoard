/**
 * 新建白板文件（T1.61 / `F2-8-1`）单元测试。
 *
 * 这里钉的是"⌘⇧N 与白板卡「新建子白板」共用同一条落盘路径"里的三条规则：
 *   1. `parent` 必须写进 `meta.parent` —— 面包屑（`F2-8-4`）、`⌘U` 回父级（`F2-8-5`）、
 *      `RenameWatcher` 修父子路径全靠它，漏写等于整条层级链路空转；
 *   2. 目录与默认背景**每次现读设置**（T1.74 / T3.25）：换了新建目录之后，
 *      下一次新建就该走新目录，不必重启；传了 `folder` 时以它为准（O12）；
 *   3. 重名顺延复用 `uniquePath`：覆盖掉别人已有的板，比"名字后面多个 2"糟得多
 *      —— `folder` 只换落点、`exactPath` 才连文件名一起钉死，两者的分别也在这里钉住。
 *
 * 本模块刻意不发通知、不开视图，因此不碰 `obsidian` 运行时 ——
 * 一个假 plugin 就能把它测完。
 */

import { describe, expect, it } from 'vitest';

import { createBoardInVault } from '../../io/newBoard';
import { createBoardFile, createCard } from '../../model/factories';
import type { BoardFile } from '../../model/schema';
import { t } from '../../util/i18n';
import type NestboardPlugin from '../../main';

interface Harness {
  plugin: NestboardPlugin;
  created: { path: string; board: BoardFile }[];
  upserted: string[];
}

/** 只造 `createBoardInVault` 真正会碰的那几样能力 */
function fakePlugin(
  options: { folder?: string; background?: string; taken?: string[] } = {},
): Harness {
  const taken = new Set(options.taken ?? []);
  const created: { path: string; board: BoardFile }[] = [];
  const upserted: string[] = [];

  const plugin = {
    settings: {
      newBoardFolder: options.folder ?? 'Boards',
      defaultBackground: options.background ?? 'dots',
    },
    vaultIO: {
      exists: (candidate: string) => taken.has(candidate),
    },
    repository: {
      createBoard: async (path: string, board: BoardFile) => {
        created.push({ path, board });
        taken.add(path);
      },
    },
    registry: {
      upsert: async (path: string) => {
        upserted.push(path);
      },
    },
  };

  return { plugin: plugin as unknown as NestboardPlugin, created, upserted };
}

describe('createBoardInVault', () => {
  it('不传 parent → 顶层板（`meta.parent` 为 null）', async () => {
    const { plugin, created } = fakePlugin();

    await createBoardInVault(plugin);

    expect(created[0]?.board.meta.parent).toBeNull();
  });

  it('传了 parent → 写进 `meta.parent`（层级链路只认这一个字段）', async () => {
    const { plugin, created } = fakePlugin();

    await createBoardInVault(plugin, { parent: 'Boards/父板.nboard' });

    expect(created[0]?.board.meta.parent).toBe('Boards/父板.nboard');
  });

  it('标题用 i18n 的"未命名白板"，不是空串（空标题在卡片上是一片空白）', async () => {
    const { plugin, created } = fakePlugin();

    await createBoardInVault(plugin);

    expect(created[0]?.board.meta.title).toBe(t('board.untitled'));
    expect(created[0]?.path).toBe(`Boards/${t('board.untitled')}.nboard`);
  });

  it('落盘之后还要登记注册表：只在磁盘上有个文件，选择器里是找不到它的', async () => {
    const { plugin, upserted } = fakePlugin();

    const path = await createBoardInVault(plugin);

    expect(upserted).toEqual([path]);
  });

  it('重名顺延（`uniquePath` 那一套：名字 → 名字 2 …）', async () => {
    const name = t('board.untitled');
    const { plugin, created } = fakePlugin({ taken: [`Boards/${name}.nboard`] });

    const path = await createBoardInVault(plugin);

    expect(path).toBe(`Boards/${name} 2.nboard`);
    expect(created[0]?.path).toBe(path);
  });

  it('目录与默认背景现读设置：换了新建目录，下一次就跟着走', async () => {
    const { plugin, created } = fakePlugin({ folder: '我的白板', background: 'grid' });

    await createBoardInVault(plugin);

    expect(created[0]?.path.startsWith('我的白板/')).toBe(true);
    expect(created[0]?.board.view.background).toBe('grid');
  });

  it('`folder` 盖过设置里的新建目录（O12：文件树右键「在此新建白板」）', async () => {
    const { plugin, created } = fakePlugin({ folder: 'Boards' });

    const path = await createBoardInVault(plugin, { folder: '项目/归档' });

    expect(path).toBe(`项目/归档/${t('board.untitled')}.nboard`);
    expect(created[0]?.path).toBe(path);
  });

  it('★ `folder` 只换落点，**不**连文件名一起钉死：同一个文件夹里连点两次要顺延', async () => {
    const name = t('board.untitled');
    const { plugin, created } = fakePlugin({ taken: [`项目/${name}.nboard`] });

    const path = await createBoardInVault(plugin, { folder: '项目' });

    // 覆盖掉刚建的那一块，比"名字后面多个 2"糟得多
    expect(path).toBe(`项目/${name} 2.nboard`);
    expect(created[0]?.path).toBe(path);
  });

  it('`exactPath` 仍然压过 `folder`（Home 白板的位置照样是钉死的）', async () => {
    const { plugin, created } = fakePlugin();

    const path = await createBoardInVault(plugin, {
      folder: '项目',
      exactPath: 'Home/主白板.nboard',
    });

    expect(path).toBe('Home/主白板.nboard');
    expect(created[0]?.path).toBe(path);
  });

  it('失败就抛（这一层不发通知，所以原因不能被吞掉）', async () => {
    const { plugin } = fakePlugin();
    (plugin.repository as unknown as { createBoard: () => Promise<void> }).createBoard = () =>
      Promise.reject(new Error('disk full'));

    await expect(createBoardInVault(plugin)).rejects.toThrow('disk full');
  });
});

/**
 * 从模板建板（`T4.14` / `F7-06`）。
 *
 * 这条分支与空白板**共用**落板的三条规则（目录来自设置 / 重名顺延 / 注册表登记），
 * 只在两处不同：内容由 `instantiateTemplate` 复制、背景**不套** `defaultBackground`。
 * 那两个"不同"正是这里要钉住的。
 */
describe('createBoardInVault（模板分支）', () => {
  function templateBoard(): BoardFile {
    return createBoardFile({
      meta: { title: '模板板' },
      // 模板的底色是模板的一部分，刻意与设置里的默认背景（`dots`）不同
      view: { x: 900, y: 900, zoom: 2, background: 'grid' },
      settings: { snapToGrid: false },
      cards: [createCard('note', { title: '模板卡' })],
    });
  }

  it('传了 template → 内容来自模板（卡片数量一致、id 全部换新）', async () => {
    const { plugin, created } = fakePlugin();
    const template = templateBoard();

    await createBoardInVault(plugin, { template });

    const board = created[0]?.board as BoardFile;
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0]?.id).not.toBe(template.cards[0]?.id);
    expect(board.cards[0]?.title).toBe('模板卡');
  });

  it('传了 template → **不套** `settings.defaultBackground`（模板的底色就是模板的一部分）', async () => {
    const { plugin, created } = fakePlugin({ background: 'dots' });

    await createBoardInVault(plugin, { template: templateBoard() });

    expect(created[0]?.board.view.background).toBe('grid');
  });

  it('传了 title → 标题与文件名都用它（从模板建板时传模板名）', async () => {
    const { plugin, created } = fakePlugin();

    const path = await createBoardInVault(plugin, { template: templateBoard(), title: '周报' });

    expect(path).toBe('Boards/周报.nboard');
    expect(created[0]?.board.meta.title).toBe('周报');
  });

  it('传了 parent → 走同一套层级规则，模板实例照样写进 `meta.parent`', async () => {
    const { plugin, created } = fakePlugin();

    await createBoardInVault(plugin, {
      template: templateBoard(),
      parent: 'Boards/父板.nboard',
    });

    expect(created[0]?.board.meta.parent).toBe('Boards/父板.nboard');
  });

  it('模板实例不会继承模板里的只读 / 视口：新建出来的板落回原点且可编辑', async () => {
    const locked = templateBoard();
    locked.settings.readOnly = true;
    const { plugin, created } = fakePlugin();

    await createBoardInVault(plugin, { template: locked });

    expect(created[0]?.board.settings.readOnly).toBe(false);
    expect(created[0]?.board.view).toMatchObject({ x: 0, y: 0, zoom: 1 });
  });

  it('模板分支同样登记注册表：不在里面登记，新板不会出现在任何选择器里', async () => {
    const { plugin, upserted } = fakePlugin();

    const path = await createBoardInVault(plugin, { template: templateBoard() });

    expect(upserted).toEqual([path]);
  });
});
