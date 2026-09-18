/**
 * 快照存储单测（T4.01 / `F11-11`）。
 *
 * 这里守的是三件"出错了用户才发现"的事：
 * 1. 触发节奏别失控（每个 revision 都打一份 = 每次拖动都写盘）；
 * 2. 淘汰别把最新的那份也删了（一块大板的单份快照就可能超过体积上限）；
 * 3. 文件名能解析回时间（否则历史列表会整片空白，而文件其实好好躺在磁盘上）。
 */

import { describe, expect, it } from 'vitest';
import {
  SnapshotStore,
  parseSnapshotTime,
  planSnapshotEviction,
  shouldCaptureSnapshot,
  snapshotFileName,
} from '../../io/SnapshotStore';
import type { SnapshotIO, SnapshotRecord } from '../../io/SnapshotStore';

// ─────────────────────────────────────────────────────────────
// 替身
// ─────────────────────────────────────────────────────────────

class MemorySnapshotIO implements SnapshotIO {
  readonly files = new Map<string, string>();
  /** 每次真正写入的路径，用于断言"打了几份" */
  readonly writes: string[] = [];

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`文件不存在：${path}`);
    return content;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    this.writes.push(path);
  }

  async listFiles(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => path.slice(prefix.length));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async size(path: string): Promise<number | null> {
    const content = this.files.get(path);
    return content === undefined ? null : new TextEncoder().encode(content).byteLength;
  }
}

/** 最小可用的 `.nboard` 文本：`SnapshotStore` 只关心 `revision` 与 `cards.length` */
function boardText(revision: number, cards = 3): string {
  return JSON.stringify({
    spec: 'nestboard/1',
    version: 1,
    revision,
    meta: { id: 'nb_1', title: '测试板' },
    cards: Array.from({ length: cards }, (_, index) => ({ id: `c${index}`, type: 'note' })),
  });
}

const BOARD_ID = 'nb_1';
const ROOT = '.nestboard-history';

interface Harness {
  io: MemorySnapshotIO;
  store: SnapshotStore;
  tick(ms: number): void;
  /** 换快照位置（模拟设置里切"插件目录 ↔ Vault 内"） */
  setRoot(next: string): void;
}

function makeStore(
  options: { enabled?: boolean; maxCount?: number; maxBytes?: number } = {},
): Harness {
  const io = new MemorySnapshotIO();
  let clock = Date.parse('2026-09-12T10:00:00Z');
  let root = ROOT;
  const store = new SnapshotStore(io, {
    root: () => root,
    enabled: () => options.enabled ?? true,
    now: () => clock,
    ...(options.maxCount === undefined ? {} : { maxCount: options.maxCount }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  return {
    io,
    store,
    tick: (ms: number) => {
      clock += ms;
    },
    setRoot: (next: string) => {
      root = next;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 文件名
// ─────────────────────────────────────────────────────────────

describe('快照文件名', () => {
  it('往返解析回同一时刻，且**不含冒号**（Windows 文件名不允许）', () => {
    const at = Date.parse('2026-09-12T10:00:00Z');
    const name = snapshotFileName(at);
    expect(name).toBe('2026-09-12T10-00-00Z.nboard');
    expect(name).not.toContain(':');
    expect(parseSnapshotTime(name)).toBe(at);
  });

  it('认得重名后缀（同一秒连点两次"创建快照"）', () => {
    expect(parseSnapshotTime('2026-09-12T10-00-00Z-2.nboard')).toBe(
      Date.parse('2026-09-12T10:00:00Z'),
    );
  });

  it('不认识的杂物返回 null（`.DS_Store` / 用户手放的文件一律不动）', () => {
    expect(parseSnapshotTime('.DS_Store')).toBeNull();
    expect(parseSnapshotTime('随手记.nboard')).toBeNull();
    expect(parseSnapshotTime('2026-09-12T10-00-00Z.nboard.bak')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 触发节奏
// ─────────────────────────────────────────────────────────────

describe('shouldCaptureSnapshot', () => {
  const base = { enabled: true, now: 1_000_000, minIntervalMs: 300_000, revision: 5 };

  it('一份快照都没有时立刻打 —— 刚建完板就误删是最高频的丢数据场景', () => {
    expect(shouldCaptureSnapshot({ ...base, last: null })).toBe(true);
  });

  it('关掉之后永远不打', () => {
    expect(shouldCaptureSnapshot({ ...base, enabled: false, last: null })).toBe(false);
  });

  it('内容没变过就不打（只看时间会堆出一串一模一样的快照）', () => {
    expect(shouldCaptureSnapshot({ ...base, last: { capturedAt: 0, revision: 5 } })).toBe(false);
  });

  it('时间没到就不打（只看 revision 会在拖动过程中疯狂写盘）', () => {
    expect(shouldCaptureSnapshot({ ...base, last: { capturedAt: 900_000, revision: 4 } })).toBe(
      false,
    );
  });

  it('间隔够了且 revision 变了才打', () => {
    expect(shouldCaptureSnapshot({ ...base, last: { capturedAt: 700_000, revision: 4 } })).toBe(
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// 淘汰
// ─────────────────────────────────────────────────────────────

describe('planSnapshotEviction', () => {
  const record = (name: string, capturedAt: number, bytes: number): SnapshotRecord => ({
    path: `${ROOT}/${BOARD_ID}/${name}`,
    boardId: BOARD_ID,
    capturedAt,
    cardCount: 1,
    bytes,
  });

  it('超过份数上限时删最旧的', () => {
    const records = [record('a', 1, 10), record('b', 2, 10), record('c', 3, 10)];
    expect(planSnapshotEviction(records, { maxCount: 2, maxBytes: 1_000 })).toEqual([
      `${ROOT}/${BOARD_ID}/a`,
    ]);
  });

  it('体积超标时从最旧删到达标', () => {
    const records = [record('a', 1, 40), record('b', 2, 40), record('c', 3, 40)];
    expect(planSnapshotEviction(records, { maxCount: 50, maxBytes: 100 })).toEqual([
      `${ROOT}/${BOARD_ID}/a`,
    ]);
  });

  it('★ 单份就超过体积上限时仍保留最新那份（否则等于把救命的东西删干净）', () => {
    const records = [record('a', 1, 999)];
    expect(planSnapshotEviction(records, { maxCount: 50, maxBytes: 100 })).toEqual([]);
  });

  it('空列表不做事', () => {
    expect(planSnapshotEviction([], { maxCount: 50, maxBytes: 100 })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────

describe('SnapshotStore', () => {
  it('首次写盘就落下第一份，并按 boardId 分目录', async () => {
    const { io, store } = makeStore();
    const record = await store.captureIfDue(BOARD_ID, 1, boardText(1));

    expect(record).not.toBeNull();
    expect(io.writes).toEqual([`${ROOT}/${BOARD_ID}/2026-09-12T10-00-00Z.nboard`]);
    expect(record?.cardCount).toBe(3);
  });

  it('间隔内不再打第二份，过了间隔且 revision 变了才打', async () => {
    const { io, store, tick } = makeStore();

    await store.captureIfDue(BOARD_ID, 1, boardText(1));
    tick(60_000);
    expect(await store.captureIfDue(BOARD_ID, 2, boardText(2))).toBeNull(); // 只过了 1 分钟

    tick(5 * 60_000);
    expect(await store.captureIfDue(BOARD_ID, 3, boardText(3))).not.toBeNull();
    expect(io.writes).toHaveLength(2);
  });

  it('revision 没变时即使时间到了也不打', async () => {
    const { store, tick } = makeStore();
    await store.captureIfDue(BOARD_ID, 1, boardText(1));
    tick(10 * 60_000);
    expect(await store.captureIfDue(BOARD_ID, 1, boardText(1))).toBeNull();
  });

  it('关掉开关后不再产生新快照，但已有快照原样保留', async () => {
    const { io, store, tick } = makeStore({ enabled: false });
    expect(await store.captureIfDue(BOARD_ID, 1, boardText(1))).toBeNull();
    expect(io.writes).toHaveLength(0);
    tick(1_000);
    expect(await store.list(BOARD_ID)).toEqual([]);
  });

  it('list 按新 → 旧返回，latest 取最新一份', async () => {
    const { store, tick } = makeStore({ maxCount: 50 });
    await store.capture(BOARD_ID, 1, boardText(1, 2));
    tick(60_000);
    await store.capture(BOARD_ID, 2, boardText(2, 5));

    const list = await store.list(BOARD_ID);
    expect(list).toHaveLength(2);
    expect(list[0].capturedAt).toBeGreaterThan(list[1].capturedAt);
    expect(list[0].cardCount).toBe(5);
    expect((await store.latest(BOARD_ID))?.path).toBe(list[0].path);
  });

  it('同一秒连打两份时文件名顺延，不会互相覆盖', async () => {
    const { io, store } = makeStore();
    await store.capture(BOARD_ID, 1, boardText(1));
    await store.capture(BOARD_ID, 2, boardText(2));
    expect(io.writes).toHaveLength(2);
    expect(new Set(io.writes).size).toBe(2);
    expect(await store.list(BOARD_ID)).toHaveLength(2);
  });

  it('超过份数上限后，最旧的快照被清掉', async () => {
    const { io, store, tick } = makeStore({ maxCount: 2 });
    await store.capture(BOARD_ID, 1, boardText(1, 1));
    tick(60_000);
    await store.capture(BOARD_ID, 2, boardText(2, 2));
    tick(60_000);
    await store.capture(BOARD_ID, 3, boardText(3, 3));

    const list = await store.list(BOARD_ID);
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.cardCount)).toEqual([3, 2]);
    expect(io.files.has(`${ROOT}/${BOARD_ID}/2026-09-12T10-00-00Z.nboard`)).toBe(false);
  });

  it('切换快照位置后 invalidate，会在新位置立刻落下第一份', async () => {
    const { io, store, tick, setRoot } = makeStore();
    await store.captureIfDue(BOARD_ID, 1, boardText(1));
    expect(io.writes).toEqual([`${ROOT}/${BOARD_ID}/2026-09-12T10-00-00Z.nboard`]);

    const pluginRoot = '.obsidian/plugins/nestboard/snapshots';
    setRoot(pluginRoot);
    tick(60_000);
    // 没 invalidate：缓存还认为"刚打过"，间隔不够 → 不打
    expect(await store.captureIfDue(BOARD_ID, 2, boardText(2))).toBeNull();

    store.invalidate();
    // 新位置一份都没有 → 立刻打第一份
    expect(await store.captureIfDue(BOARD_ID, 2, boardText(2))).not.toBeNull();
    expect(io.files.has(`${pluginRoot}/${BOARD_ID}/2026-09-12T10-01-00Z.nboard`)).toBe(true);
  });
});
