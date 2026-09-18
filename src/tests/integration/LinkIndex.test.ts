import { describe, expect, it, vi } from 'vitest';
import {
  EXCERPT_MAX,
  LinkIndex,
  normalizeLinkTarget,
  scanInlineText,
  tagsOfLine,
} from '../../integration/LinkIndex';
import type { LinkIndexOptions } from '../../integration/LinkIndex';
import { serializeBoard } from '../../io/BoardRepository';
import { createBoardFile, createCard } from '../../model/factories';
import type { BoardFile, Card } from '../../model/schema';
import { MemoryVaultIO } from '../helpers/memoryVault';

// ─────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────

function noteCard(md: string, title = ''): Card {
  return createCard('note', { title, content: { md } });
}

function makeBoard(id: string, title: string, cards: Card[]): BoardFile {
  return createBoardFile({ revision: 1, meta: { id, title }, cards });
}

/** 只扫 note 卡之外，还要证明"非 note 卡被跳过" */
function todoCard(text: string): Card {
  return createCard('todo', {
    title: '待办',
    content: { title: '待办', items: [{ text, done: false }] },
  });
}

function makeIndex(vault: MemoryVaultIO, overrides: Partial<LinkIndexOptions> = {}): LinkIndex {
  return new LinkIndex({
    list: () => vault.list('nboard'),
    read: (path) => vault.read(path),
    // 测试里同步让出主线程：分片逻辑照跑，但结果立刻可见，断言不必等宏任务
    scheduleIdle: (task) => task(),
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────
// 纯文本扫描
// ─────────────────────────────────────────────────────────────

describe('scanInlineText（内联卡正文扫描）', () => {
  it('抽出 [[链接]]，并剥掉 |别名 与 #小标题', () => {
    const scan = scanInlineText('见 [[项目A]] 与 [[folder/项目B#阶段二|第二期]]');
    expect(scan.links.map((hit) => hit.target)).toEqual(['项目A', 'folder/项目B']);
  });

  it('![[嵌入]] 与普通链接同等对待', () => {
    // 嵌入一张笔记同样是"这块板提到了它" —— 漏掉它会让反链少一半
    expect(scanInlineText('![[素材/封面]]').links.map((hit) => hit.target)).toEqual(['素材/封面']);
  });

  it('[[#小标题]] 没有外部目标，不计入', () => {
    expect(scanInlineText('跳到 [[#本节小结]]').links).toEqual([]);
  });

  it('摘要是链接所在的那一行，压平空白并截断', () => {
    const scan = scanInlineText('第一行无链接\n   见   [[目标]]   的第三节   ');
    expect(scan.links).toHaveLength(1);
    expect(scan.links[0]?.excerpt).toBe('见 [[目标]] 的第三节');

    const long = scanInlineText(`[[目标]] ${'x'.repeat(EXCERPT_MAX * 2)}`);
    expect(long.links[0]?.excerpt).toHaveLength(EXCERPT_MAX);
    expect(long.links[0]?.excerpt.endsWith('…')).toBe(true);
  });

  it('标签：行首与空白之后都认，行内重复只留一个', () => {
    const scan = scanInlineText('#周报 今天写了 #周报 和 #项目/子项');
    expect(scan.tags).toEqual(['周报', '项目/子项']);
  });

  it('`#` 前面不是空白就不算标签（[[a#b]]、C#、网址锚点）', () => {
    expect(scanInlineText('[[a#b]]').tags).toEqual([]);
    expect(scanInlineText('语言是 C#').tags).toEqual([]);
    expect(scanInlineText('见 example.com#anchor').tags).toEqual([]);
  });

  it('markdown 标题不算标签（`#` 后紧跟空白）', () => {
    expect(scanInlineText('# 一级标题\n## 二级标题').tags).toEqual([]);
  });

  it('纯数字不算标签（#2024 是年份）', () => {
    expect(scanInlineText('发布于 #2024').tags).toEqual([]);
  });

  it('标签尾部标点不属于标签（中文与拉丁标点都要挡）', () => {
    // 中文标点是密集出现的：`[^\s#]+` 这种写法会把「周报，然后」当成一个标签
    expect(scanInlineText('看 #周报，然后 #月会。').tags).toEqual(['周报', '月会']);
    expect(scanInlineText('see #weekly, then #monthly.').tags).toEqual(['weekly', 'monthly']);
  });

  it('标签字符集：字母 / 数字 / 下划线 / 连字符 / 斜杠', () => {
    expect(scanInlineText('#a_b-c/d #v2').tags).toEqual(['a_b-c/d', 'v2']);
  });

  it('围栏代码块里的内容整体跳过', () => {
    const md = ['前面 #真标签', '```', '#假标签 [[假链接]]', '```', '后面 [[真链接]]'].join('\n');
    const scan = scanInlineText(md);
    expect(scan.tags).toEqual(['真标签']);
    expect(scan.links.map((hit) => hit.target)).toEqual(['真链接']);
  });

  it('行内代码里的内容跳过（写语法示例不该给板子加标签）', () => {
    const scan = scanInlineText('输入 `#标签` 就能打标签，比如 #真标签');
    expect(scan.tags).toEqual(['真标签']);
  });
});

describe('normalizeLinkTarget / tagsOfLine（导出的细粒度工具）', () => {
  it('normalizeLinkTarget 在第一个 | 或 # 处切断', () => {
    expect(normalizeLinkTarget('甲|别名')).toBe('甲');
    expect(normalizeLinkTarget('甲#小标题')).toBe('甲');
    expect(normalizeLinkTarget('甲#小标题|别名')).toBe('甲');
    // `#` 与 `^` 都在 ILLEGAL_IN_NAME 里，文件名不可能含它们
    expect(normalizeLinkTarget('folder/甲')).toBe('folder/甲');
  });

  it('tagsOfLine 只处理一行', () => {
    expect(tagsOfLine('#a 和 #b')).toEqual(['a', 'b']);
    expect(tagsOfLine('无标签')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 索引
// ─────────────────────────────────────────────────────────────

describe('LinkIndex 全量扫描（T5.01）', () => {
  it('扫全部 .nboard，按笔记路径反查出链', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(
        makeBoard('nb_a', 'A 板', [noteCard('见 [[笔记甲]]', '卡片一')]),
      ),
      'Boards/B.nboard': serializeBoard(
        makeBoard('nb_b', 'B 板', [noteCard('也见 [[笔记甲]] 一次')]),
      ),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    const hits = index.backlinksOf('笔记甲.md');
    // ★ 字段是**文档中立**的（`06 §7.2`）：白板这份里 `docPath` = 板路径、`label` = 卡标题
    expect(hits.map((hit) => hit.docPath)).toEqual(['Boards/A.nboard', 'Boards/B.nboard']);
    expect(hits[0]?.label).toBe('卡片一');
    expect(hits[0]?.excerpt).toBe('见 [[笔记甲]]');
    expect(index.isReady).toBe(true);
  });

  it('只索引内联卡（note）：待办卡里的链接不计入', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(
        makeBoard('nb_a', 'A', [todoCard('看 [[笔记甲]]'), noteCard('看 [[笔记乙]]')]),
      ),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    expect(index.backlinksOf('笔记甲.md')).toEqual([]);
    expect(index.backlinksOf('笔记乙.md')).toHaveLength(1);
  });

  it('注入的 resolve 优先；解析成功的不再按文件名兜底（同名不同目录不混淆）', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[同名]]')])),
    });
    // 模拟 metadataCache：这个名字指向 深层/同名.md 而不是库根的同名.md
    const index = makeIndex(vault, {
      resolve: (target) => (target === '同名' ? '深层/同名.md' : null),
    });
    await index.rebuild();

    expect(index.backlinksOf('深层/同名.md')).toHaveLength(1);
    expect(index.backlinksOf('同名.md')).toEqual([]);
  });

  it('解析不出路径时退回文件名匹配（启动早期 metadataCache 未就绪）', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
    });
    const index = makeIndex(vault, { resolve: () => null });
    await index.rebuild();

    // 位置换了也照样查得到，只是不如精确解析准
    expect(index.backlinksOf('文件夹/甲.md')).toHaveLength(1);
    expect(index.stats().unresolved).toBe(1);
  });

  it('坏文件只跳过它自己，其余白板照常索引', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
      'Boards/坏.nboard': '{ 这不是 JSON',
      'Boards/不像.nboard': JSON.stringify({ hello: 'world' }),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    expect(index.stats().boards).toBe(1);
    expect(index.backlinksOf('甲.md')).toHaveLength(1);
  });

  it('列不出文件（适配器异常）时不抛，留一个空索引', async () => {
    const index = new LinkIndex({
      list: () => Promise.reject(new Error('adapter exploded')),
      read: () => Promise.resolve(null),
      scheduleIdle: (task) => task(),
    });
    await expect(index.rebuild()).resolves.toBeUndefined();
    expect(index.isReady).toBe(true);
    expect(index.stats().boards).toBe(0);
  });

  it('分片扫描：每片提交一次，扫描途中就能查到部分结果', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
      'Boards/B.nboard': serializeBoard(makeBoard('nb_b', 'B', [noteCard('[[乙]]')])),
      'Boards/C.nboard': serializeBoard(makeBoard('nb_c', 'C', [noteCard('[[丙]]')])),
    });

    const snapshot: Array<{ boards: number; ready: boolean }> = [];
    const index = makeIndex(vault, {
      chunkSize: 1,
      scheduleIdle: (task) => {
        snapshot.push({ boards: index.stats().boards, ready: index.isReady });
        task();
      },
    });

    await index.rebuild();

    // 三片 → 三次让出；第一次让出时只提交了一块板，且**还没** ready
    expect(snapshot).toEqual([
      { boards: 1, ready: false },
      { boards: 2, ready: false },
      { boards: 3, ready: false },
    ]);
    expect(index.isReady).toBe(true);
    expect(index.stats().boards).toBe(3);
  });

  it('扫描途中再次 rebuild：旧的那次放弃，不与新的交替写入', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
      'Boards/B.nboard': serializeBoard(makeBoard('nb_b', 'B', [noteCard('[[乙]]')])),
    });

    // 第一次扫描让出主线程时立刻发起第二次（模拟用户改设置触发的重建）
    let second: Promise<void> | null = null;
    const index = makeIndex(vault, {
      chunkSize: 1,
      scheduleIdle: (task) => {
        // 闭包在 `rebuild()` 调用期间才执行，此时 `index` 早已初始化
        second ??= index.rebuild();
        task();
      },
    });

    await index.rebuild();
    await second;

    // 结果必须是"完整的两块板"，而不是半新半旧
    expect(index.stats().boards).toBe(2);
    expect(index.backlinksOf('甲.md')).toHaveLength(1);
    expect(index.backlinksOf('乙.md')).toHaveLength(1);
  });
});

describe('LinkIndex 增量维护（T5.02）', () => {
  it('updateFromBoard 用内存模型更新，不读盘', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
    });
    const read = vi.spyOn(vault, 'read');
    const index = makeIndex(vault);
    await index.rebuild();
    const afterRebuild = read.mock.calls.length;

    // 保存后 repository 手里就有新模型：增量更新**不该**再读一次盘
    const board = makeBoard('nb_a', 'A', [noteCard('[[甲]] 与 [[乙]]')]);
    index.updateFromBoard('Boards/A.nboard', board);

    expect(read.mock.calls.length).toBe(afterRebuild);
    expect(index.backlinksOf('乙.md')).toHaveLength(1);
  });

  it('update 按磁盘内容重建（外部改动）', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
    });
    const index = makeIndex(vault);
    await index.rebuild();
    expect(index.backlinksOf('甲.md')).toHaveLength(1);

    vault.files.set(
      'Boards/A.nboard',
      serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[丙]]')])),
    );
    await index.update('Boards/A.nboard');

    expect(index.backlinksOf('甲.md')).toEqual([]);
    expect(index.backlinksOf('丙.md')).toHaveLength(1);
  });

  it('update 读不到文件时按删除处理（不留指向已消失白板的旧记录）', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    vault.files.delete('Boards/A.nboard');
    await index.update('Boards/A.nboard');

    expect(index.backlinksOf('甲.md')).toEqual([]);
    expect(index.stats().boards).toBe(0);
  });

  it('remove / renamePath', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
      'Boards/B.nboard': serializeBoard(makeBoard('nb_b', 'B', [noteCard('[[甲]]')])),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    index.remove('Boards/B.nboard');
    expect(index.backlinksOf('甲.md').map((hit) => hit.docPath)).toEqual(['Boards/A.nboard']);

    index.renamePath('Boards/A.nboard', 'Boards/改名了.nboard');
    const hits = index.backlinksOf('甲.md');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.docPath).toBe('Boards/改名了.nboard');
  });

  it('linksOf 只给这块板的出链，且给的是副本（索引笔记排版时动不到索引内部）', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]] 与 [[乙]]')])),
      'Boards/B.nboard': serializeBoard(makeBoard('nb_b', 'B', [noteCard('[[丙]]')])),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    const links = index.linksOf('Boards/A.nboard');
    expect(links.map((hit) => hit.target)).toEqual(['甲', '乙']);
    expect(index.linksOf('Boards/没有这块板.nboard')).toEqual([]);

    links.length = 0;
    expect(index.linksOf('Boards/A.nboard')).toHaveLength(2);
  });

  it('reresolve 在 metadataCache 就绪后把兜底匹配纠正成精确路径', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[同名]]')])),
      'Boards/B.nboard': serializeBoard(makeBoard('nb_b', 'B', [noteCard('[[同名]]')])),
    });

    // 一开始 metadataCache 还没建好：全部解析失败，只能按文件名兜底
    let ready = false;
    const index = makeIndex(vault, {
      resolve: (target) => (ready && target === '同名' ? '深层/同名.md' : null),
    });
    await index.rebuild();
    expect(index.stats().unresolved).toBe(2);
    expect(index.backlinksOf('深层/同名.md')).toHaveLength(2);

    ready = true;
    index.reresolve();

    expect(index.stats().unresolved).toBe(0);
    expect(index.backlinksOf('深层/同名.md')).toHaveLength(2);
    expect(index.backlinksOf('别处/同名.md')).toEqual([]);
  });

  it('reresolve 无变化时不广播（避免启动时列表反复重画）', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
    });
    const index = makeIndex(vault, { resolve: () => '甲.md' });
    await index.rebuild();

    const listener = vi.fn();
    index.onChanged(listener);
    index.reresolve();
    index.reresolve();

    expect(listener).not.toHaveBeenCalled();
  });

  it('没注入 resolve 时 reresolve 是空操作', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
    });
    const index = makeIndex(vault);
    await index.rebuild();
    expect(() => index.reresolve()).not.toThrow();
    expect(index.backlinksOf('甲.md')).toHaveLength(1);
  });
});

describe('LinkIndex 查询与通知', () => {
  it('tags / tagsOf / boardsWithTag（F8-05 内联卡标签）', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('#周报 #项目/子项')])),
      'Boards/B.nboard': serializeBoard(makeBoard('nb_b', 'B', [noteCard('#周报')])),
      'Boards/C.nboard': serializeBoard(makeBoard('nb_c', 'C', [noteCard('没有标签')])),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    // 不断言排序：`localeCompare` 的中文次序随运行环境的 locale 变，断言顺序会变成
    // "在 CI 上过、在某人机器上红"的脆弱用例
    expect(index.tags()).toHaveLength(2);
    expect(index.tags()).toEqual(expect.arrayContaining(['周报', '项目/子项']));
    expect(index.tagsOf('Boards/A.nboard')).toHaveLength(2);
    expect(index.tagsOf('Boards/C.nboard')).toEqual([]);
    expect(index.boardsWithTag('周报').sort()).toEqual(['Boards/A.nboard', 'Boards/B.nboard']);
    expect(index.boardsWithTag('不存在')).toEqual([]);
  });

  it('转义字符与空目标不会造出幽灵出链', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(
        makeBoard('nb_a', 'A', [noteCard('[[  ]] 和 [[#仅小标题]]')]),
      ),
    });
    const index = makeIndex(vault);
    await index.rebuild();
    expect(index.allLinks()).toEqual([]);
  });

  it('onChanged 广播全部链接，退订后不再收到', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    const listener = vi.fn();
    const off = index.onChanged(listener);

    index.updateFromBoard('Boards/B.nboard', makeBoard('nb_b', 'B', [noteCard('[[乙]]')]));
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    index.updateFromBoard('Boards/C.nboard', makeBoard('nb_c', 'C', [noteCard('[[丙]]')]));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose 后清空并停止广播', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(makeBoard('nb_a', 'A', [noteCard('[[甲]]')])),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    const listener = vi.fn();
    index.onChanged(listener);
    index.dispose();

    expect(index.stats().boards).toBe(0);
    expect(index.backlinksOf('甲.md')).toEqual([]);

    index.updateFromBoard('Boards/B.nboard', makeBoard('nb_b', 'B', [noteCard('[[乙]]')]));
    expect(listener).not.toHaveBeenCalled();
  });

  it('stats 汇总规模', async () => {
    const vault = new MemoryVaultIO({
      'Boards/A.nboard': serializeBoard(
        makeBoard('nb_a', 'A', [noteCard('[[甲]] #标签1'), noteCard('[[乙]] #标签2')]),
      ),
    });
    const index = makeIndex(vault);
    await index.rebuild();

    expect(index.stats()).toEqual({ boards: 1, links: 2, tags: 2, unresolved: 2 });
    expect(index.scannedBoards).toBe(1);
  });
});
