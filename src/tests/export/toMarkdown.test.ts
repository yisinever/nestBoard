/**
 * 导出 Markdown 的单元测试（T1.72 / `F9-01`）。
 *
 * 这块逻辑只有一种失败方式：**导出物悄悄少了东西** —— 卡片被吞进一个不存在的
 * 分栏、并排的两栏顺序颠倒、重复导出攒出一堆文件。这些都不会抛错，只会让用户
 * 在某个下午突然发现"导出的笔记跟白板对不上"。所以这里把三条线性化规则
 * 与"只覆盖自己导出物"的落盘策略都钉死。
 *
 * 纯函数 + 内存 sink，不碰 Obsidian：Notice / 真实写盘那部分只能在 Obsidian 里肉眼验证。
 */

import { describe, expect, it } from 'vitest';
import { createBoardFile } from '../../model/factories';
import type { BoardFile, Card, CardOf, Column, NoteContent } from '../../model/schema';
import type { MarkdownCardSource } from '../../export/toMarkdown';
import { byReadingOrder, exportBoardToMarkdown } from '../../export/toMarkdown';
import type { MarkdownExportSink, MarkdownExportTarget } from '../../export/MarkdownExporter';
import { MarkdownExporter, boardNameOf, exportMarker } from '../../export/MarkdownExporter';
import { t } from '../../util/i18n';

/** 只认便签卡的假数据源：`md` 直接就是片段，方便把注意力放在"顺序"上 */
const noteSource: MarkdownCardSource = {
  toMarkdown: (card) => (card.type === 'note' ? card.content.md : ''),
};

function note(id: string, overrides: Partial<CardOf<'note'>> = {}): Card {
  const content: NoteContent = { md: id, editorMode: 'markdown' };
  return {
    id,
    type: 'note',
    x: 0,
    y: 0,
    width: 240,
    height: 160,
    z: 1,
    columnId: null,
    order: 0,
    color: '1',
    accent: null,
    locked: false,
    showTitle: true,
    title: '',
    presentStep: null,
    content,
    ...overrides,
  };
}

function column(id: string, overrides: Partial<Column> = {}): Column {
  return {
    id,
    title: id,
    x: 0,
    y: 0,
    width: 280,
    height: 400,
    collapsed: false,
    color: '1',
    z: 1,
    ...overrides,
  };
}

function boardOf(cards: Card[], columns: Column[] = []): BoardFile {
  return { ...createBoardFile({ meta: { title: '项目A' } }), cards, columns };
}

const options = { sourcePath: 'Boards/项目A.nboard' };

describe('byReadingOrder', () => {
  it('单行时按 x 从左到右', () => {
    const items = [
      { id: 'b', x: 300, y: 0, height: 100 },
      { id: 'a', x: 0, y: 0, height: 100 },
    ];
    expect(byReadingOrder(items).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('多行时先上后下，行内仍从左到右', () => {
    const items = [
      { id: 'c', x: 0, y: 500, height: 100 },
      { id: 'b', x: 300, y: 10, height: 100 },
      { id: 'a', x: 0, y: 0, height: 100 },
    ];
    expect(byReadingOrder(items).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('y 只差几像素的并排项算同一行，而不是各占一行', () => {
    // a 的 y 更小（会先被排到），但 b 的 x 更小 —— 两者纵向重叠，就该是 b 在前。
    // 用"y 相等"判定分行的实现会得到 ['a','b']，这正是要挡住的错序。
    const items = [
      { id: 'a', x: 300, y: 0, height: 100 },
      { id: 'b', x: 0, y: 3, height: 100 },
    ];
    expect(byReadingOrder(items).map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('完全在下一行的项不会被并进上一行', () => {
    const items = [
      { id: 'a', x: 0, y: 0, height: 100 },
      { id: 'b', x: 0, y: 100, height: 100 },
    ];
    expect(byReadingOrder(items).map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('exportBoardToMarkdown', () => {
  it('输出 H1 标题，无标题时退回"未命名白板"', () => {
    const titled = exportBoardToMarkdown(boardOf([note('x')]), noteSource, options);
    expect(titled.markdown).toBe('# 项目A\n\nx\n');

    const board = boardOf([note('x')]);
    board.meta.title = '   ';
    // 用 `t()` 拼期望而不是写死中文：这块测的是"有没有兜底"，不是"兜底文案是不是中文"
    expect(exportBoardToMarkdown(board, noteSource, options).markdown).toBe(
      `# ${t('board.untitled')}\n\nx\n`,
    );
  });

  it('分栏成节，栏内按 order 排而不是按坐标', () => {
    const board = boardOf(
      [
        note('第二', { id: 'a', columnId: 'c1', order: 1, y: 0 }),
        note('第一', { id: 'b', columnId: 'c1', order: 0, y: 999 }),
      ],
      [column('c1', { title: '思路' })],
    );
    expect(exportBoardToMarkdown(board, noteSource, options).markdown).toBe(
      '# 项目A\n\n## 思路\n\n第一\n\n第二\n',
    );
  });

  it('分栏按阅读顺序成节：从左到右', () => {
    const board = boardOf(
      [note('左', { columnId: 'left' }), note('右', { columnId: 'right' })],
      [column('right', { title: '右栏', x: 600 }), column('left', { title: '左栏', x: 0 })],
    );
    expect(exportBoardToMarkdown(board, noteSource, options).markdown).toBe(
      '# 项目A\n\n## 左栏\n\n左\n\n## 右栏\n\n右\n',
    );
  });

  it('散卡放在最后，并带"未归类卡片"节标题', () => {
    const board = boardOf(
      [note('散卡'), note('栏内', { columnId: 'c1' })],
      [column('c1', { title: '思路' })],
    );
    expect(exportBoardToMarkdown(board, noteSource, options).markdown).toBe(
      `# 项目A\n\n## 思路\n\n栏内\n\n## ${t('export.looseCards')}\n\n散卡\n`,
    );
  });

  it('一块板全是散卡时不硬造"未归类卡片"节', () => {
    const board = boardOf([note('甲乙')]);
    expect(exportBoardToMarkdown(board, noteSource, options).markdown).toBe('# 项目A\n\n甲乙\n');
  });

  it('columnId 指向已删除分栏的卡片归入散卡，不会从导出物里消失', () => {
    const board = boardOf([note('孤儿', { columnId: 'gone' })], [column('c1', { title: '思路' })]);
    const result = exportBoardToMarkdown(board, noteSource, options);
    expect(result.markdown).toBe(`# 项目A\n\n## 思路\n\n## ${t('export.looseCards')}\n\n孤儿\n`);
    expect(result.exported).toBe(1);
  });

  it('空分栏保留标题（结构本身也是用户写下的信息）', () => {
    const board = boardOf([], [column('c1', { title: '待办' })]);
    expect(exportBoardToMarkdown(board, noteSource, options).markdown).toBe('# 项目A\n\n## 待办\n');
  });

  it('分栏标题为空时用占位文案', () => {
    const board = boardOf([note('x', { columnId: 'c1' })], [column('c1', { title: '  ' })]);
    expect(exportBoardToMarkdown(board, noteSource, options).markdown).toContain(
      `## ${t('column.title.placeholder')}`,
    );
  });

  it('片段为空的卡片被跳过并计数', () => {
    // 未注册的卡片类型在真实注册表里回落到空串，和"内容确实为空"走同一条路
    const board = boardOf([note('有的'), note('', { id: 'empty' })]);
    const result = exportBoardToMarkdown(board, noteSource, options);
    expect(result.exported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.markdown).toBe('# 项目A\n\n有的\n');
  });

  it('空板只有标题，exported 为 0（调用方据此给"没内容可导"的提示）', () => {
    const result = exportBoardToMarkdown(boardOf([]), noteSource, options);
    expect(result.exported).toBe(0);
    expect(result.markdown).toBe('# 项目A\n');
  });

  it('可以关掉 H1（把全文塞进别人笔记时用）', () => {
    const board = boardOf([note('x')]);
    expect(
      exportBoardToMarkdown(board, noteSource, { ...options, includeTitle: false }).markdown,
    ).toBe('x\n');
  });
});

/** 内存 sink：模拟 `VaultIO` 的四个口，`process` 就是"覆盖写" */
class MemorySink implements MarkdownExportSink {
  readonly files = new Map<string, string>();
  /** 打开它来模拟"文件存在但读不出来"（权限 / 编码异常） */
  readError = false;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    if (this.readError) throw new Error('unreadable');
    return this.files.get(path) ?? '';
  }

  async create(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async process(path: string, transform: (raw: string) => string): Promise<void> {
    this.files.set(path, transform(this.files.get(path) ?? ''));
  }
}

describe('MarkdownExporter', () => {
  const target: MarkdownExportTarget = {
    folder: 'Boards',
    name: '项目A',
    sourcePath: 'Boards/项目A.nboard',
  };

  it('首次导出按板名建文件，并把指纹补在末尾', async () => {
    const sink = new MemorySink();
    const path = await new MarkdownExporter(sink).export('# 项目A\n', target);

    expect(path).toBe('Boards/项目A.md');
    expect(sink.files.get(path)).toBe(
      '# 项目A\n\n<!-- nestboard:export source="Boards/项目A.nboard" -->\n',
    );
  });

  it('再次导出覆盖同一个文件，而不是攒出副本', async () => {
    const sink = new MemorySink();
    const exporter = new MarkdownExporter(sink);

    await exporter.export('# 第一版\n', target);
    const second = await exporter.export('# 第二版\n', target);

    expect(second).toBe('Boards/项目A.md');
    expect(sink.files.size).toBe(1);
    expect(sink.files.get(second)).toContain('第二版');
  });

  it('同名文件是用户自己的笔记时顺延，绝不覆盖', async () => {
    const sink = new MemorySink();
    sink.files.set('Boards/项目A.md', '# 我自己的笔记\n');

    const path = await new MarkdownExporter(sink).export('# 项目A\n', target);

    expect(path).toBe('Boards/项目A 2.md');
    expect(sink.files.get('Boards/项目A.md')).toBe('# 我自己的笔记\n');
  });

  it('顺延后的副本带着自己的指纹时，原地覆盖它', async () => {
    const sink = new MemorySink();
    sink.files.set('Boards/项目A.md', '# 我自己的笔记\n');
    sink.files.set('Boards/项目A 2.md', `# 旧导出\n\n${exportMarker(target.sourcePath)}\n`);

    const path = await new MarkdownExporter(sink).export('# 新导出\n', target);

    expect(path).toBe('Boards/项目A 2.md');
    expect(sink.files.get(path)).toContain('新导出');
    expect(sink.files.get('Boards/项目A.md')).toBe('# 我自己的笔记\n');
  });

  it('另一块白板的导出物不会被误认领', async () => {
    const sink = new MemorySink();
    sink.files.set('Boards/项目A.md', `# 别的板\n\n${exportMarker('Boards/别的板.nboard')}\n`);

    const path = await new MarkdownExporter(sink).export('# 项目A\n', target);

    expect(path).toBe('Boards/项目A 2.md');
    expect(sink.files.get('Boards/项目A.md')).toContain('别的板');
  });

  it('读不出来时按被占用处理，不覆盖看不透的内容', async () => {
    const sink = new MemorySink();
    sink.files.set('Boards/项目A.md', 'unreadable');
    sink.readError = true;

    const path = await new MarkdownExporter(sink).export('# 项目A\n', target);

    expect(path).toBe('Boards/项目A 2.md');
    expect(sink.files.get('Boards/项目A.md')).toBe('unreadable');
  });

  it('根目录白板不带前导斜杠', async () => {
    const sink = new MemorySink();
    const path = await new MarkdownExporter(sink).export('# T\n', {
      folder: '',
      name: '项目A',
      sourcePath: '项目A.nboard',
    });
    expect(path).toBe('项目A.md');
  });
});

describe('boardNameOf', () => {
  it('取文件主名（导出文件名兜底）', () => {
    expect(boardNameOf('Boards/项目A.nboard')).toBe('项目A');
    expect(boardNameOf('项目A.nboard')).toBe('项目A');
  });
});
