import { describe, expect, it } from 'vitest';
import { BOARD_SPEC, BOARD_VERSION } from '../../constants';
import { migrateBoardFile, readBoardVersion, type MigrationStep } from '../../io/migrate';

describe('readBoardVersion', () => {
  it('只接受非负有限数值', () => {
    expect(readBoardVersion({ version: 3 })).toBe(3);
    expect(readBoardVersion({ version: 1.9 })).toBe(1);
    expect(readBoardVersion({ version: '2' })).toBeNull();
    expect(readBoardVersion({ version: -1 })).toBeNull();
    expect(readBoardVersion({ version: Number.NaN })).toBeNull();
    expect(readBoardVersion({})).toBeNull();
  });
});

describe('migrateBoardFile', () => {
  it('非对象直接失败', () => {
    expect(migrateBoardFile(null)).toEqual({ ok: false, reason: 'not-an-object', version: null });
    expect(migrateBoardFile('文本')).toEqual({
      ok: false,
      reason: 'not-an-object',
      version: null,
    });
    expect(migrateBoardFile([1, 2])).toEqual({
      ok: false,
      reason: 'not-an-object',
      version: null,
    });
  });

  it('version 缺失 → 按当前版本处理，不跑迁移链（宽容手写文件）', () => {
    const result = migrateBoardFile({ cards: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toEqual([]);
    expect(result.value.version).toBe(BOARD_VERSION);
    expect(result.value.spec).toBe(BOARD_SPEC);
    expect(result.value.cards).toEqual([]);
  });

  it('version 高于当前版本 → future-version（上层必须进入只读保护态）', () => {
    const result = migrateBoardFile({ version: BOARD_VERSION + 1, cards: [] });
    expect(result).toEqual({
      ok: false,
      reason: 'future-version',
      version: BOARD_VERSION + 1,
    });
  });

  it('迁移链断链 → no-migration-path（宁可开不了，也不能迁错）', () => {
    const result = migrateBoardFile({ version: 0, cards: [] });
    expect(result).toEqual({ ok: false, reason: 'no-migration-path', version: 0 });
  });

  it('注入迁移链后按 0→1 执行，并记录 applied', () => {
    const steps: MigrationStep[] = [
      {
        to: 1,
        description: '把旧字段 content.text 改名为 content.md',
        migrate: (input) => {
          const cards = Array.isArray(input.cards) ? input.cards : [];
          return {
            ...input,
            cards: cards.map((card) => {
              if (typeof card !== 'object' || card === null) return card;
              const record = card as Record<string, unknown>;
              if (record.type !== 'note') return card;
              return { ...record, content: { md: '迁移后', editorMode: 'markdown' } };
            }),
          };
        },
      },
    ];

    const result = migrateBoardFile(
      { version: 0, cards: [{ id: 'c_1', type: 'note', content: { text: '旧内容' } }] },
      steps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toEqual(['v1 · 把旧字段 content.text 改名为 content.md']);
    expect(result.value.version).toBe(BOARD_VERSION);
    expect(result.value.cards).toEqual([
      { id: 'c_1', type: 'note', content: { md: '迁移后', editorMode: 'markdown' } },
    ]);
  });

  it('不修改入参对象（纯函数，避免"迁一半"的脏状态）', () => {
    const input = { version: 0, cards: [] };
    const steps: MigrationStep[] = [
      { to: 1, description: 'noop', migrate: (value) => ({ ...value }) },
    ];
    migrateBoardFile(input, steps);
    expect(input.version).toBe(0);
  });
});
