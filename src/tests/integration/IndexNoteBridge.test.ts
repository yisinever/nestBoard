import { beforeEach, describe, expect, it } from 'vitest';

import { IndexNoteBridge } from '../../integration/IndexNoteBridge';
import type { IndexNoteEntry, IndexNotePorts } from '../../integration/IndexNoteBridge';
import { INDEX_NOTE_MARKER, indexNotePathOf, renderIndexNote } from '../../model/indexNote';
import type { IndexNoteLink } from '../../model/indexNote';
import { setLocale } from '../../util/i18n';

/**
 * 一张"内存库"。
 *
 * `IndexNoteBridge` 只通过 `IndexNotePorts` 碰外部世界，所以这里不需要 jsdom，也不需要
 * obsidian —— 想在 `README.md` 上模拟"用户恰好有一份同名笔记"只需往 `files` 里塞一行。
 */
interface HarnessOptions {
  enabled?: boolean;
  folder?: string;
  boards?: string[];
  entries?: Record<string, IndexNoteEntry>;
  links?: Record<string, IndexNoteLink[]>;
  /** 这块板里**卡内**写的标签（`F1` ①） */
  cardTags?: Record<string, string[]>;
  /**
   * 预置的标签枢纽笔记清单（`F1` ②）。
   *
   * ★ **给了这个端口才会发生枢纽同步**（与生产一致：端口缺席 = 老宿主，
   *   整个特性不发生）—— 老用例因此一个字节都不受影响。
   */
  tagHubs?: (folder: string) => string[];
  /** 预置的文件（`路径 → 内容`） */
  files?: Record<string, string>;
  /** 覆盖"列出某个目录下的索引笔记"（默认：目录下所有 .md） */
  indexNotes?: (folder: string) => string[];
  boardUri?: (path: string) => string;
  chunkSize?: number;
  debounceMs?: number;
  /** 让每一次写盘都抛错（模拟磁盘/权限问题） */
  failWrite?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const created: string[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const reads: string[] = [];
  const listed: string[] = [];
  let idleCalls = 0;
  let enabled = options.enabled ?? true;
  let folder = options.folder ?? 'idx';

  const ports: IndexNotePorts = {
    enabled: () => enabled,
    folder: () => folder,
    listBoards: async () => [...(options.boards ?? [])],
    read: async (path) => {
      reads.push(path);
      return files.get(path) ?? null;
    },
    create: async (path, content) => {
      if (options.failWrite === true) throw new Error('磁盘满了');
      // 真实 Vault 里 `create` 对已存在的路径会失败，这里如实模拟
      if (files.has(path)) throw new Error('file already exists');
      files.set(path, content);
      created.push(path);
    },
    write: async (path, content) => {
      if (options.failWrite === true) throw new Error('磁盘满了');
      if (!files.has(path)) throw new Error('file does not exist');
      files.set(path, content);
      written.push(path);
    },
    remove: async (path) => {
      files.delete(path);
      removed.push(path);
    },
    listIndexNotes: async (target) => {
      listed.push(target);
      if (options.indexNotes) return options.indexNotes(target);
      return [...files.keys()].filter(
        (path) => path.endsWith('.md') && (target === '' || path.startsWith(`${target}/`)),
      );
    },
    entryOf: (path) => options.entries?.[path] ?? null,
    linksOf: (path) => options.links?.[path] ?? [],
    cardTagsOf: (path) => options.cardTags?.[path] ?? [],
    ...(options.tagHubs
      ? {
          listTagHubs: async (target: string) => {
            listed.push(target);
            return options.tagHubs?.(target) ?? [];
          },
        }
      : {}),
    boardUri: options.boardUri,
    chunkSize: options.chunkSize ?? 20,
    debounceMs: options.debounceMs ?? 5,
    // 测试里不让出：让 `syncAll` 可被直接 `await`，同时把"让过几次"记下来
    scheduleIdle: (task) => {
      idleCalls += 1;
      task();
    },
  };

  const bridge = new IndexNoteBridge(ports);

  return {
    bridge,
    ports,
    files,
    created,
    written,
    removed,
    reads,
    listed,
    get idleCalls() {
      return idleCalls;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setFolder: (value: string) => {
      folder = value;
    },
    textOf: (path: string): string => files.get(path) ?? '',
    has: (path: string): boolean => files.has(path),
  };
}

function entry(title: string, overrides: Partial<IndexNoteEntry> = {}): IndexNoteEntry {
  return { title, tags: [], cardCount: 1, updatedAt: '', ...overrides };
}

const BOARD = 'Boards/A.nboard';
const NOTE = 'idx/Boards/A.md';

beforeEach(() => {
  setLocale('zh-cn');
});

describe('IndexNoteBridge · 该不该生成', () => {
  it('开关关着 → `disabled`，一个文件都不写', async () => {
    const harness = createHarness({
      enabled: false,
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
    });

    expect(await harness.bridge.syncBoard(BOARD)).toBe('disabled');
    expect(harness.files.size).toBe(0);
    expect((await harness.bridge.syncAll()).written).toBe(0);
  });

  it('注册表里没有这块板 → 跳过（不拿文件名凑一份"卡片数 0"的错数据出去）', async () => {
    const harness = createHarness({ boards: [BOARD], entries: {} });

    expect(await harness.bridge.syncBoard(BOARD)).toBe('skipped');
    expect(harness.files.size).toBe(0);
  });

  it('同步的路径 = 索引目录 + 镜像的库内层级', async () => {
    const harness = createHarness({
      folder: 'Boards/_index',
      boards: ['Deep/x/y.nboard'],
      entries: { 'Deep/x/y.nboard': entry('y') },
    });

    await harness.bridge.syncBoard('Deep/x/y.nboard');
    expect(harness.has('Boards/_index/Deep/x/y.md')).toBe(true);
  });
});

describe('IndexNoteBridge · 写什么', () => {
  it('内容就是 `renderIndexNote` 的产出（bridge 不做第二套渲染）', async () => {
    const links: IndexNoteLink[] = [
      { target: '周报', resolved: 'Notes/周报.md' },
      { target: '没有的', resolved: null },
    ];
    const harness = createHarness({
      boards: [BOARD],
      entries: { [BOARD]: entry('周报板', { tags: ['调研'], cardCount: 7 }) },
      links: { [BOARD]: links },
      boardUri: () => 'obsidian://nestboard?file=Boards%2FA.nboard',
    });

    await harness.bridge.syncBoard(BOARD);

    expect(harness.textOf(NOTE)).toBe(
      renderIndexNote({
        boardPath: BOARD,
        title: '周报板',
        tags: ['调研'],
        cardCount: 7,
        updatedAt: '',
        links,
        boardUri: 'obsidian://nestboard?file=Boards%2FA.nboard',
      }),
    );
  });

  it('没有 `boardUri` 端口时不写「打开这块白板」那一行', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);
    expect(harness.textOf(NOTE)).toContain(INDEX_NOTE_MARKER);
    expect(harness.textOf(NOTE)).not.toContain('打开这块白板');
  });

  it('目标路径不存在 → `create`；已存在（是我们的）→ `write`', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });

    expect(await harness.bridge.syncBoard(BOARD)).toBe('written');
    expect(harness.created).toEqual([NOTE]);
    expect(harness.written).toEqual([]);

    harness.ports.entryOf = () => entry('A', { cardCount: 9 });
    expect(await harness.bridge.syncBoard(BOARD)).toBe('written');
    expect(harness.written).toEqual([NOTE]);
    expect(harness.textOf(NOTE)).toContain('nestboard-cards: 9');
  });
});

describe('IndexNoteBridge · 最小化写盘（自动保存会不停地叫它）', () => {
  it('内容没变 → `unchanged`，一次写盘都没有', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);

    expect(await harness.bridge.syncBoard(BOARD)).toBe('unchanged');
    expect(harness.written).toEqual([]);
    expect(harness.created).toEqual([NOTE]);
  });

  it('内容没变时也要看一眼（不然手动改动永远纠正不回来）', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);

    const readsAfterFirst = harness.reads.length;
    await harness.bridge.syncBoard(BOARD);
    expect(harness.reads.length).toBeGreaterThan(readsAfterFirst);
  });

  it('用户手动删掉的笔记会被下一次同步重建（读不到就是读不到）', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);
    harness.files.delete(NOTE);

    expect(await harness.bridge.syncBoard(BOARD)).toBe('written');
    expect(harness.has(NOTE)).toBe(true);
  });

  it('磁盘上的内容被改过（还带标记）→ 覆盖回去（frontmatter 是查询的依据，不能任它偏离）', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);
    harness.files.set(NOTE, `${INDEX_NOTE_MARKER}\n被人手动改过`);

    expect(await harness.bridge.syncBoard(BOARD)).toBe('written');
    expect(harness.textOf(NOTE)).toContain('nestboard-board: "Boards/A.nboard"');
    expect(harness.textOf(NOTE)).not.toContain('被人手动改过');
  });
});

describe('IndexNoteBridge · 绝不覆盖用户的文件', () => {
  it('目标路径被非生成物占着 → 跳过，一个字都不动，并记进 `conflicts`', async () => {
    const harness = createHarness({
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
      files: { [NOTE]: '# 我自己的周报笔记\n别动我' },
    });

    expect(await harness.bridge.syncBoard(BOARD)).toBe('skipped');
    expect(harness.textOf(NOTE)).toBe('# 我自己的周报笔记\n别动我');
    expect(harness.written).toEqual([]);
    expect(harness.created).toEqual([]);
    expect(harness.bridge.conflicts()).toEqual([NOTE]);
  });

  it('用户后来把那个文件删了 → 下一次同步正常生成，`conflicts` 清空', async () => {
    const harness = createHarness({
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
      files: { [NOTE]: '我的笔记' },
    });
    await harness.bridge.syncBoard(BOARD);
    expect(harness.bridge.conflicts()).toEqual([NOTE]);

    harness.files.delete(NOTE);
    expect(await harness.bridge.syncBoard(BOARD)).toBe('written');
    expect(harness.bridge.conflicts()).toEqual([]);
  });

  it('`syncAll` 把冲突算进 `skipped`，不会因为一份同名文件就中断整轮', async () => {
    const harness = createHarness({
      boards: ['Boards/A.nboard', 'Boards/B.nboard'],
      entries: { 'Boards/A.nboard': entry('A'), 'Boards/B.nboard': entry('B') },
      files: { 'idx/Boards/A.md': '我的笔记' },
    });

    const stats = await harness.bridge.syncAll();
    expect(stats.skipped).toBe(1);
    expect(stats.written).toBe(1);
    expect(harness.has('idx/Boards/B.md')).toBe(true);
  });
});

describe('IndexNoteBridge · 自动保存路径（防抖 + 去重）', () => {
  it('同一块板连着攒两次只算一次', () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    harness.bridge.scheduleSync(BOARD);
    harness.bridge.scheduleSync(BOARD);
    expect(harness.bridge.pendingCount).toBe(1);
  });

  it('防抖期间不落盘；`drain` 之后落盘并清空队列', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    harness.bridge.scheduleSync(BOARD);
    expect(harness.has(NOTE)).toBe(false);

    await harness.bridge.drain();
    expect(harness.has(NOTE)).toBe(true);
    expect(harness.bridge.pendingCount).toBe(0);
  });

  it('开关关着时攒不动（不会在背后偷偷写）', () => {
    const harness = createHarness({
      enabled: false,
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
    });
    harness.bridge.scheduleSync(BOARD);
    expect(harness.bridge.pendingCount).toBe(0);
  });

  it('空队列 `drain` 是空操作', async () => {
    const harness = createHarness();
    await harness.bridge.drain();
    expect(harness.files.size).toBe(0);
  });
});

describe('IndexNoteBridge · 删除与改名', () => {
  it('板没了 → 收掉它的索引笔记', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);

    expect(await harness.bridge.removeBoard(BOARD)).toBe(true);
    expect(harness.has(NOTE)).toBe(false);
    expect(harness.removed).toEqual([NOTE]);
  });

  it('**开关关着**也照收：一份指向已删白板的笔记是坏数据', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);
    harness.setEnabled(false);

    expect(await harness.bridge.removeBoard(BOARD)).toBe(true);
    expect(harness.has(NOTE)).toBe(false);
  });

  it('目标路径不是我们的文件 → 不删', async () => {
    const harness = createHarness({ files: { [NOTE]: '我的笔记' } });
    expect(await harness.bridge.removeBoard(BOARD)).toBe(false);
    expect(harness.textOf(NOTE)).toBe('我的笔记');
  });

  it('收掉笔记的同时取消攒着的同步（不然防抖一触发它就长回来了）', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    harness.bridge.scheduleSync(BOARD);
    await harness.bridge.removeBoard(BOARD);
    await harness.bridge.drain();

    expect(harness.has(NOTE)).toBe(false);
  });

  it('改名 → 新位置有、旧位置收掉', async () => {
    const harness = createHarness({
      boards: ['Boards/A.nboard', 'Boards/B.nboard'],
      entries: { 'Boards/A.nboard': entry('A'), 'Boards/B.nboard': entry('B') },
    });
    await harness.bridge.syncBoard('Boards/A.nboard');

    expect(await harness.bridge.renameBoard('Boards/A.nboard', 'Boards/B.nboard')).toBe(true);
    expect(harness.has('idx/Boards/B.md')).toBe(true);
    expect(harness.has('idx/Boards/A.md')).toBe(false);
  });

  it('注册表还没跟上新路径 → **不**收旧的（宁可暂时多一份，也不能把笔记弄丢）', async () => {
    const harness = createHarness({
      boards: ['Boards/A.nboard'],
      entries: { 'Boards/A.nboard': entry('A') }, // 故意不给 B
    });
    await harness.bridge.syncBoard('Boards/A.nboard');

    expect(await harness.bridge.renameBoard('Boards/A.nboard', 'Boards/B.nboard')).toBe(false);
    expect(harness.has('idx/Boards/A.md')).toBe(true);
  });
});

describe('IndexNoteBridge · 迁移索引目录', () => {
  it('新目录写一遍、旧目录那份收掉（否则图谱里同一条边出现两次）', async () => {
    const harness = createHarness({
      folder: 'old',
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
    });
    await harness.bridge.syncBoard(BOARD);
    expect(harness.has('old/Boards/A.md')).toBe(true);

    harness.setFolder('new');
    const stats = await harness.bridge.relocate('old');

    expect(harness.has('new/Boards/A.md')).toBe(true);
    expect(harness.has('old/Boards/A.md')).toBe(false);
    expect(stats.removed).toBe(1);
  });

  it('新旧目录一样 → 什么都不收', async () => {
    const harness = createHarness({
      folder: 'idx',
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
    });
    await harness.bridge.syncBoard(BOARD);

    const stats = await harness.bridge.relocate('idx');
    expect(stats.removed).toBe(0);
    expect(harness.has(NOTE)).toBe(true);
  });

  it('旧目录里的"孤儿"（板早就不在了）也一并收掉', async () => {
    const harness = createHarness({
      folder: 'old',
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
      files: { 'old/Boards/Ghost.md': `${INDEX_NOTE_MARKER}\n旧残骸` },
    });

    harness.setFolder('new');
    await harness.bridge.relocate('old');
    expect(harness.has('old/Boards/Ghost.md')).toBe(false);
  });

  it('旧目录里的普通笔记不动（它不是我们的）', async () => {
    const harness = createHarness({
      folder: 'old',
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
      files: { 'old/Boards/我的笔记.md': '正文' },
    });

    harness.setFolder('new');
    await harness.bridge.relocate('old');
    expect(harness.has('old/Boards/我的笔记.md')).toBe(true);
  });
});

describe('IndexNoteBridge · 清理', () => {
  it('删掉"白板已不在"的笔记，留着活板的笔记', async () => {
    const harness = createHarness({
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
    });
    await harness.bridge.syncBoard(BOARD);
    harness.files.set('idx/Boards/Gone.md', `${INDEX_NOTE_MARKER}\n残骸`);

    const stats = await harness.bridge.cleanup();
    expect(stats.removed).toBe(1);
    expect(harness.has('idx/Boards/Gone.md')).toBe(false);
    expect(harness.has(NOTE)).toBe(true);
  });

  it('**开关关着**也能清理（用户关掉开关后正是最需要它的时候）', async () => {
    const harness = createHarness({
      enabled: false,
      files: { 'idx/Boards/Gone.md': `${INDEX_NOTE_MARKER}\n残骸` },
    });

    expect((await harness.bridge.cleanup()).removed).toBe(1);
  });

  it('清单里报了但不是我们的文件 → 不删（frontmatter 是线索，标记才是证据）', async () => {
    const harness = createHarness({
      indexNotes: () => ['idx/Boards/别人的.md', 'idx/Boards/我的.md'],
      files: {
        'idx/Boards/别人的.md': '我自己的笔记',
        'idx/Boards/我的.md': `${INDEX_NOTE_MARKER}\n残骸`,
      },
    });

    expect((await harness.bridge.cleanup()).removed).toBe(1);
    expect(harness.has('idx/Boards/别人的.md')).toBe(true);
    expect(harness.has('idx/Boards/我的.md')).toBe(false);
  });

  it('反推不出白板路径的路径不碰（宁可漏，不可误删）', async () => {
    const harness = createHarness({
      indexNotes: () => ['idx/怪东西.nboard'],
      files: { 'idx/怪东西.nboard': INDEX_NOTE_MARKER },
    });

    expect((await harness.bridge.cleanup()).removed).toBe(0);
    expect(harness.has('idx/怪东西.nboard')).toBe(true);
  });
});

describe('IndexNoteBridge · 整体撤销（`removeAll` / `listNotes`）', () => {
  it('`listNotes` 报出目录下由我们生成的笔记（「删除」命令确认框里的那个数字）', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);

    expect(await harness.bridge.listNotes()).toEqual([NOTE]);
  });

  it('连"白板还在"的也一起收 —— 这是整体撤销，不是清残骸', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);

    const stats = await harness.bridge.removeAll();
    expect(stats.removed).toBe(1);
    expect(harness.has(NOTE)).toBe(false);
  });

  it('**开关关着**也能整体撤销（用户关掉开关后正是最需要它的时候）', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    await harness.bridge.syncBoard(BOARD);
    harness.setEnabled(false);

    expect((await harness.bridge.removeAll()).removed).toBe(1);
  });

  it('目录里混着的用户笔记一个字都不动（清单是线索，标记才是证据）', async () => {
    const harness = createHarness({
      indexNotes: () => ['idx/别人的.md', 'idx/我的.md'],
      files: {
        'idx/别人的.md': '我自己的笔记',
        'idx/我的.md': `${INDEX_NOTE_MARKER}\n残骸`,
      },
    });

    expect((await harness.bridge.removeAll()).removed).toBe(1);
    expect(harness.textOf('idx/别人的.md')).toBe('我自己的笔记');
    expect(harness.has('idx/我的.md')).toBe(false);
  });

  it('目录空着 → 一份都不删（命令据此说"没有可清理的"，而不是静默地什么都不发生）', async () => {
    const harness = createHarness();
    expect(await harness.bridge.listNotes()).toEqual([]);
    expect((await harness.bridge.removeAll()).removed).toBe(0);
  });

  it('`dispose` 之后既列不出也删不掉', async () => {
    const harness = createHarness({ files: { [NOTE]: `${INDEX_NOTE_MARKER}\n残骸` } });
    harness.bridge.dispose();

    expect(await harness.bridge.listNotes()).toEqual([]);
    expect((await harness.bridge.removeAll()).removed).toBe(0);
    expect(harness.has(NOTE)).toBe(true);
  });
});

describe('IndexNoteBridge · 失败与收尾', () => {
  it('写盘抛错 → `failed`，其余板照常', async () => {
    const harness = createHarness({
      boards: ['Boards/A.nboard', 'Boards/B.nboard'],
      entries: { 'Boards/A.nboard': entry('A'), 'Boards/B.nboard': entry('B') },
      failWrite: true,
    });

    expect(await harness.bridge.syncBoard('Boards/A.nboard')).toBe('failed');
    const stats = await harness.bridge.syncAll();
    expect(stats.failed).toBe(2);
    expect(stats.written).toBe(0);
  });

  it('板多于一小时按片让出主线程', async () => {
    const harness = createHarness({
      chunkSize: 1,
      boards: ['A.nboard', 'B.nboard', 'C.nboard'],
      entries: {
        'A.nboard': entry('A'),
        'B.nboard': entry('B'),
        'C.nboard': entry('C'),
      },
    });

    const stats = await harness.bridge.syncAll();
    expect(stats.written).toBe(3);
    expect(harness.idleCalls).toBe(2); // 3 片之间让出 2 次
  });

  it('`dispose` 之后不再写、也不再有待办', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    harness.bridge.dispose();

    harness.bridge.scheduleSync(BOARD);
    expect(harness.bridge.pendingCount).toBe(0);
    expect(await harness.bridge.syncBoard(BOARD)).toBe('disabled');
    expect(harness.files.size).toBe(0);
  });

  it('路径映射与模型一致（bridge 不自己拼路径）', async () => {
    const harness = createHarness({
      folder: 'Boards/_index/',
      boards: [BOARD],
      entries: { [BOARD]: entry('A') },
    });
    await harness.bridge.syncBoard(BOARD);
    expect(harness.has(indexNotePathOf(BOARD, 'Boards/_index/'))).toBe(true);
  });
});

/**
 * `F1`：标签进 Obsidian 体系。
 *
 * ① 卡内标签并进索引笔记 frontmatter；② 每个标签一份**枢纽笔记**（用到它的白板清单）。
 */
describe('IndexNoteBridge × 标签（F1）', () => {
  const BOARD_B = 'Boards/B.nboard';
  const HUB_A = 'idx/_tags/纪要.md';

  it('① 卡内标签并进索引笔记 frontmatter（与白板级标签同一条 `tags:`）', async () => {
    const harness = createHarness({
      boards: [BOARD],
      entries: { [BOARD]: entry('A', { tags: ['白板级'] }) },
      cardTags: { [BOARD]: ['纪要', '白板级'] },
    });
    await harness.bridge.syncBoard(BOARD);
    const text = harness.textOf(NOTE);
    expect(text).toContain('  - "白板级"');
    expect(text).toContain('  - "纪要"');
    // 同一个标签（白板级 + 卡内都写过）只出现一次
    expect(text.match(/- "白板级"/g)?.length).toBe(1);
  });

  it('② 枢纽笔记：标签 → 用到它的白板清单（卡内标签也算来源，按路径排序）', async () => {
    const harness = createHarness({
      tagHubs: () => [],
      boards: [BOARD_B, BOARD],
      entries: {
        [BOARD]: entry('A 板', { tags: ['纪要'] }),
        [BOARD_B]: entry('B 板'),
      },
      cardTags: { [BOARD_B]: ['纪要'] },
    });
    const stats = await harness.bridge.syncTagHubs();

    expect(stats.written).toBe(1); // 只有"纪要"一个标签（两块板共用一份枢纽页）
    const hub = harness.textOf(HUB_A);
    expect(hub).toContain('# #纪要');
    const a = hub.indexOf('[[idx/Boards/A|A 板]]');
    const b = hub.indexOf('[[idx/Boards/B|B 板]]');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);

    // 幂等：再同步一次不写盘
    harness.written.length = 0;
    const again = await harness.bridge.syncTagHubs();
    expect(again.written).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  it('★ 目标路径被用户自己的笔记占着 ⇒ 跳过 + 记进 conflicts（绝不覆盖）', async () => {
    const harness = createHarness({
      tagHubs: () => [HUB_A],
      files: { [HUB_A]: '# 我自己写的纪要页' },
      boards: [BOARD],
      entries: { [BOARD]: entry('A', { tags: ['纪要'] }) },
    });
    await harness.bridge.syncTagHubs();
    expect(harness.textOf(HUB_A)).toBe('# 我自己写的纪要页');
    expect(harness.bridge.conflicts()).toContain(HUB_A);
  });

  it('★ 不再被任何白板用到的标签 ⇒ 枢纽页被收掉（认标记才删）', async () => {
    const stale = 'idx/_tags/旧标签.md';
    const harness = createHarness({
      tagHubs: () => [stale],
      files: { [stale]: `${'<!-- nestboard:tag-hub -->'}\n# #旧标签\n` },
      boards: [BOARD],
      entries: { [BOARD]: entry('A', { tags: ['纪要'] }) },
    });
    const stats = await harness.bridge.syncTagHubs();
    expect(stats.removed).toBe(1);
    expect(harness.has(stale)).toBe(false);

    // 用户自己的同名文件（没标记）不删
    const mine = 'idx/_tags/我的.md';
    const harness2 = createHarness({
      tagHubs: () => [mine],
      files: { [mine]: '# 我的标签页' },
      boards: [BOARD],
      entries: { [BOARD]: entry('A', { tags: ['纪要'] }) },
    });
    await harness2.bridge.syncTagHubs();
    expect(harness2.has(mine)).toBe(true);
  });

  it('★ `syncAll` 顺带把枢纽写完；`removeAll` 把枢纽一起收（整体退订要退干净）', async () => {
    // 清单端口给一份"活的"视图：`removeAll` 靠它找到要收的枢纽页（与生产实现同一条路）
    let hubs: string[] = [];
    const harness = createHarness({
      tagHubs: () => hubs,
      boards: [BOARD],
      entries: { [BOARD]: entry('A', { tags: ['纪要'] }) },
    });
    const stats = await harness.bridge.syncAll();
    expect(stats.written).toBe(2); // 索引笔记 + 枢纽页
    expect(harness.has(HUB_A)).toBe(true);

    hubs = [HUB_A];
    const removed = await harness.bridge.removeAll();
    expect(removed.removed).toBe(2);
    expect(harness.has(HUB_A)).toBe(false);
    expect(harness.has(NOTE)).toBe(false);
  });

  it('端口缺席（老宿主）⇒ 整个特性不发生（一个文件都不多）', async () => {
    const harness = createHarness({ boards: [BOARD], entries: { [BOARD]: entry('A') } });
    const stats = await harness.bridge.syncTagHubs();
    expect(stats).toEqual({ written: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0 });
  });
});
