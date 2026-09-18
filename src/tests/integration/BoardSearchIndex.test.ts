/**
 * 跨白板搜索索引单测（T7.02 / `F8-08`）。
 *
 * 这个类里"能跑通"和"跑对了"差得很远，所以下面钉的几乎全是**时序**：
 *
 *   1. **懒启动**（`R4`）：构造完一个字节都不许读。它的整份模型比链接索引重得多，
 *      "没打开过这个功能的人也付钱"是不能接受的；
 *   2. **扫描期间的增量改动不被覆盖**：这是全文件最容易写错的一条。用户正好在
 *      扫描途中改了一块板，扫描读到的那份旧内容会把新内容盖掉 ——
 *      表现是"刚搜到的新词，侧栏转了两秒就没了"，且不留任何日志；
 *   3. **一块坏文件只跳过它**：不能因为一份读不出来的文件让整次搜索变空；
 *   4. **增量维护真的免读盘**：`saved` 事件走内存模型，否则每次自动保存都多读一次盘。
 *
 * 时序靠注入的"手动调度器"控制：`scheduleIdle` 收下任务不执行，测试用 `settle()`
 * 或 `scheduler.drain()` 决定"让出主线程"何时结束 —— 于是"扫到一半"这个状态
 * 才能真正被摆出来（否则只能靠 sleep 碰运气）。
 */

import { describe, expect, it } from 'vitest';
import { BOARD_EXT } from '../../constants';
import { BoardSearchIndex } from '../../integration/BoardSearchIndex';
import { createBoardFile, createCard } from '../../model/factories';
import type { BoardFile } from '../../model/schema';
import { MemoryVaultIO } from '../helpers/memoryVault';

/** 让所有微任务跑完（`list()` / `read()` 都是 async） */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  io: MemoryVaultIO;
  index: BoardSearchIndex;
  /** 真正被读过盘的路径（断言"免读盘"全靠它） */
  reads: string[];
  counts: { list: number };
  /** 推进"让出主线程"，把进行中的扫描跑到底 */
  drain: () => Promise<void>;
  /** `ensure()` 之后把扫描跑到底的常规写法：先让 `list()` 落地，再推进 */
  settle: () => Promise<void>;
  pathsOf: (query: string) => string[];
}

function harness(files: Record<string, string>, options: { chunkSize?: number } = {}): Harness {
  const io = new MemoryVaultIO(files);
  const reads: string[] = [];
  const counts = { list: 0 };
  const tasks: (() => void)[] = [];

  const drain = async (): Promise<void> => {
    while (tasks.length > 0) {
      tasks.shift()?.();
      await tick();
    }
  };

  const index = new BoardSearchIndex({
    list: async () => {
      counts.list += 1;
      return io.list(BOARD_EXT);
    },
    read: async (path) => {
      reads.push(path);
      return io.read(path);
    },
    chunkSize: options.chunkSize,
    scheduleIdle: (task) => {
      tasks.push(task);
    },
  });

  return {
    io,
    index,
    reads,
    counts,
    drain,
    settle: async () => {
      await tick();
      await drain();
    },
    pathsOf: (query) => index.search(query).hits.map((hit) => hit.boardPath),
  };
}

/** 一块板的磁盘形态（索引走的是 `parseBoardFile`，所以必须是真文本） */
function rawBoard(title: string, texts: string[]): string {
  return JSON.stringify(boardOf(title, texts));
}

function boardOf(title: string, texts: string[]): BoardFile {
  return createBoardFile({
    meta: { title },
    cards: texts.map((text) => createCard('note', { content: { md: text } })),
  });
}

describe('BoardSearchIndex —— 懒启动', () => {
  it('★ 构造完什么都不读：没用这个功能的人不付这笔钱', () => {
    const { index, reads, counts } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    expect(reads).toEqual([]);
    expect(counts.list).toBe(0);
    expect(index.buildStarted).toBe(false);
    expect(index.isReady).toBe(false);
    expect(index.indexedBoards).toBe(0);
    expect(index.search('预算')).toEqual({ hits: [], boards: [] });
  });

  it('`ensure()` 才开扫，而且**不**一次读完（分片让出主线程）', async () => {
    const { index, reads, settle, drain } = harness(
      { 'a.nboard': rawBoard('甲', ['预算']), 'b.nboard': rawBoard('乙', ['预算']) },
      { chunkSize: 1 },
    );

    index.ensure();
    await tick();

    // 只读了第一片，第二片要等"让出主线程"之后
    expect(reads).toEqual(['a.nboard']);
    expect(index.isReady).toBe(false);

    await drain();
    expect(reads).toEqual(['a.nboard', 'b.nboard']);
    expect(index.isReady).toBe(true);

    // `settle` 只是 `tick + drain` 的糖，这里顺带钉住它确实能收敛
    await settle();
    expect(index.isReady).toBe(true);
  });

  it('`ensure()` 重复调用只扫一次（侧栏关掉再打开不该重扫全库）', async () => {
    const { index, counts, settle } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    index.ensure();
    index.ensure();
    await settle();

    expect(counts.list).toBe(1);
  });
});

describe('BoardSearchIndex —— 全量扫描', () => {
  it('扫完能跨板搜到（结果带着板名）', async () => {
    const { index, settle } = harness({
      'a.nboard': rawBoard('甲', ['季度复盘要点']),
      'b.nboard': rawBoard('乙', ['季度复盘结论']),
      'c.nboard': rawBoard('丙', ['无关内容']),
    });

    index.ensure();
    await settle();

    const result = index.search('复盘');
    expect(index.isReady).toBe(true);
    expect(result.hits.map((hit) => hit.boardPath).sort()).toEqual(['a.nboard', 'b.nboard']);
    expect(result.hits[0].boardTitle).toBe('甲');
  });

  it('★ 一块读不出来的板只跳过它，不影响其余结果', async () => {
    const { index, io, settle } = harness({
      'good.nboard': rawBoard('好的', ['季度复盘']),
      'bad.nboard': '{ 这不是 JSON',
      'alien.nboard': JSON.stringify({ hello: 'world' }),
    });

    index.ensure();
    await settle();

    expect(index.indexedBoards).toBe(1);
    expect(index.search('复盘').hits).toHaveLength(1);
    // 坏文件不该被删掉或改写 —— 索引是只读的
    expect(io.files.get('bad.nboard')).toBe('{ 这不是 JSON');
  });

  it('`read` 抛错（文件在列完之后被删）也只跳过它', async () => {
    const { index, io, settle, pathsOf } = harness({
      'a.nboard': rawBoard('甲', ['季度复盘']),
      'gone.nboard': rawBoard('没了', ['季度复盘']),
    });
    io.files.delete('gone.nboard');

    index.ensure();
    await settle();

    expect(index.indexedBoards).toBe(1);
    expect(pathsOf('复盘')).toEqual(['a.nboard']);
  });

  it('`list` 抛错 → 空索引但就绪，不向上冒泡（侧栏该显示"没有结果"而不是崩）', async () => {
    const index = new BoardSearchIndex({
      list: async () => {
        throw new Error('适配器炸了');
      },
      read: async () => null,
      scheduleIdle: (task) => task(),
    });

    await expect(index.rebuild()).resolves.toBeUndefined();
    expect(index.isReady).toBe(true);
    expect(index.indexedBoards).toBe(0);
  });

  it('分片扫描每片广播一次（侧栏才会逐段长出结果）', async () => {
    const { index, settle, drain } = harness(
      {
        'a.nboard': rawBoard('甲', ['预算']),
        'b.nboard': rawBoard('乙', ['预算']),
        'c.nboard': rawBoard('丙', ['预算']),
      },
      { chunkSize: 1 },
    );

    let notifications = 0;
    index.onChanged(() => {
      notifications += 1;
    });

    index.ensure();
    await tick();
    expect(notifications).toBeGreaterThan(0);

    const before = notifications;
    await drain();
    expect(notifications).toBeGreaterThan(before);

    await settle();
  });

  it('退订之后不再收到广播（视图关闭时的常规用法）', async () => {
    const { index, settle } = harness(
      { 'a.nboard': rawBoard('甲', ['预算']), 'b.nboard': rawBoard('乙', ['预算']) },
      { chunkSize: 1 },
    );

    let notifications = 0;
    const off = index.onChanged(() => {
      notifications += 1;
    });

    index.ensure();
    await tick();
    off();

    const before = notifications;
    await settle();
    expect(notifications).toBe(before);
  });

  it('`stats()` 报出板数与卡片总数', async () => {
    const { index, settle } = harness({
      'a.nboard': rawBoard('甲', ['一', '二']),
      'b.nboard': rawBoard('乙', ['三']),
    });

    index.ensure();
    await settle();

    expect(index.stats()).toEqual({ boards: 2, cards: 3 });
  });
});

describe('BoardSearchIndex —— 增量维护', () => {
  it('`saved` 走内存模型：`updateFromBoard` 不读盘也立刻生效', async () => {
    const { index, reads, io, settle, pathsOf } = harness({
      'a.nboard': rawBoard('甲', ['旧的']),
    });

    index.ensure();
    await settle();
    const before = reads.length;

    // 盘上还是旧内容（写盘与事件之间没有先后承诺），索引吃的是内存模型
    index.updateFromBoard('a.nboard', boardOf('甲', ['新词']));

    expect(reads.length).toBe(before);
    expect(pathsOf('新词')).toEqual(['a.nboard']);
    expect(index.search('旧的').hits).toEqual([]);
    expect(io.files.get('a.nboard')).toContain('旧的');
  });

  it('外部改动走 `update`，重读盘后生效', async () => {
    const { index, io, reads, settle, pathsOf } = harness({
      'a.nboard': rawBoard('甲', ['旧的']),
    });

    index.ensure();
    await settle();
    const before = reads.length;

    io.externalWrite('a.nboard', rawBoard('甲', ['外部写入的词']));
    await index.update('a.nboard');

    expect(reads.length).toBe(before + 1);
    expect(pathsOf('外部写入的词')).toEqual(['a.nboard']);
  });

  it('`update` 读不到 → 当作删除（留着一块不存在的板只会点出打不开的标签页）', async () => {
    const { index, io, settle } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    index.ensure();
    await settle();
    expect(index.indexedBoards).toBe(1);

    io.files.delete('a.nboard');
    await index.update('a.nboard');

    expect(index.indexedBoards).toBe(0);
    expect(index.search('预算').hits).toEqual([]);
  });

  it('`remove` 当场生效', async () => {
    const { index, settle, pathsOf } = harness({
      'a.nboard': rawBoard('甲', ['预算']),
      'b.nboard': rawBoard('乙', ['预算']),
    });

    index.ensure();
    await settle();

    index.remove('a.nboard');

    expect(pathsOf('预算')).toEqual(['b.nboard']);
    expect(index.stats().boards).toBe(1);
  });

  it('`renamePath` 只换 key：新路径搜得到、旧路径搜不到，且不读盘', async () => {
    const { index, reads, settle, pathsOf } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    index.ensure();
    await settle();
    const before = reads.length;

    index.renamePath('a.nboard', '子目录/甲.nboard');

    expect(reads.length).toBe(before);
    expect(pathsOf('预算')).toEqual(['子目录/甲.nboard']);
    expect(index.search('预算').hits[0].boardTitle).toBe('甲');
  });

  it('★ 改名时索引里没有旧路径 → 补读新路径（不能就这么算了）', async () => {
    // 场景：同步工具把一份还没进过索引的文件（或上次没解析出来的）改了名。
    // 新路径不在本次扫描的文件清单里，不补读的话这块板会一直缺席到下次重建
    const { index, io, settle, pathsOf } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    index.ensure();
    await settle();

    io.files.set('新名.nboard', rawBoard('新来的', ['预算']));
    index.renamePath('从未见过.nboard', '新名.nboard');
    await settle();

    expect(pathsOf('预算').sort()).toEqual(['a.nboard', '新名.nboard']);
  });

  it('还没启动时改名什么都不做（扫描会读到最新的文件清单）', () => {
    const { index } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    index.renamePath('别的.nboard', '另外的.nboard');

    expect(index.indexedBoards).toBe(0);
    expect(index.buildStarted).toBe(false);
  });

  it('★ 还没启动时增量事件被忽略：不留"半份索引"', () => {
    // 只改一块板就凭空长出一份"只有一块板"的索引，会让侧栏显示
    // "没有其它板匹配" —— 而事实是"还没扫过"
    const { index } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    index.updateFromBoard('a.nboard', boardOf('甲', ['预算']));

    expect(index.indexedBoards).toBe(0);
    expect(index.isReady).toBe(false);
  });

  it('板没了也要能收掉，即使索引还没启动（坏数据与开关无关）', () => {
    const { index } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    expect(() => index.remove('a.nboard')).not.toThrow();
    expect(index.indexedBoards).toBe(0);
  });
});

describe('BoardSearchIndex —— 扫描与增量不能互相打架', () => {
  it('★ 扫描途中被改动的板：以增量那份为准，扫描不许覆盖它', async () => {
    // 这是全文件最容易写错的一条：扫描读到的是**改动之前**的盘上内容，
    // 但它到达 `commit` 的时间点在增量之后 —— 不做保护就会把新内容盖回旧内容
    const { index, settle, pathsOf } = harness(
      {
        'a.nboard': rawBoard('甲', ['甲的内容']),
        'b.nboard': rawBoard('乙', ['旧的词']),
        'c.nboard': rawBoard('丙', ['丙的内容']),
      },
      { chunkSize: 1 },
    );

    index.ensure();
    await tick();
    // 此刻 a 已扫完，b 还没轮到
    index.updateFromBoard('b.nboard', boardOf('乙', ['新的词']));

    await settle();

    expect(index.isReady).toBe(true);
    expect(pathsOf('新的词')).toEqual(['b.nboard']);
    expect(index.search('旧的词').hits).toEqual([]);
    // 其余两块板照常扫进来了，没有因为保护 b 而漏掉它们
    expect(index.stats().boards).toBe(3);
  });

  it('★ 扫描途中被删掉的板：不会在稍后的某一片里"复活"', async () => {
    const { index, settle, pathsOf } = harness(
      {
        'a.nboard': rawBoard('甲', ['内容']),
        'b.nboard': rawBoard('乙', ['预算']),
      },
      { chunkSize: 1 },
    );

    index.ensure();
    await tick();
    index.remove('b.nboard');

    await settle();

    expect(pathsOf('预算')).toEqual([]);
    expect(index.stats().boards).toBe(1);
  });

  it('★ 扫描途中改名的板：按新路径补进来，旧路径不会被装回来', async () => {
    const { index, io, settle, pathsOf } = harness(
      {
        'a.nboard': rawBoard('甲', ['内容']),
        'b.nboard': rawBoard('乙', ['预算']),
      },
      { chunkSize: 1 },
    );

    index.ensure();
    await tick();
    // b 还没轮到就被改名。★ 盘上的改名要先发生 —— `vault.on('rename')` 是
    // "文件已经到了新位置"之后才发的，测试里反过来摆会造出一个现实里不存在的状态
    io.files.delete('b.nboard');
    io.files.set('新名.nboard', rawBoard('乙', ['预算']));
    index.renamePath('b.nboard', '新名.nboard');

    await settle();

    expect(pathsOf('预算')).toEqual(['新名.nboard']);
    expect(index.stats().boards).toBe(2);
  });
});

describe('BoardSearchIndex —— 生命周期', () => {
  it('`dispose()` 清空索引与监听器，进行中的扫描自行放弃', async () => {
    const { index, settle, reads } = harness(
      {
        'a.nboard': rawBoard('甲', ['预算']),
        'b.nboard': rawBoard('乙', ['预算']),
        'c.nboard': rawBoard('丙', ['预算']),
      },
      { chunkSize: 1 },
    );

    let notifications = 0;
    index.onChanged(() => {
      notifications += 1;
    });

    index.ensure();
    await tick();
    const readsBefore = reads.length;

    index.dispose();
    const notificationsBefore = notifications;
    await settle();

    // 扫描在下一片开头就放弃了：一个文件都没再读，也没再广播
    expect(reads.length).toBe(readsBefore);
    expect(notifications).toBe(notificationsBefore);
    expect(index.indexedBoards).toBe(0);
  });

  it('★ `dispose()` 之后这个对象就作废了：`ensure()` 不会重新开扫', async () => {
    // 宿主即将卸载，不该再起新的活。★ 这条对**懒启动**的索引格外重要：
    // 卸载时它完全可能一次都还没扫过，光靠世代号挡不住"卸载后又开始读全库"
    const { index, counts, settle } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    index.dispose();
    index.ensure();
    await settle();

    expect(counts.list).toBe(0);
    expect(index.buildStarted).toBe(false);
  });

  it('`dispose()` 之后增量事件也被忽略（不再重新长出一份索引）', async () => {
    const { index, settle } = harness({ 'a.nboard': rawBoard('甲', ['预算']) });

    index.ensure();
    await settle();
    index.dispose();

    index.updateFromBoard('a.nboard', boardOf('甲', ['预算']));
    await index.update('a.nboard');

    expect(index.indexedBoards).toBe(0);
  });
});
