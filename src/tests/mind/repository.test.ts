/**
 * `MindRepository`（`06 §9` P1）—— 六条规则（`03 §3.2` 的 W1–W6）逐条钉住。
 *
 * 这是最容易造成数据丢失的一层，所以用例的分组就按规则走：
 *   读路径与保护态（W6）、写路径与原子性（W1 / W2）、冲突（三选一）、外部改动（W4）、
 *   视口（W3）、会话的搬迁 / 关闭、以及强制 flush（W5）与快照旁路。
 *
 * ★ 用 `tests/helpers/memoryVault` 的替身：它的 `process()` **transform 抛错时不写入**
 *   —— 与 Obsidian 一致，冲突检测那几条用例才不是假绿灯。
 * ★ 防抖间隔传 0（不假造时钟）：`vi.waitFor` 用真定时器轮询，比接管 `setTimeout` 稳 ——
 *   接管之后 `waitFor` 自己也靠定时器，很容易写出"等不到"的用例。
 */

import { describe, expect, it, vi } from 'vitest';
import { MindRepository } from '../../mind/io/MindRepository';
import { serializeMindFile } from '../../mind/io/serialize';
import { createMindFile } from '../../mind/model/factories';
import { MemoryVaultIO } from '../helpers/memoryVault';

const PATH = 'Minds/甲.nestmind';

/** 一份能读的磁盘内容（`revision` 可指定，用来造"磁盘更新"这类现场） */
function textOf(revision = 1): string {
  const file = createMindFile({ title: '甲', now: () => 'T' });
  file.revision = revision;
  return serializeMindFile(file);
}

function setup(initial: Record<string, string> = { [PATH]: textOf() }) {
  const io = new MemoryVaultIO(initial);
  const saves: Array<{ path: string; revision: number }> = [];
  const reloads: string[] = [];
  const conflicts: string[] = [];
  const protectedEvents: string[] = [];
  const repository = new MindRepository(io, { saveDebounceMs: 0, reloadDebounceMs: 0 });
  repository.on('saved', (payload) => saves.push(payload));
  repository.on('reloaded', ({ path }) => reloads.push(path));
  repository.on('conflict', ({ path }) => conflicts.push(path));
  repository.on('protected', ({ reason }) => protectedEvents.push(reason));
  return { io, repository, saves, reloads, conflicts, protectedEvents };
}

/** 等一拍（用来断言"什么都没发生"） */
function settle(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 读路径与保护态（W6）──────────────────────────────────────

describe('open · 读路径', () => {
  it('读盘 → 内存模型；状态 clean，基线是磁盘上的 revision', async () => {
    const { repository } = setup();

    const mind = await repository.open(PATH);

    expect(mind?.meta.title).toBe('甲');
    expect(repository.getState(PATH)).toBe('clean');
    expect(repository.isOpen(PATH)).toBe(true);
    expect(repository.isReadOnly(PATH)).toBe(false);
    expect(repository.openPaths()).toEqual([PATH]);
  });

  it('已经打开过的：再 `open` 拿的是内存里那一份（不重读磁盘）', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);
    io.files.set(PATH, textOf(9));

    const again = await repository.open(PATH);

    expect(again?.revision).toBe(1);
  });

  it('★ 文件读不到 → 只读保护态（read-failed），绝不写回', async () => {
    const { repository, io, protectedEvents } = setup({});

    const mind = await repository.open(PATH);

    expect(mind).toBeNull();
    expect(protectedEvents).toEqual(['read-failed']);
    expect(repository.isReadOnly(PATH)).toBe(true);
    expect(repository.lockReason(PATH)).toBe('protected');
    expect(io.files.size).toBe(0);
  });

  it('★ JSON 坏了 → 保护态 + 保留原始文本 + `mutate` 直接抛错', async () => {
    const { repository, protectedEvents } = setup({ [PATH]: '{ 这不是 JSON' });
    await repository.open(PATH);

    expect(protectedEvents).toEqual(['invalid-json']);
    expect(repository.getRawText(PATH)).toBe('{ 这不是 JSON');
    expect(() => repository.mutate(PATH, () => undefined)).toThrow(/只读保护态/);
  });

  it('★ 是合法 JSON 但不像脑图（没有 nodes / rootId）→ 保护态 not-a-mind', async () => {
    const { repository, protectedEvents } = setup({ [PATH]: '{"hello":1}' });
    await repository.open(PATH);

    expect(protectedEvents).toEqual(['not-a-mind']);
    expect(repository.getState(PATH)).toBe('readonly');
  });

  it('保护态下 `updateView` 也一个字节都不动', async () => {
    const { repository, io } = setup({ [PATH]: 'nope' });
    await repository.open(PATH);

    repository.updateView(PATH, { zoom: 2 });

    expect(io.writeLog).toEqual([]);
  });
});

// ── 写路径（W1 / W2）─────────────────────────────────────────

describe('mutate · 写路径', () => {
  it('改了东西：递增 revision、标脏、发 changed、防抖后落盘（原子写）', async () => {
    const { repository, io, saves } = setup();
    await repository.open(PATH);
    const changed = vi.fn();
    repository.on('changed', changed);

    const did = repository.mutate(PATH, (mind) => {
      mind.nodes[0]!.text = '改名了';
    });

    expect(did).toBe(true);
    expect(repository.get(PATH)?.revision).toBe(2);
    expect(repository.getState(PATH)).toBe('dirty');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(io.writeLog).toEqual([]); // 还在防抖里（同步代码期间定时器不会插进来）

    await vi.waitFor(() => expect(saves).toHaveLength(1));
    expect(io.writeLog).toEqual([PATH]);
    expect(repository.getState(PATH)).toBe('clean');
    expect(JSON.parse(io.files.get(PATH) ?? '').nodes[0].text).toBe('改名了');
  });

  it('★ `mutator` 返回 false = 什么都没改：不递增、不标脏、不排盘', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);

    const did = repository.mutate(PATH, () => false);
    await repository.flush(PATH);

    expect(did).toBe(false);
    expect(repository.get(PATH)?.revision).toBe(1);
    expect(repository.getState(PATH)).toBe('clean');
    expect(io.writeLog).toEqual([]);
  });

  it('`immediate: true` 跳过节流：不等防抖就写下去', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);

    repository.mutate(PATH, (mind) => void (mind.meta.title = '立刻'), { immediate: true });
    await repository.flush(PATH);

    expect(io.writeLog).toEqual([PATH]);
  });
});

// ── 冲突（W1 的原子性 + 三选一）──────────────────────────────

describe('冲突', () => {
  it('★ 磁盘 revision 更高 → 冲突未决，**磁盘内容一个字节都没被覆盖**', async () => {
    const { repository, io, conflicts } = setup();
    await repository.open(PATH);
    // 模拟"另一台设备改过"
    const diskText = textOf(5);
    io.externalWrite(PATH, diskText);
    repository.mutate(PATH, (mind) => void (mind.meta.title = '我改的'));

    await repository.flush(PATH);

    expect(conflicts).toEqual([PATH]);
    expect(repository.getState(PATH)).toBe('conflict');
    expect(io.files.get(PATH)).toBe(diskText);
    // 改动还留在内存里（绝不丢）
    expect(repository.get(PATH)?.meta.title).toBe('我改的');
  });

  it('★ 磁盘内容不可解析而我们内存里有东西 → 同样拒绝盲写', async () => {
    const { repository, io, conflicts } = setup();
    await repository.open(PATH);
    io.externalWrite(PATH, '被别的程序写坏了');
    repository.mutate(PATH, (mind) => void (mind.meta.title = '我改的'));

    await repository.flush(PATH);

    expect(conflicts).toEqual([PATH]);
    expect(io.files.get(PATH)).toBe('被别的程序写坏了');
  });

  it('「保留我的修改」：revision 推到磁盘之上再写，冲突不会永远修不好', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);
    io.externalWrite(PATH, textOf(5));
    repository.mutate(PATH, (mind) => void (mind.meta.title = '我改的'));
    await repository.flush(PATH);

    await repository.keepMine(PATH);

    const written = JSON.parse(io.files.get(PATH) ?? '');
    expect(repository.getState(PATH)).toBe('clean');
    expect(written.meta.title).toBe('我改的');
    expect(written.revision).toBeGreaterThan(5);
  });

  it('「用磁盘版本」：放弃本地改动，换成磁盘那一份', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);
    repository.mutate(PATH, (mind) => void (mind.meta.title = '我改的'));
    io.externalWrite(PATH, textOf(5));

    await repository.useDisk(PATH);

    expect(repository.getState(PATH)).toBe('clean');
    expect(repository.get(PATH)?.revision).toBe(5);
  });

  it('「另存为副本」：本地那一份先落进副本，内存再切回磁盘版本（最安全的一条）', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);
    repository.mutate(PATH, (mind) => void (mind.meta.title = '我改的'));
    io.externalWrite(PATH, textOf(5));
    await repository.flush(PATH);
    expect(repository.getState(PATH)).toBe('conflict');

    await repository.saveAsCopy(PATH, 'Copies/副本.nestmind');

    // 副本里是**我的那一份**（顺序反了的话这里拿到的会是磁盘那一份，等于什么都没救）
    const copy = JSON.parse(io.files.get('Copies/副本.nestmind') ?? '{}') as {
      meta?: { title?: string };
    };
    expect(copy.meta?.title).toBe('我改的');
    // 内存切回磁盘那一份，冲突解除
    expect(repository.get(PATH)?.revision).toBe(5);
    expect(repository.getState(PATH)).toBe('clean');
  });
});

// ── 外部改动（W4）────────────────────────────────────────────

describe('handleExternalModify · 外部改动', () => {
  it('★ 没有本地改动时：把磁盘那一份读回内存（reloaded）', async () => {
    const { repository, io, reloads } = setup();
    await repository.open(PATH);
    io.externalWrite(PATH, textOf(7));

    repository.handleExternalModify(PATH);

    await vi.waitFor(() => expect(reloads).toEqual([PATH]));
    expect(repository.get(PATH)?.revision).toBe(7);
    expect(repository.getState(PATH)).toBe('clean');
  });

  it('★ 有本地未保存改动时：不覆盖内存，报冲突（三选一）', async () => {
    const { repository, io, conflicts, reloads } = setup();
    await repository.open(PATH);
    repository.mutate(PATH, (mind) => void (mind.meta.title = '我改的'));
    io.externalWrite(PATH, textOf(7));

    repository.handleExternalModify(PATH);

    await vi.waitFor(() => expect(conflicts).toEqual([PATH]));
    expect(reloads).toEqual([]);
    expect(repository.get(PATH)?.meta.title).toBe('我改的');
  });

  it('★ 自己刚写下去的那一次不算外部改动（不会自己跟自己重载）', async () => {
    const { repository, reloads } = setup();
    await repository.open(PATH);
    repository.mutate(PATH, (mind) => void (mind.meta.title = '我改的'));
    await repository.flush(PATH);

    repository.handleExternalModify(PATH);
    await settle();

    expect(reloads).toEqual([]);
  });

  it('没打开的路径：外部改动不产生任何动静（也不抛错）', () => {
    const { repository } = setup();
    expect(() => repository.handleExternalModify('Minds/别的.nestmind')).not.toThrow();
  });
});

// ── 视口（W3）────────────────────────────────────────────────

describe('updateView · 视口', () => {
  it('★ 大纲 / 树（`view.outline`）与视口同一档：落盘、不递增 revision、不发 changed', async () => {
    // `N3-c` 的硬要求：**两视图共用一条撤销链** —— 切视图属于"这一眼怎么看"，
    // 它既不该占一步撤销，也不该让视图把整棵树重画一遍
    const { repository, io } = setup();
    await repository.open(PATH);

    const changes: number[] = [];
    repository.on('changed', (payload) => changes.push(payload.mind.revision));
    const before = repository.get(PATH)?.revision ?? 0;

    repository.updateView(PATH, { outline: true });

    await vi.waitFor(() => expect(io.writeLog).toEqual([PATH]));
    const written = JSON.parse(io.files.get(PATH) ?? '');
    expect(written.view.outline).toBe(true);
    expect(written.revision).toBe(before);
    expect(changes).toEqual([]);

    // 读回来还在（`true` / `false` 都留 —— 见 `validate` 里那条注释）
    await repository.open(PATH);
    expect(repository.get(PATH)?.view.outline).toBe(true);
  });

  it('★ 只改视口：落盘但**不递增 revision**（不污染冲突检测）', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);

    repository.updateView(PATH, { x: 12, zoom: 2 });

    await vi.waitFor(() => expect(io.writeLog).toEqual([PATH]));
    const written = JSON.parse(io.files.get(PATH) ?? '');
    expect(written.revision).toBe(1);
    expect(written.view).toMatchObject({ x: 12, zoom: 2 });
  });
});

// ── 会话（搬迁 / 关闭）───────────────────────────────────────

describe('会话', () => {
  it('★ 改名后会话跟着搬：新路径拿得到，旧路径不再有', async () => {
    const { repository } = setup();
    await repository.open(PATH);

    repository.movePath(PATH, 'Minds/乙.nestmind');

    expect(repository.get('Minds/乙.nestmind')?.meta.title).toBe('甲');
    expect(repository.get(PATH)).toBeNull();
    expect(repository.isOpen(PATH)).toBe(false);
  });

  it('目标路径已经被另一份脑图占着：宁可不搬（别顶掉人家）', async () => {
    const other = 'Minds/乙.nestmind';
    const { repository } = setup({ [PATH]: textOf(), [other]: textOf(2) });
    await repository.open(PATH);
    await repository.open(other);

    repository.movePath(PATH, other);

    expect(repository.get(PATH)?.meta.title).toBe('甲');
    expect(repository.get(other)?.revision).toBe(2);
  });

  it('关闭：会话没了，挂起的改动也不会再写出去', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);
    repository.mutate(PATH, (mind) => void (mind.meta.title = '还没落盘'));

    repository.close(PATH);
    await settle();

    expect(repository.isOpen(PATH)).toBe(false);
    expect(io.writeLog).toEqual([]);
  });
});

// ── flush（W5）与旁路（快照）─────────────────────────────────

describe('flushAll 与快照旁路', () => {
  it('`flushAll` 把两份脑图一起推下去（强制 flush 的唯一入口）', async () => {
    const second = 'Minds/乙.nestmind';
    const { repository, io } = setup({ [PATH]: textOf(), [second]: textOf() });
    await repository.open(PATH);
    await repository.open(second);
    repository.mutate(PATH, (mind) => void (mind.meta.title = 'A'));
    repository.mutate(second, (mind) => void (mind.meta.title = 'B'));

    await repository.flushAll();

    expect(io.writeLog).toEqual([PATH, second]);
  });

  it('★ 写盘成功后才通知快照（`mindId` 与写进去的那一版 revision）', async () => {
    const afterSave = vi.fn();
    const io = new MemoryVaultIO({ [PATH]: textOf() });
    const repository = new MindRepository(io, { observer: { afterSave } });
    const mind = await repository.open(PATH);
    repository.mutate(PATH, (m) => void (m.meta.title = '改一下'));

    await repository.flush(PATH);

    expect(afterSave).toHaveBeenCalledTimes(1);
    expect(afterSave.mock.calls[0]?.[0]).toMatchObject({
      path: PATH,
      mindId: mind?.meta.id,
      revision: 2,
    });
    expect(String(afterSave.mock.calls[0]?.[0]?.text)).toContain('改一下');
  });

  it('快照观察者抛错**不影响保存结果**（旁路就是旁路）', async () => {
    const io = new MemoryVaultIO({ [PATH]: textOf() });
    const repository = new MindRepository(io, {
      observer: {
        afterSave: () => {
          throw new Error('快照炸了');
        },
      },
    });
    await repository.open(PATH);
    repository.mutate(PATH, (m) => void (m.meta.title = '照样写'));

    await repository.flush(PATH);

    expect(JSON.parse(io.files.get(PATH) ?? '').meta.title).toBe('照样写');
    expect(repository.getState(PATH)).toBe('clean');
  });

  it('`dispose`：会话与定时器都放掉（插件卸载时）', async () => {
    const { repository, io } = setup();
    await repository.open(PATH);
    repository.mutate(PATH, (mind) => void (mind.meta.title = '还没落盘'));

    repository.dispose();
    await settle();

    expect(repository.openPaths()).toEqual([]);
    expect(io.writeLog).toEqual([]);
  });
});
