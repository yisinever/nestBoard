/**
 * 用户模板库（`T4.14` / `F7-06`）单元测试。
 *
 * 这一层管的是**文件**：认不认一个路径是模板、一份坏模板会不会拖垮整张列表、
 * 同名时顺延还是覆盖。三条都直接决定用户"看得见什么"，所以逐条钉住：
 *
 * * `isTemplatePath` **认子目录**、认扩展名，且 `''`（库根）时拒绝一切 ——
 *   "全库的板都算模板"不是任何人想要的。
 * * 坏模板 / 读不出来的模板**只计数不抛**：一份坏文件不该让整张列表打不开。
 * * 「另存为模板」重名**顺延**、名字**净化**、写出去的是 `packTemplate` 的产物
 *   （换 id、`parent` 归空、视口落回原点、清只读）。
 *
 * 用内存版 `VaultIO`，不碰 `obsidian`。
 */

import { describe, expect, it } from 'vitest';

import { serializeBoard } from '../../io/BoardRepository';
import {
  isTemplatePath,
  listUserTemplates,
  readTemplate,
  saveBoardAsTemplate,
} from '../../io/templateLibrary';
import { createBoardFile, createCard } from '../../model/factories';
import type { BoardFile } from '../../model/schema';
import type NestboardPlugin from '../../main';
import { MemoryVaultIO } from '../helpers/memoryVault';

interface Harness {
  plugin: NestboardPlugin;
  vaultIO: MemoryVaultIO;
}

function fakePlugin(options: { folder?: string; files?: Record<string, string> } = {}): Harness {
  const vaultIO = new MemoryVaultIO(options.files ?? {});
  const plugin = {
    settings: { templateFolder: options.folder ?? 'Templates' },
    vaultIO,
  };
  return { plugin: plugin as unknown as NestboardPlugin, vaultIO };
}

/** 一份合法的板文件文本，标题可指定（空标题用于验证回退到文件名） */
function boardText(title = '模板 A'): string {
  const board = createBoardFile({ meta: { title }, cards: [createCard('note')] });
  return serializeBoard(board);
}

// ─────────────────────────────────────────────────────────────
// isTemplatePath
// ─────────────────────────────────────────────────────────────

describe('isTemplatePath', () => {
  it('模板目录下的 `.nboard` 是模板', () => {
    expect(isTemplatePath('Templates', 'Templates/研究.nboard')).toBe(true);
  });

  it('认子目录（用户按主题分文件夹是很自然的诉求）', () => {
    expect(isTemplatePath('Templates', 'Templates/研究/访谈.nboard')).toBe(true);
  });

  it('目录末尾多个 `/` 不影响判断', () => {
    expect(isTemplatePath('Templates/', 'Templates/研究.nboard')).toBe(true);
  });

  it('别的目录下的板不是模板', () => {
    expect(isTemplatePath('Templates', 'Boards/日常.nboard')).toBe(false);
  });

  it('同前缀但不是子目录（`TemplatesX/`）不算', () => {
    expect(isTemplatePath('Templates', 'TemplatesX/日常.nboard')).toBe(false);
  });

  it('非 `.nboard` 的文件不算', () => {
    expect(isTemplatePath('Templates', 'Templates/说明.md')).toBe(false);
  });

  it('目录为空（库根）时**拒绝一切**：全库都是模板不是任何人想要的', () => {
    expect(isTemplatePath('', 'Templates/研究.nboard')).toBe(false);
    expect(isTemplatePath('', '随便一块板.nboard')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// listUserTemplates
// ─────────────────────────────────────────────────────────────

describe('listUserTemplates', () => {
  it('只列模板目录下的板，且稳定排序', async () => {
    const { plugin } = fakePlugin({
      files: {
        'Templates/乙.nboard': boardText('乙'),
        'Templates/甲.nboard': boardText('甲'),
        'Templates/研究/丙.nboard': boardText('丙'),
        'Boards/日常.nboard': boardText('日常'),
        'Templates/说明.md': 'not a board',
      },
    });

    const { templates, skipped } = await listUserTemplates(plugin);

    // 顺序 = 路径的稳定排序（不跟着文件系统返回顺序飘），不是"目录优先"
    expect(templates.map((template) => template.path)).toEqual([
      'Templates/乙.nboard',
      'Templates/甲.nboard',
      'Templates/研究/丙.nboard',
    ]);
    expect(skipped).toBe(0);
  });

  it('标题优先 `meta.title`，空标题回退到文件名', async () => {
    const { plugin } = fakePlugin({
      files: {
        'Templates/有标题.nboard': boardText('真正的标题'),
        'Templates/没标题.nboard': boardText('   '),
      },
    });

    const { templates } = await listUserTemplates(plugin);
    const byPath = new Map(templates.map((template) => [template.path, template.title]));

    expect(byPath.get('Templates/有标题.nboard')).toBe('真正的标题');
    expect(byPath.get('Templates/没标题.nboard')).toBe('没标题');
  });

  it('列表里带上"多少张卡 / 多少栏 / 多少连线"的摘要', async () => {
    const { plugin } = fakePlugin({ files: { 'Templates/甲.nboard': boardText('甲') } });

    const { templates } = await listUserTemplates(plugin);

    expect(templates[0]?.summary).toEqual({ cards: 1, columns: 0, edges: 0 });
  });

  it('坏内容只计数不抛：一份坏文件不该让整张列表打不开', async () => {
    const { plugin } = fakePlugin({
      files: {
        'Templates/好的.nboard': boardText('好的'),
        'Templates/坏 JSON.nboard': '{ this is not json',
        'Templates/不是板.nboard': '{"hello":"world"}',
      },
    });

    const { templates, skipped } = await listUserTemplates(plugin);

    expect(templates.map((template) => template.path)).toEqual(['Templates/好的.nboard']);
    expect(skipped).toBe(2);
  });

  it('读失败的模板同样只计数（文件刚被删 / 权限问题）', async () => {
    const vaultIO = new MemoryVaultIO({ 'Templates/读不了.nboard': boardText('读不了') });
    vaultIO.read = async (path: string) => {
      if (path === 'Templates/读不了.nboard') throw new Error('permission denied');
      return MemoryVaultIO.prototype.read.call(vaultIO, path);
    };
    const plugin = {
      settings: { templateFolder: 'Templates' },
      vaultIO,
    } as unknown as NestboardPlugin;

    const { templates, skipped } = await listUserTemplates(plugin);

    expect(templates).toEqual([]);
    expect(skipped).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// readTemplate
// ─────────────────────────────────────────────────────────────

describe('readTemplate', () => {
  it('读出一份模板板（内容原样，不做实例化）', async () => {
    const { plugin } = fakePlugin({ files: { 'Templates/甲.nboard': boardText('甲') } });

    const board = await readTemplate(plugin, 'Templates/甲.nboard');

    expect(board?.meta.title).toBe('甲');
    expect(board?.cards).toHaveLength(1);
  });

  it('内容不是板文件 → `null`（与"读不出来"是两句话）', async () => {
    const { plugin } = fakePlugin({
      files: { 'Templates/坏.nboard': '{"hello":"world"}' },
    });

    expect(await readTemplate(plugin, 'Templates/坏.nboard')).toBeNull();
  });

  it('IO 层的错误照旧抛出：那是"库出问题了"，不是"这份模板坏了"', async () => {
    const { plugin } = fakePlugin();

    await expect(readTemplate(plugin, 'Templates/不存在.nboard')).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// saveBoardAsTemplate
// ─────────────────────────────────────────────────────────────

describe('saveBoardAsTemplate', () => {
  function sourceBoard(): BoardFile {
    const board = createBoardFile({
      meta: { title: '我的板', parent: 'Boards/父板.nboard', aliases: ['旧名'] },
      view: { x: 500, y: -200, zoom: 3, background: 'grid' },
      settings: { readOnly: true },
      cards: [createCard('note', { title: '一张卡' })],
    });
    return board;
  }

  it('写进模板目录，文件名来自传入的名字', async () => {
    const { plugin, vaultIO } = fakePlugin();

    const path = await saveBoardAsTemplate(plugin, sourceBoard(), '周会模板');

    expect(path).toBe('Templates/周会模板.nboard');
    expect(vaultIO.files.has(path)).toBe(true);
  });

  it('名字为空时回退到 `meta.title`', async () => {
    const { plugin } = fakePlugin();

    const path = await saveBoardAsTemplate(plugin, sourceBoard(), '   ');

    expect(path).toBe('Templates/我的板.nboard');
  });

  it('净化文件名（非法字符换成空格）', async () => {
    const { plugin } = fakePlugin();

    const path = await saveBoardAsTemplate(plugin, sourceBoard(), 'a/b:c*d');

    expect(path).toBe('Templates/a b c d.nboard');
  });

  it('重名顺延（`名字` → `名字 2`），绝不覆盖已有模板', async () => {
    const { plugin } = fakePlugin({ files: { 'Templates/周会模板.nboard': boardText('旧的') } });

    const path = await saveBoardAsTemplate(plugin, sourceBoard(), '周会模板');

    expect(path).toBe('Templates/周会模板 2.nboard');
  });

  it('写出去的是 `packTemplate` 的产物：换 id / `parent` 归空 / 视口落回原点 / 清只读', async () => {
    const { plugin, vaultIO } = fakePlugin();
    const source = sourceBoard();

    const path = await saveBoardAsTemplate(plugin, source, '模板');
    const written = JSON.parse(vaultIO.files.get(path) ?? '{}') as BoardFile;

    expect(written.meta.id).not.toBe(source.meta.id);
    expect(written.meta.title).toBe('模板');
    expect(written.meta.parent).toBeNull();
    expect(written.meta.aliases).toEqual([]);
    expect(written.view).toMatchObject({ x: 0, y: 0, zoom: 1, background: 'grid' });
    expect(written.settings.readOnly).toBe(false);
    // 卡片 id 保持原样：这份文件只是"拿来用"的
    expect(written.cards[0]?.id).toBe(source.cards[0]?.id);
  });

  it('目录为空（库根）时写进库根：路径里没有目录前缀', async () => {
    const { plugin } = fakePlugin({ folder: '' });

    const path = await saveBoardAsTemplate(plugin, sourceBoard(), '模板');

    expect(path).toBe('模板.nboard');
  });
});
