import { describe, expect, it, vi } from 'vitest';

import { DragDropBridge } from '../../integration/DragDropBridge';
import type { DragDropPorts, DragDropPreview, DragHost } from '../../integration/DragDropBridge';

/**
 * 假 DOM 宿主：只记账。
 *
 * `DragDropBridge` 刻意只依赖 `DragHost` 这个最小接口（见其文件头注释），
 * 所以这里不必起 jsdom —— 事件派发、`contains` 判定都由测试自己控制。
 */
class FakeHost implements DragHost {
  private readonly listeners = new Map<string, Set<EventListener>>();
  /** `contains` 认为"在宿主内部"的那个节点 */
  inside: unknown = null;

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  contains(other: unknown): boolean {
    return other !== null && other !== undefined && other === this.inside;
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event as Event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface FakeFileSpec {
  name: string;
  size?: number;
  type?: string;
  /** 落库时返回的路径；`null` 表示导入失败 */
  landAs?: string | null;
}

function fakeFile(spec: FakeFileSpec): { file: File; arrayBufferCalls: () => number } {
  let calls = 0;
  const file = {
    name: spec.name,
    size: spec.size ?? 128,
    type: spec.type ?? 'application/octet-stream',
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      calls += 1;
      return new ArrayBuffer(8);
    },
  } as unknown as File;
  return { file, arrayBufferCalls: () => calls };
}

interface FakeDragEventInit {
  text?: string;
  /** `text/uri-list` 专用（系统文件管理器只给这一种时用它）。缺省时退回 `text` */
  uriText?: string;
  files?: File[];
  clientX?: number;
  clientY?: number;
  relatedTarget?: unknown;
}

function dragEvent(init: FakeDragEventInit = {}): {
  event: DragEvent;
  defaultPrevented: () => boolean;
  propagationStopped: () => boolean;
  dropEffect: () => string;
} {
  let prevented = false;
  let stopped = false;
  const transfer = {
    getData: (type: string): string => {
      if (type === 'text/plain') return init.text ?? '';
      if (type === 'text/uri-list') return init.uriText ?? init.text ?? '';
      return '';
    },
    files: init.files ?? [],
    dropEffect: 'none',
  };
  const event = {
    dataTransfer: transfer,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    relatedTarget: init.relatedTarget ?? null,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as DragEvent;
  return {
    event,
    defaultPrevented: () => prevented,
    propagationStopped: () => stopped,
    dropEffect: () => transfer.dropEffect,
  };
}

/** 记录所有回调，供断言 */
function createPorts(
  overrides: Partial<DragDropPorts> & { resolvePath?: (path: string) => string | null } = {},
): {
  ports: DragDropPorts;
  previews: (DragDropPreview | null)[];
  drops: { paths: readonly string[]; x: number; y: number }[];
  texts: { content: string; x: number; y: number }[];
  importing: number[];
  failed: string[][];
} {
  const previews: (DragDropPreview | null)[] = [];
  const drops: { paths: readonly string[]; x: number; y: number }[] = [];
  const texts: { content: string; x: number; y: number }[] = [];
  const importing: number[] = [];
  const failed: string[][] = [];
  const ports: DragDropPorts = {
    resolvePath: overrides.resolvePath ?? (() => null),
    importFile: overrides.importFile ?? (async () => null),
    onPreview: (preview) => previews.push(preview),
    onDrop: (paths, x, y) => drops.push({ paths, x, y }),
    onDropText: (content, x, y) => texts.push({ content, x, y }),
    onImporting: (count) => importing.push(count),
    onImportFailed: (names) => failed.push([...names]),
  };
  return { ports, previews, drops, texts, importing, failed };
}

describe('DragDropBridge · 库内路径优先', () => {
  it('文本里是库内路径：直接预览 + 落卡，不去碰系统文件', async () => {
    const host = new FakeHost();
    const { ports, previews, drops, importing } = createPorts({
      resolvePath: (path) => (path === 'Notes/A.md' ? path : null),
    });
    const importFile = vi.fn(async () => 'should-not-be-used');
    ports.importFile = importFile;

    new DragDropBridge(host, ports);
    host.emit('dragover', dragEvent({ text: '[[Notes/A.md]]', clientX: 10, clientY: 20 }).event);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.items).toEqual([{ kind: 'noteRef', name: 'A.md' }]);
    expect(previews[0]?.clientX).toBe(10);

    host.emit('drop', dragEvent({ text: '[[Notes/A.md]]', clientX: 10, clientY: 20 }).event);

    expect(importFile).not.toHaveBeenCalled();
    expect(importing).toEqual([]);
    // 收起预览（null）与落卡各一次
    expect(previews.at(-1)).toBeNull();
    expect(drops).toEqual([{ paths: ['Notes/A.md'], x: 10, y: 20 }]);
  });

  it('拖拽接受时 preventDefault / stopPropagation / dropEffect=copy（否则 Obsidian 会顺手打开文件）', () => {
    const host = new FakeHost();
    const { ports } = createPorts({ resolvePath: (path) => path });
    new DragDropBridge(host, ports);

    const probe = dragEvent({ text: '[[Notes/A.md]]' });
    host.emit('dragover', probe.event);

    expect(probe.defaultPrevented()).toBe(true);
    expect(probe.propagationStopped()).toBe(true);
    expect(probe.dropEffect()).toBe('copy');
  });

  it('什么都接受不了时不拦事件，把它还给 Obsidian', () => {
    const host = new FakeHost();
    const { ports, previews } = createPorts({ resolvePath: () => null });
    new DragDropBridge(host, ports);

    const probe = dragEvent({ text: 'https://example.com/x' });
    host.emit('dragover', probe.event);

    expect(probe.defaultPrevented()).toBe(false);
    expect(previews).toEqual([]);
  });
});

describe('DragDropBridge · 系统文件（T1.65）', () => {
  it('导入 → 用返回的库内路径落卡，并报告导入数量', async () => {
    const host = new FakeHost();
    const { file } = fakeFile({ name: '图.png' });
    const { ports, drops, importing, failed } = createPorts({
      importFile: async () => 'attachments/图.png',
    });
    new DragDropBridge(host, ports);

    host.emit('dragover', dragEvent({ files: [file], clientX: 5, clientY: 6 }).event);
    host.emit('drop', dragEvent({ files: [file], clientX: 5, clientY: 6 }).event);
    await Promise.resolve();

    expect(importing).toEqual([1]);
    expect(failed).toEqual([]);
    expect(drops).toEqual([{ paths: ['attachments/图.png'], x: 5, y: 6 }]);
  });

  it('导入失败只提示文件名，不阻断其余项', async () => {
    const host = new FakeHost();
    const ok = fakeFile({ name: 'ok.md' });
    const bad = fakeFile({ name: 'broken.png' });
    const { ports, drops, failed } = createPorts({
      importFile: async (file) => (file.name === 'broken.png' ? null : 'attachments/ok.md'),
    });
    new DragDropBridge(host, ports);

    host.emit('drop', dragEvent({ files: [ok.file, bad.file] }).event);
    // 两个文件是**串行**导入的，各自 `await` 一次 → 等"该落的都落了"这件事真的发生，
    // 而不是拍一个固定时长（见下一条用例的说明）
    await vi.waitFor(() => expect(drops).toHaveLength(1));

    expect(failed).toEqual([['broken.png']]);
    expect(drops[0]?.paths).toEqual(['attachments/ok.md']);
  });

  it('串行导入：落卡顺序与拖入顺序一致（T1.66 的错开落位依赖它）', async () => {
    const host = new FakeHost();
    const a = fakeFile({ name: 'a.png' });
    const b = fakeFile({ name: 'b.png' });
    const order: string[] = [];
    const started: string[] = [];
    /** 卡住第一个导入，直到测试放行（这样"第二个有没有开始"就成了可断言的事实） */
    let releaseA: () => void = () => {};

    const { ports, drops } = createPorts({
      importFile: async (file) => {
        started.push(file.name);
        // 真实的 `arrayBuffer()` 是异步的：这里让它**真的挂住**，而不是"睡 2 毫秒"——
        // 睡多久都是拿机器的快慢当判据，全套用例并行跑时必然偶发
        if (file.name === 'a.png') {
          await new Promise<void>((resolve) => {
            releaseA = resolve;
          });
        }
        order.push(file.name);
        return `attachments/${file.name}`;
      },
    });
    new DragDropBridge(host, ports);

    host.emit('drop', dragEvent({ files: [a.file, b.file] }).event);

    // ★ 串行的判据在这里：第一个还没解析完，第二个**根本不该开始**
    //   （实现改成 `Promise.all` 的话，`started` 立刻就是两个）
    await vi.waitFor(() => expect(started).toEqual(['a.png']));
    expect(started).toEqual(['a.png']);
    expect(order).toEqual([]);

    releaseA();
    // ★ `onDrop` 是**一次**回调带两个路径（不是两次回调）—— 等"两个都落了"这件事发生
    await vi.waitFor(() => expect(order).toEqual(['a.png', 'b.png']));
    expect(drops).toHaveLength(1);

    expect(order).toEqual(['a.png', 'b.png']);
    expect(drops[0]?.paths).toEqual(['attachments/a.png', 'attachments/b.png']);
  });

  it('文件夹（size 0 且无 type）被丢掉：不会凭空写出一个 0 字节的假文件', () => {
    const host = new FakeHost();
    const folder = fakeFile({ name: 'Folder', size: 0, type: '' });
    const { ports, previews } = createPorts();
    new DragDropBridge(host, ports);

    host.emit('dragover', dragEvent({ files: [folder.file] }).event);
    expect(previews).toEqual([]);
  });

  it('拖入文件夹后松手：给出提示，而不是"什么都没发生"', () => {
    const host = new FakeHost();
    const folder = fakeFile({ name: 'Folder', size: 0, type: '' });
    const { ports, drops, failed } = createPorts();
    new DragDropBridge(host, ports);

    host.emit('drop', dragEvent({ files: [folder.file] }).event);

    // 不落卡、不导入 —— 但**必须**说一句话，否则用户只会认为插件坏了
    expect(drops).toEqual([]);
    expect(failed).toEqual([['Folder']]);
  });

  it('拖入一段文字（没有 files）时不提示：无声无息本来就是对的', () => {
    const host = new FakeHost();
    const { ports, failed } = createPorts({ resolvePath: () => null });
    new DragDropBridge(host, ports);

    host.emit('drop', dragEvent({ text: 'https://example.com/x' }).event);

    expect(failed).toEqual([]);
  });
});

describe('DragDropBridge · 一段文本 → 便签卡（T6.11 / F6-07）', () => {
  it('文本既不是库内路径也不是外链：预览成便签、落点走 `onDropText`', async () => {
    const host = new FakeHost();
    const { ports, previews, drops, texts, importing } = createPorts({ resolvePath: () => null });
    new DragDropBridge(host, ports);

    host.emit(
      'dragover',
      dragEvent({ text: '# 会议记录\n讨论三件事', clientX: 30, clientY: 40 }).event,
    );
    expect(previews).toHaveLength(1);
    expect(previews[0]?.items).toEqual([{ kind: 'note', name: '会议记录' }]);

    host.emit(
      'drop',
      dragEvent({ text: '# 会议记录\n讨论三件事', clientX: 30, clientY: 40 }).event,
    );
    await Promise.resolve();

    // 便签不是"路径卡"：走另一个口，且不该被当成"正在导入 1 个文件"
    expect(drops).toEqual([]);
    expect(texts).toEqual([{ content: '# 会议记录\n讨论三件事', x: 30, y: 40 }]);
    expect(importing).toEqual([]);
  });

  it('文本是库内路径时仍走路径那条路（便签分支排在最后，抢不走它）', async () => {
    const host = new FakeHost();
    const { ports, drops, texts } = createPorts({
      resolvePath: (path) => (path === 'Notes/A.md' ? path : null),
    });
    new DragDropBridge(host, ports);

    host.emit('drop', dragEvent({ text: '[[Notes/A.md]]' }).event);
    await Promise.resolve();

    expect(drops).toEqual([{ paths: ['Notes/A.md'], x: 0, y: 0 }]);
    expect(texts).toEqual([]);
  });

  it('`file://` 的 uri-list 仍走导入（便签分支不截胡 T1.65）', async () => {
    const host = new FakeHost();
    const { ports, drops, texts } = createPorts();
    ports.importUri = async () => 'attachments/pic.png';
    new DragDropBridge(host, ports);

    host.emit('drop', dragEvent({ uriText: 'file:///Users/me/pic.png' }).event);
    await Promise.resolve();

    expect(texts).toEqual([]);
    expect(drops).toEqual([{ paths: ['attachments/pic.png'], x: 0, y: 0 }]);
  });

  it('拖一段外链什么都不发生（既有行为不被便签分支改掉）', async () => {
    const host = new FakeHost();
    const { ports, previews, drops, texts, failed } = createPorts({ resolvePath: () => null });
    new DragDropBridge(host, ports);

    host.emit('dragover', dragEvent({ text: 'https://example.com/x' }).event);
    host.emit('drop', dragEvent({ text: 'https://example.com/x' }).event);
    await Promise.resolve();

    expect(previews).toEqual([]);
    expect(drops).toEqual([]);
    expect(texts).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('只有空白的一段选区：不预览、不落点、也不提示', async () => {
    const host = new FakeHost();
    const { ports, previews, drops, texts, failed } = createPorts({ resolvePath: () => null });
    new DragDropBridge(host, ports);

    host.emit('dragover', dragEvent({ text: '   \n\t ' }).event);
    host.emit('drop', dragEvent({ text: '   \n\t ' }).event);
    await Promise.resolve();

    expect(previews).toEqual([]);
    expect(drops).toEqual([]);
    expect(texts).toEqual([]);
    expect(failed).toEqual([]);
  });
});

describe('DragDropBridge · 预览收起', () => {
  it('指针在画布内部元素间移动（relatedTarget 在宿主内）不收起预览', () => {
    const host = new FakeHost();
    const { ports, previews } = createPorts({ resolvePath: (path) => path });
    new DragDropBridge(host, ports);

    host.emit('dragover', dragEvent({ text: '[[A.md]]' }).event);
    host.inside = { some: 'card' };
    host.emit('dragleave', dragEvent({ relatedTarget: host.inside }).event);

    expect(previews).toEqual([expect.objectContaining({ clientX: 0 })]);
  });

  it('真的离开宿主（relatedTarget 在外面 / 为 null）才收起', () => {
    const host = new FakeHost();
    const { ports, previews } = createPorts({ resolvePath: (path) => path });
    new DragDropBridge(host, ports);

    host.emit('dragover', dragEvent({ text: '[[A.md]]' }).event);
    host.emit('dragleave', dragEvent({ relatedTarget: null }).event);

    expect(previews.at(-1)).toBeNull();
  });

  it('从未预览过时，`dragleave` 不产生多余的收起回调', () => {
    const host = new FakeHost();
    const { ports, previews } = createPorts();
    new DragDropBridge(host, ports);

    host.emit('dragleave', dragEvent({ relatedTarget: null }).event);
    expect(previews).toEqual([]);
  });
});

describe('DragDropBridge · 生命周期', () => {
  it('dispose 摘掉全部监听器', () => {
    const host = new FakeHost();
    const { ports } = createPorts({ resolvePath: (path) => path });
    const bridge = new DragDropBridge(host, ports);
    expect(host.listenerCount('dragover')).toBe(1);

    bridge.dispose();

    expect(host.listenerCount('dragover')).toBe(0);
    expect(host.listenerCount('drop')).toBe(0);
    expect(host.listenerCount('dragenter')).toBe(0);
    expect(host.listenerCount('dragleave')).toBe(0);
  });
});
