/**
 * BoardRepository 集成测试（04 §12.1：数据安全相关路径**必须**有测试）。
 *
 * 覆盖 03 §3.2 的六条硬性规则：原子写、防抖、外部改动重载、冲突三选一、只读保护。
 * 这些用例是"数据安全承诺"的可执行版本 —— 改动 Repository 时先看这里有没有红。
 */

import { describe, expect, it } from 'vitest';
import { BoardRepository, serializeBoard } from '../../io/BoardRepository';
import type { BoardRepositoryEvents } from '../../io/BoardRepository';
import { createBoardFile, createCard } from '../../model/factories';
import type { BoardFile } from '../../model/schema';
import { buildBenchmarkBoard } from '../benchmark/benchmarkBoard';
import { MemoryVaultIO } from '../helpers/memoryVault';

const PATH = 'Boards/A.nboard';
const SECOND = 'Boards/B.nboard';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(overrides: { revision?: number; title?: string } = {}): BoardFile {
  return createBoardFile({
    revision: overrides.revision ?? 1,
    meta: { id: 'nb_a', title: overrides.title ?? 'A' },
  });
}

function setup(
  options: {
    board?: BoardFile;
    content?: string;
    saveDebounceMs?: number;
    reloadDebounceMs?: number;
    now?: () => number;
  } = {},
): { vault: MemoryVaultIO; repo: BoardRepository } {
  const board = options.board ?? fixture();
  const vault = new MemoryVaultIO({ [PATH]: options.content ?? serializeBoard(board) });
  const repo = new BoardRepository(vault, {
    saveDebounceMs: options.saveDebounceMs ?? 5,
    reloadDebounceMs: options.reloadDebounceMs ?? 5,
    ...(options.now ? { now: options.now } : {}),
  });
  return { vault, repo };
}

function readBoard(vault: MemoryVaultIO, path = PATH): BoardFile {
  return JSON.parse(vault.files.get(path) ?? '{}') as BoardFile;
}

// ─────────────────────────────────────────────────────────────
// 读路径（T1.10）
// ─────────────────────────────────────────────────────────────

describe('打开白板（T1.10）', () => {
  it('磁盘 → 迁移 → 规范化 → 内存模型', async () => {
    const board = createBoardFile({
      revision: 5,
      meta: { id: 'nb_a', title: 'A' },
      cards: [createCard('note', { title: '卡' })],
    });
    const { repo } = setup({ board });

    const opened = await repo.open(PATH);
    expect(opened?.revision).toBe(5);
    expect(repo.getState(PATH)).toBe('clean');
    expect(repo.get(PATH)?.cards).toHaveLength(1);
    expect(repo.getIssues(PATH)).toEqual([]);
  });

  it('重复 open 直接返回内存模型，不重复读盘', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    vault.files.set(PATH, '{ 坏掉的 json');
    const again = await repo.open(PATH);
    expect(again?.revision).toBe(1);
  });
});

describe('只读保护态（T1.13 / W6：解析失败绝不覆盖）', () => {
  it('JSON 损坏 → readonly，保留原文，拒绝修改，且磁盘内容分毫未动', async () => {
    const broken = '{ 坏掉的 json';
    const { vault, repo } = setup({ content: broken });
    const reasons: string[] = [];
    repo.on('protected', (payload) => reasons.push(payload.reason));

    await repo.open(PATH);
    expect(reasons).toEqual(['invalid-json']);
    expect(repo.getState(PATH)).toBe('readonly');
    expect(repo.get(PATH)).toBeNull();
    expect(repo.getRawText(PATH)).toBe(broken);

    expect(() =>
      repo.mutate(PATH, (board) => {
        board.meta.title = 'x';
      }),
    ).toThrow();
    await repo.flush(PATH);
    expect(vault.files.get(PATH)).toBe(broken);
    expect(vault.writeLog).toEqual([]);
  });

  it('由更高版本写入（future-version）→ readonly，不尝试猜测结构', async () => {
    const future = JSON.stringify({ spec: 'nestboard/2', version: 99, cards: [] });
    const { repo } = setup({ content: future });
    const reasons: string[] = [];
    repo.on('protected', (payload) => reasons.push(payload.reason));

    await repo.open(PATH);
    expect(reasons).toEqual(['future-version']);
    expect(repo.isReadOnly(PATH)).toBe(true);
  });

  it('settings.readOnly 的白板拒绝改动（归档板防误编辑）', async () => {
    const board = createBoardFile({
      revision: 1,
      meta: { id: 'nb_a' },
      settings: { readOnly: true },
    });
    const { repo } = setup({ board });
    await repo.open(PATH);
    expect(() =>
      repo.mutate(PATH, (value) => {
        value.meta.title = 'x';
      }),
    ).toThrow(/只读/);
  });
});

// ─────────────────────────────────────────────────────────────
// 归档锁定（T4.06 / 03 §2.5：settings.readOnly）
// ─────────────────────────────────────────────────────────────

describe('归档锁定（T4.06）', () => {
  function locked(): BoardFile {
    return createBoardFile({
      revision: 1,
      meta: { id: 'nb_a' },
      settings: { readOnly: true },
    });
  }

  it('★ isReadOnly 认得归档锁定 —— 视图六十多处写入口问的都是它', async () => {
    const { repo } = setup({ board: locked() });
    await repo.open(PATH);
    // 这一条是 T4.06 的核心：曾经只有 `requireWritableBoard` 认得锁，
    // 于是工具条照常亮着，点下去抛异常（"亮着但点不动"）
    expect(repo.isReadOnly(PATH)).toBe(true);
    expect(repo.isLocked(PATH)).toBe(true);
    expect(repo.lockReason(PATH)).toBe('locked');
  });

  it('保护态与归档锁定分得开：都是只读，但原因不同（提示文案不同）', async () => {
    const { repo } = setup({ content: '{ 坏掉的 json' });
    await repo.open(PATH);
    expect(repo.isReadOnly(PATH)).toBe(true);
    expect(repo.lockReason(PATH)).toBe('protected');
    // ★ 保护态**不算**用户锁的：它的提示条不该出现"点这里解锁"
    expect(repo.isLocked(PATH)).toBe(false);
  });

  it('没打开的路径不是只读（视图靠 currentPath 判空，不能反过来说只读）', () => {
    const { repo } = setup();
    expect(repo.isReadOnly(PATH)).toBe(false);
    expect(repo.lockReason(PATH)).toBeNull();
  });

  it('setLocked 递增 revision 并**在返回前**把锁写进文件', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);

    expect(await repo.setLocked(PATH, true)).toBe(true);
    expect(repo.get(PATH)?.settings.readOnly).toBe(true);
    // 锁是一次内容变更：它得进 revision，否则同步时不参与冲突判定
    expect(repo.get(PATH)?.revision).toBe(2);
    // ★ 返回即落盘：`await` 之后磁盘上就该已经有这把锁了
    expect(readBoard(vault).settings.readOnly).toBe(true);

    await repo.flush(PATH);
    expect(readBoard(vault).revision).toBe(2);
  });

  it('setLocked 能解开自己上的锁（锁定板上唯一放行的写操作）', async () => {
    const { vault, repo } = setup({ board: locked() });
    await repo.open(PATH);

    expect(await repo.setLocked(PATH, false)).toBe(true);
    expect(repo.isReadOnly(PATH)).toBe(false);
    expect(readBoard(vault).settings.readOnly).toBe(false);
  });

  it('已经是目标状态 → false，不白白递增 revision', async () => {
    const { repo } = setup();
    await repo.open(PATH);

    expect(await repo.setLocked(PATH, true)).toBe(true);
    const revision = repo.get(PATH)?.revision;
    expect(await repo.setLocked(PATH, true)).toBe(false);
    expect(repo.get(PATH)?.revision).toBe(revision);
  });

  it('保护态拒绝 setLocked：内存模型可能是空的，写回去就是毁文件', async () => {
    const broken = '{ 坏掉的 json';
    const { vault, repo } = setup({ content: broken });
    await repo.open(PATH);

    expect(await repo.setLocked(PATH, true)).toBe(false);
    expect(vault.files.get(PATH)).toBe(broken);
    expect(vault.writeLog).toEqual([]);
  });

  it('锁上之后视口照常跟随，但**不再写盘**（视口也会改文件，那是纯噪声同步）', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    await repo.setLocked(PATH, true);
    const writes = vault.writeLog.length;
    const onDisk = readBoard(vault).view.zoom;

    repo.updateView(PATH, { zoom: 2 });
    await repo.flush(PATH);

    // 内存里跟上了（用户还要继续看图），磁盘上一个字节都没动
    expect(repo.get(PATH)?.view.zoom).toBe(2);
    expect(vault.writeLog.length).toBe(writes);
    expect(readBoard(vault).view.zoom).toBe(onDisk);
  });
});

// ─────────────────────────────────────────────────────────────
// 写路径（T1.11）
// ─────────────────────────────────────────────────────────────

describe('内存变更与落盘（T1.11）', () => {
  it('mutate 递增 revision 并广播 changed', async () => {
    const { repo } = setup();
    await repo.open(PATH);

    const revisions: number[] = [];
    repo.on('changed', (payload) => revisions.push(payload.board.revision));

    repo.mutate(PATH, (board) => {
      board.cards.push(createCard('note', { title: '新卡' }));
    });

    expect(repo.get(PATH)?.revision).toBe(2);
    expect(repo.getState(PATH)).toBe('dirty');
    expect(revisions).toEqual([2]);
  });

  it('mutator 返回 false = 什么都没改 → 不递增 revision、不标脏、不发 changed（T1.31）', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);

    const changes: number[] = [];
    repo.on('changed', (payload) => changes.push(payload.board.revision));
    vault.writeLog.length = 0;

    // "把已经压在顶层的卡片再置顶一次"就是这个语义：操作合法，但结果与现状相同
    const applied = repo.mutate(PATH, () => false);

    expect(applied).toBe(false);
    expect(repo.get(PATH)?.revision).toBe(1);
    expect(repo.getState(PATH)).toBe('clean');
    expect(changes).toEqual([]);

    await delay(30);
    expect(vault.writeLog).toEqual([]);
  });

  it('mutator 返回 true / undefined 一律按"改过了"处理（兼容既有调用方）', async () => {
    const { repo } = setup();
    await repo.open(PATH);
    expect(repo.mutate(PATH, () => true)).toBe(true);
    expect(repo.mutate(PATH, () => undefined)).toBe(true);
    expect(repo.get(PATH)?.revision).toBe(3);
  });

  it('flush 落盘：2 空格缩进、末尾换行、只写一次', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    vault.writeLog.length = 0;

    repo.mutate(PATH, (board) => {
      board.cards.push(createCard('note', { title: '新卡' }));
    });
    await repo.flush(PATH);

    const text = vault.files.get(PATH) ?? '';
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "spec"'); // 2 空格缩进
    expect(readBoard(vault).revision).toBe(2);
    expect(readBoard(vault).cards).toHaveLength(1);
    expect(repo.getState(PATH)).toBe('clean');
    expect(vault.writeLog).toEqual([PATH]);
  });

  it('落盘时刷新 meta.updatedAt（注入时钟）', async () => {
    const { vault, repo } = setup({ now: () => Date.parse('2026-09-11T00:00:00.000Z') });
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = 'x';
    });
    await repo.flush(PATH);
    expect(readBoard(vault).meta.updatedAt).toBe('2026-09-11T00:00:00.000Z');
  });

  it('自动保存：防抖窗口内不写盘，窗口过后自动落盘（W5）', async () => {
    const { vault, repo } = setup({ saveDebounceMs: 20 });
    await repo.open(PATH);
    vault.writeLog.length = 0;

    repo.mutate(PATH, (board) => {
      board.meta.title = '改了';
    });
    expect(vault.writeLog).toEqual([]); // 还没到时间

    await delay(60);
    expect(vault.writeLog).toEqual([PATH]);
    expect(readBoard(vault).meta.title).toBe('改了');
  });

  it('updateView 只写视口、不递增 revision（W3）', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);

    repo.updateView(PATH, { zoom: 2, x: 30 });
    expect(repo.get(PATH)?.revision).toBe(1);
    expect(repo.get(PATH)?.view.zoom).toBe(2);

    await repo.flush(PATH);
    expect(readBoard(vault).revision).toBe(1);
    expect(readBoard(vault).view.zoom).toBe(2);
    expect(readBoard(vault).view.x).toBe(30);
  });

  it('updateView **不发 changed**（否则平移会让卡片层每帧重渲染）', async () => {
    const { repo } = setup();
    await repo.open(PATH);

    const revisions: number[] = [];
    repo.on('changed', (payload) => revisions.push(payload.board.revision));

    repo.updateView(PATH, { x: 10 });
    repo.updateView(PATH, { y: 20 });
    repo.updateView(PATH, { zoom: 1.5 });

    expect(revisions).toEqual([]);
  });

  it('只读保护态下 updateView 一个字节都不写', async () => {
    const broken = '{ 坏掉的 json';
    const { vault, repo } = setup({ content: broken });
    await repo.open(PATH);

    repo.updateView(PATH, { zoom: 3 });
    await repo.flush(PATH);

    expect(vault.files.get(PATH)).toBe(broken);
    expect(vault.writeLog).toEqual([]);
  });

  it('冲突未决时 updateView 只改内存、不排盘、不把状态降级成 dirty', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '我的改动';
    });
    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 99 })));
    await repo.flush(PATH);
    expect(repo.getState(PATH)).toBe('conflict');

    vault.writeLog.length = 0;
    repo.updateView(PATH, { zoom: 4 });
    await delay(40);

    expect(vault.writeLog).toEqual([]);
    expect(repo.getState(PATH)).toBe('conflict');
    expect(repo.get(PATH)?.view.zoom).toBe(4);
  });

  it('flushAll 把所有已打开的白板一次落盘（T1.12）', async () => {
    const vault = new MemoryVaultIO({
      [PATH]: serializeBoard(fixture()),
      [SECOND]: serializeBoard(createBoardFile({ revision: 1, meta: { id: 'nb_b' } })),
    });
    const repo = new BoardRepository(vault, { saveDebounceMs: 1000 });
    await repo.open(PATH);
    await repo.open(SECOND);
    vault.writeLog.length = 0;

    repo.mutate(PATH, (board) => {
      board.meta.title = 'A2';
    });
    repo.mutate(SECOND, (board) => {
      board.meta.title = 'B2';
    });
    await repo.flushAll();

    expect([...vault.writeLog].sort()).toEqual([PATH, SECOND].sort());
    expect(readBoard(vault).meta.title).toBe('A2');
    expect(readBoard(vault, SECOND).meta.title).toBe('B2');
  });
});

// ─────────────────────────────────────────────────────────────
// 冲突（T1.13）
// ─────────────────────────────────────────────────────────────

describe('冲突检测与三选一（T1.13 / 03 §3.4）', () => {
  it('磁盘 revision 更高 → 冲突，磁盘内容不被覆盖，本地改动留在内存', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '我的改动';
    });

    const conflicts: BoardRepositoryEvents['conflict'][] = [];
    repo.on('conflict', (payload) => conflicts.push(payload));

    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 99, title: '外部版本' })));
    await repo.flush(PATH);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe('disk-newer');
    expect(conflicts[0].disk?.revision).toBe(99);
    expect(repo.getState(PATH)).toBe('conflict');

    // 磁盘保持外部版本（原子写 + transform 抛错 → 未写入）
    expect(readBoard(vault).revision).toBe(99);
    expect(readBoard(vault).meta.title).toBe('外部版本');
    // 本地改动仍在内存，没丢
    expect(repo.get(PATH)?.meta.title).toBe('我的改动');
  });

  it('磁盘文件损坏到无法解析 → 拒绝盲写（disk-unparsable）', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '我的改动';
    });

    const conflicts: BoardRepositoryEvents['conflict'][] = [];
    repo.on('conflict', (payload) => conflicts.push(payload));

    vault.externalWrite(PATH, '{ 半个 json');
    await repo.flush(PATH);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe('disk-unparsable');
    expect(conflicts[0].disk).toBeNull();
    expect(vault.files.get(PATH)).toBe('{ 半个 json');
  });

  it('冲突后不自动重试（避免连环弹窗），直到用户决策', async () => {
    const { vault, repo } = setup({ saveDebounceMs: 5 });
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '我的改动';
    });
    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 99 })));

    const conflicts: BoardRepositoryEvents['conflict'][] = [];
    repo.on('conflict', (payload) => conflicts.push(payload));

    await repo.flush(PATH);
    await delay(60);
    expect(conflicts).toHaveLength(1);
  });

  it('选项①用磁盘版本：内存切回磁盘内容', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '我的改动';
    });
    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 99, title: '外部版本' })));
    await repo.flush(PATH);

    await repo.useDisk(PATH);
    expect(repo.get(PATH)?.revision).toBe(99);
    expect(repo.get(PATH)?.meta.title).toBe('外部版本');
    expect(repo.getState(PATH)).toBe('clean');
  });

  it('选项②保留我的修改：revision 被推到磁盘版本之上，避免反复冲突', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '我的改动';
    });
    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 99, title: '外部版本' })));
    await repo.flush(PATH);

    await repo.keepMine(PATH);

    expect(readBoard(vault).meta.title).toBe('我的改动');
    expect(readBoard(vault).revision).toBe(100);
    expect(repo.getState(PATH)).toBe('clean');
  });

  it('选项③另存为副本：本地改动先落进副本，内存切回磁盘版本', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '我的改动';
    });
    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 99, title: '外部版本' })));
    await repo.flush(PATH);

    const copyPath = 'Boards/A (conflict).nboard';
    await repo.saveAsCopy(PATH, copyPath);

    expect(readBoard(vault, copyPath).meta.title).toBe('我的改动');
    expect(readBoard(vault).meta.title).toBe('外部版本');
    expect(repo.get(PATH)?.meta.title).toBe('外部版本');
    expect(repo.getState(PATH)).toBe('clean');
  });
});

// ─────────────────────────────────────────────────────────────
// 外部改动（W4）
// ─────────────────────────────────────────────────────────────

describe('外部改动识别（W4）', () => {
  it('自己发起的写入不触发重载', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);

    const reloads: number[] = [];
    repo.on('reloaded', (payload) => reloads.push(payload.board.revision));

    repo.writingPaths.add(PATH); // 模拟正在写盘
    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 50 })));
    repo.handleExternalModify(PATH);
    await delay(30);
    expect(reloads).toEqual([]);

    repo.writingPaths.delete(PATH);
    repo.handleExternalModify(PATH);
    await delay(30);
    expect(reloads).toEqual([50]);
    expect(repo.get(PATH)?.revision).toBe(50);
  });

  it('磁盘 revision 不高于基线 → 视为无变化，不重载', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);

    const reloads: number[] = [];
    repo.on('reloaded', () => reloads.push(1));

    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 1, title: '同名同版本' })));
    repo.handleExternalModify(PATH);
    await delay(30);
    expect(reloads).toEqual([]);
  });

  it('外部改动 + 本地有未保存改动 → 冲突，内存不被覆盖', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '本地';
    });

    const conflicts: BoardRepositoryEvents['conflict'][] = [];
    repo.on('conflict', (payload) => conflicts.push(payload));

    vault.externalWrite(PATH, serializeBoard(fixture({ revision: 50, title: '外部' })));
    repo.handleExternalModify(PATH);
    await delay(30);

    expect(conflicts).toHaveLength(1);
    expect(repo.get(PATH)?.meta.title).toBe('本地');
    expect(repo.getState(PATH)).toBe('conflict');
  });
});

// ─────────────────────────────────────────────────────────────
// 保存性能（T2.15）
// ─────────────────────────────────────────────────────────────

describe('保存性能（T2.15）', () => {
  /**
   * 实测结论（M 系列 Mac）：1000 卡 `serializeBoard` 中位数约 1ms、5000 卡约 5ms，
   * 距离 `02 §8.1` 的 120ms 预算有两个数量级余量 —— 因此**不改**增量/分片序列化
   * （那会牺牲"人类可读、git diff 友好"这条既有收益，换一个根本用不上的速度）。
   *
   * 这里留下的是**防退化护栏**：哪天有人给序列化塞进 O(n²) 的活（比如逐卡查找 id 唯一性），
   * 预算会立刻被打穿并在这里变红。
   */
  it('1000 卡全量序列化在 120ms 预算内', () => {
    const board = buildBenchmarkBoard(1000);
    serializeBoard(board); // 预热，别把 JIT 首次编译算进基线

    const startedAt = Date.now();
    const text = serializeBoard(board);
    const elapsed = Date.now() - startedAt;

    expect(text.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(120);
  });

  it('经 Repository 写盘时耗时被记入画像且不超预算', async () => {
    const board = buildBenchmarkBoard(1000);
    const { repo } = setup({ board });
    await repo.open(PATH);

    repo.mutate(PATH, (draft) => {
      draft.meta.title = 'benchmark';
    });
    await repo.flush(PATH);

    const stats = repo.statsOf(PATH);
    expect(stats).not.toBeNull();
    expect(stats?.serializeMs).toBeLessThan(120);
    expect(stats?.totalMs).toBeLessThan(120);
  });
});

// ─────────────────────────────────────────────────────────────
// 写盘画像（T2.17 诊断面板的数据来源）
// ─────────────────────────────────────────────────────────────

describe('写盘耗时画像（T2.17）', () => {
  it('每次写盘后记下序列化 / 写盘两段耗时与版本号', async () => {
    // 注入时钟：每次读取自增 1ms，于是两段耗时都是确定的小正数，
    // 不受机器快慢影响（这里要验的是"记了没有、拆得对不对"，不是绝对速度）
    let tick = 0;
    const { repo } = setup({ now: () => (tick += 1) });
    await repo.open(PATH);

    // 还没写过：必须是 null，而不是编一个 0 出来（面板要能显示"尚无记录"）
    expect(repo.statsOf(PATH)).toBeNull();

    repo.mutate(PATH, (board) => {
      board.meta.title = 'x';
    });
    await repo.flush(PATH);

    const stats = repo.statsOf(PATH);
    expect(stats).not.toBeNull();
    expect(stats?.serializeMs).toBeGreaterThan(0);
    expect(stats?.writeMs).toBeGreaterThan(0);
    // 总数必须是两段之和：面板拿它做阈值判断，对不上就等于在骗人
    expect(stats?.totalMs).toBe((stats?.serializeMs ?? 0) + (stats?.writeMs ?? 0));
    // 记的是**这份 payload** 的版本号
    expect(stats?.revision).toBe(2);
  });

  it('没走写盘路径（只读保护态）时不记录', async () => {
    let tick = 0;
    const { repo } = setup({ content: '{ 坏掉的 json', now: () => (tick += 1) });
    await repo.open(PATH);

    // 只读态下 `mutate` 会直接抛（拒绝修改），这里走"只改内存不写盘"的 updateView
    repo.updateView(PATH, { zoom: 2 });
    await repo.flush(PATH);

    expect(repo.statsOf(PATH)).toBeNull();
  });

  it('未打开的路径返回 null（面板不该为了显示数字去开一块板）', () => {
    const { repo } = setup();
    expect(repo.statsOf(PATH)).toBeNull();
    expect(repo.statsOf(SECOND)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 新建 / 关闭 / 卸载
// ─────────────────────────────────────────────────────────────

describe('新建与生命周期', () => {
  it('createBoard 写文件并接管为当前会话', async () => {
    const vault = new MemoryVaultIO();
    const repo = new BoardRepository(vault);
    const board = createBoardFile({ meta: { id: 'nb_new', title: '新板' } });

    await repo.createBoard('Boards/新板.nboard', board);

    expect(vault.files.has('Boards/新板.nboard')).toBe(true);
    expect(repo.get('Boards/新板.nboard')?.meta.title).toBe('新板');
    expect(repo.getState('Boards/新板.nboard')).toBe('clean');
  });

  it('dispose 后不再持有会话与计时器', async () => {
    const { repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = 'x';
    });
    repo.dispose();
    expect(repo.openPaths()).toEqual([]);
    expect(repo.get(PATH)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 重命名 / 移动（T1.73）
// ─────────────────────────────────────────────────────────────

/**
 * session 是按**路径**索引的，而文件会被改名。
 *
 * 这两件事凑在一起时坏得很难看：视图按新路径 `get()` 拿到 `null`（画布当场变空），
 * 而旧 key 上的防抖保存继续往一个**已经不存在的路径**写。两种失败都不报错 ——
 * 所以只能靠这里的用例钉住。
 */
describe('重命名 / 移动白板（T1.73）', () => {
  it('改名后新路径拿到的是同一份内存模型，旧路径不再有会话', async () => {
    const { repo } = setup();
    await repo.open(PATH);
    const before = repo.get(PATH);

    repo.movePath(PATH, SECOND);

    expect(repo.isOpen(PATH)).toBe(false);
    expect(repo.get(PATH)).toBeNull();
    // 同一个对象引用：视图上已经挂着的卡片没必要重挂一遍
    expect(repo.get(SECOND)).toBe(before);
    expect(repo.openPaths()).toEqual([SECOND]);
  });

  it('还没落盘的改动跟着走，随后的保存写进新路径', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '改过';
    });
    expect(repo.getState(PATH)).toBe('dirty');

    repo.movePath(PATH, SECOND);
    await repo.flush(SECOND);

    expect(readBoard(vault, SECOND).meta.title).toBe('改过');
    expect(repo.getState(SECOND)).toBe('clean');
  });

  it('只读保护态跟着走：改名不会把一块坏文件变成可写', async () => {
    const broken = '{ 坏掉的 json';
    const { repo } = setup({ content: broken });
    await repo.open(PATH);
    expect(repo.getState(PATH)).toBe('readonly');

    repo.movePath(PATH, SECOND);

    expect(repo.getState(SECOND)).toBe('readonly');
    expect(repo.getRawText(SECOND)).toBe(broken);
    expect(() =>
      repo.mutate(SECOND, (board) => {
        board.meta.title = 'x';
      }),
    ).toThrow();
  });

  it('没打开的板改名时什么也不做（不凭空造一个会话）', () => {
    const { repo } = setup();
    repo.movePath(PATH, SECOND);
    expect(repo.openPaths()).toEqual([]);
  });

  it('目标路径已被占用时不搬，宁可不动也不顶掉另一块板', async () => {
    const { vault, repo } = setup();
    await repo.open(PATH);
    vault.files.set(SECOND, serializeBoard(createBoardFile({ meta: { id: 'nb_b', title: 'B' } })));
    await repo.open(SECOND);
    const otherBoard = repo.get(SECOND);

    repo.movePath(PATH, SECOND);

    expect(repo.get(SECOND)).toBe(otherBoard);
    expect(repo.get(PATH)).not.toBeNull();
  });

  it('新旧路径相同时是纯 no-op', async () => {
    const { repo } = setup();
    await repo.open(PATH);
    repo.movePath(PATH, PATH);
    expect(repo.isOpen(PATH)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 快照挂钩与恢复（T4.01 / T4.02）
// ─────────────────────────────────────────────────────────────

describe('保存观察者与快照恢复', () => {
  interface SavedPayload {
    path: string;
    boardId: string;
    revision: number;
    text: string;
  }

  function setupWithObserver(observer: { afterSave: (payload: SavedPayload) => void }): {
    vault: MemoryVaultIO;
    repo: BoardRepository;
  } {
    const vault = new MemoryVaultIO({ [PATH]: serializeBoard(fixture()) });
    const repo = new BoardRepository(vault, { saveDebounceMs: 5, observer });
    return { vault, repo };
  }

  it('写盘成功后通知观察者，带上刚写下去那份的 path / boardId / revision / text', async () => {
    const seen: SavedPayload[] = [];
    const { vault, repo } = setupWithObserver({ afterSave: (payload) => seen.push(payload) });
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '改了';
    });
    await repo.flush(PATH);

    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe(PATH);
    expect(seen[0].boardId).toBe('nb_a');
    // ★ 必须是"刚写下去那份"的文本，而不是内存模型的实时状态：
    //   观察者（快照）拿它直接落盘，差一个字节就存下了一份不存在的内容
    expect(seen[0].text).toBe(vault.files.get(PATH));
    expect(seen[0].revision).toBe(readBoard(vault).revision);
  });

  it('观察者抛错也不影响保存结果（快照坏了不能不让存盘）', async () => {
    const { vault, repo } = setupWithObserver({
      afterSave: () => {
        throw new Error('快照炸了');
      },
    });
    await repo.open(PATH);
    repo.mutate(PATH, (board) => {
      board.meta.title = '照样存';
    });
    await repo.flush(PATH);

    expect(readBoard(vault).meta.title).toBe('照样存');
    expect(repo.getState(PATH)).toBe('clean');
  });

  it('restore 把快照内容写回磁盘，并把 revision 推到磁盘版本之上', async () => {
    const { vault, repo } = setup({ board: fixture({ revision: 7 }) });
    await repo.open(PATH);

    await repo.restore(PATH, fixture({ revision: 1, title: '旧标题' }));

    const disk = readBoard(vault);
    expect(disk.meta.title).toBe('旧标题');
    // ★ 不推到磁盘之上，下一次自动保存会立刻被判成冲突 —— "恢复完就再也存不上"
    expect(disk.revision).toBe(8);
    expect(repo.get(PATH)?.meta.title).toBe('旧标题');
    expect(repo.getState(PATH)).toBe('clean');
  });

  it('磁盘文件损坏（只读保护态）时仍能从快照恢复 —— 这正是 W6 给出的出口', async () => {
    const vault = new MemoryVaultIO({ [PATH]: '{ 坏掉的 json' });
    const repo = new BoardRepository(vault, { saveDebounceMs: 5 });
    await repo.open(PATH);
    expect(repo.getState(PATH)).toBe('readonly');

    await repo.restore(PATH, fixture({ revision: 1, title: '恢复的' }));

    expect(repo.getState(PATH)).not.toBe('readonly');
    expect(readBoard(vault).meta.title).toBe('恢复的');
  });

  it('未打开的白板不能恢复（宁可报错也不凭空造会话）', async () => {
    const { repo } = setup();
    await expect(repo.restore(PATH, fixture())).rejects.toThrow();
  });
});
