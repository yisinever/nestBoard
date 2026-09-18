/**
 * 脑图的写盘侧（`06 §9` P0-b）：序列化 + 在库里建一份新脑图。
 *
 * 两条纪律在这里被钉住：
 *
 * 1. **往返**：`parse(serialize(x))` 与 `x` 逐字段相等。有了序列化器之后，
 *    这才是"读一遍写回去逐字节不变"（`06 §3` 纪律 2）**真正能测**的那个形态
 *    —— 在 P0-a 里它只能拿"幂等"当代理；
 * 2. **落盘路径**：目录默认 `Minds/`、重名顺延、写出去的是一份合法脑图。
 *
 * ★ 假 plugin 只需要 `vaultIO` 的 `exists` / `create` 两个能力 —— 这正是
 *   `io/newMind.ts` 不 import Obsidian 运行时的回报（与 `io/newBoard.ts` 同一条）。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MIND_FOLDER, MIND_EXT } from '../../constants';
import { createMindInVault } from '../../mind/io/newMind';
import { serializeMindFile } from '../../mind/io/serialize';
import { createMindFile, createMindNode } from '../../mind/model/factories';
import type { MindFile } from '../../mind/model/schema';
import { parseMindFile } from '../../mind/model/validate';
import { t } from '../../util/i18n';
import type NestboardPlugin from '../../main';

/** 假 plugin：`exists` 认"已有文件"与"刚写的"，`create` 记下写了什么 */
function fakePlugin(existing: readonly string[] = []) {
  const written = new Map<string, string>();
  const vaultIO = {
    exists: async (path: string) => existing.includes(path) || written.has(path),
    create: async (path: string, data: string) => {
      if (written.has(path) || existing.includes(path)) throw new Error(`文件已存在：${path}`);
      written.set(path, data);
    },
  };
  return { plugin: { vaultIO } as unknown as NestboardPlugin, written };
}

/** 一份"用到了全部可选键"的脑图：往返测试要覆盖它们 */
function richMind(): MindFile {
  const file = createMindFile({ title: '产品脑暴', now: () => '2026-09-15T00:00:00.000Z' });
  file.nodes.push(
    createMindNode({
      text: 'A',
      note: '# 一段 Markdown',
      parentId: file.rootId,
      order: 0,
      collapsed: true,
      style: { color: '#4c8dff' },
      props: [{ id: 'p1', key: '负责人', value: '老王' }],
      refs: [{ kind: 'image', path: 'assets/a.png' }],
    }),
    createMindNode({ text: '自由主题', parentId: null, order: 0, free: { x: 320, y: -80 } }),
  );
  return file;
}

describe('serializeMindFile', () => {
  it('写出来是人类可读的 JSON（2 空格缩进 + 末尾换行），键名与 `.nboard` 对齐', () => {
    const text = serializeMindFile(createMindFile({ title: '产品脑暴' }));

    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "spec": "nestmind/1",');
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(raw).slice(0, 4)).toEqual(['spec', 'version', 'revision', 'meta']);
    expect(raw.rootId).toBeTruthy();
  });

  it('★ 可选键缺席就不写：新建的文件里没有 `collapsed` / `style` / `free` 的噪声', () => {
    const text = serializeMindFile(createMindFile({ title: '空' }));
    expect(text).not.toContain('"collapsed"');
    expect(text).not.toContain('"style"');
    expect(text).not.toContain('"free"');
  });
});

describe('往返：serialize → parse', () => {
  it('★ 写出去再读回来，**逐字段相等且零 issue**（读一遍写回去不改字节）', () => {
    const original = richMind();

    const parsed = parseMindFile(serializeMindFile(original));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.issues).toEqual([]);
    expect(parsed.file).toEqual(original);
  });
});

describe('createMindInVault', () => {
  it(`默认落在 ${DEFAULT_MIND_FOLDER}/，文件名是标题，内容是合法脑图`, async () => {
    const { plugin, written } = fakePlugin();

    const path = await createMindInVault(plugin);

    expect(path).toBe(`${DEFAULT_MIND_FOLDER}/${t('mind.untitled')}.${MIND_EXT}`);
    const parsed = parseMindFile(written.get(path) ?? '');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.meta.title).toBe(t('mind.untitled'));
    // 新文件必定带一个中心主题（`06 §1` 第 9 条）
    expect(parsed.file.nodes).toHaveLength(1);
    expect(parsed.file.nodes[0]?.id).toBe(parsed.file.rootId);
  });

  it('传了标题就用它（同时是文件名的主名）', async () => {
    const { plugin, written } = fakePlugin();

    const path = await createMindInVault(plugin, { title: '产品脑暴' });

    expect(path).toBe(`${DEFAULT_MIND_FOLDER}/产品脑暴.${MIND_EXT}`);
    expect(written.get(path)).toContain('"title": "产品脑暴"');
  });

  it('★ 同名时顺延，绝不覆盖已有的那一份', async () => {
    const taken = `${DEFAULT_MIND_FOLDER}/产品脑暴.${MIND_EXT}`;
    const { plugin } = fakePlugin([taken]);

    const path = await createMindInVault(plugin, { title: '产品脑暴' });

    expect(path).toBe(`${DEFAULT_MIND_FOLDER}/产品脑暴 2.${MIND_EXT}`);
  });

  it('可以指定目录（P1 接上设置之后，这里就是设置项的去处）', async () => {
    const { plugin } = fakePlugin();

    const path = await createMindInVault(plugin, { title: '深一层', folder: 'Deep/子目录' });

    expect(path).toBe(`Deep/子目录/深一层.${MIND_EXT}`);
  });

  it('`exactPath` 钉死路径，不再顺延（位置由调用方说了算）', async () => {
    const { plugin } = fakePlugin();

    const path = await createMindInVault(plugin, { exactPath: '随便/哪里.nestmind' });

    expect(path).toBe('随便/哪里.nestmind');
  });

  it('标题前后的空白不算标题（与 `noteNameFrom` 同一口径）', async () => {
    const { plugin } = fakePlugin();

    const path = await createMindInVault(plugin, { title: '   ' });

    expect(path).toBe(`${DEFAULT_MIND_FOLDER}/${t('mind.untitled')}.${MIND_EXT}`);
  });
});
