/**
 * 模板市场目录（`T6.09` / `F7-06`）单元测试。
 *
 * 这里钉的是"市场怎么分、怎么筛"的三条规矩：
 *
 * 1. **分组稳定且不混**：内置按 `TEMPLATE_CATEGORIES` 的声明顺序成组，用户模板自成一组
 *    排在最后。顺序一飘，用户每次打开市场都会看到模板换位置。
 * 2. **过滤是交集**：搜索词与分类切换同时生效，而不是互相覆盖。
 * 3. **键与显示名解耦**：`key` 是 `builtin:<id>` / `user:<路径>`，`ref` 才是交回动作层的
 *    身份。它们都不能跟着语言变 —— 否则切一次界面语言，DOM 上的 `data-key` 就全变了。
 *
 * 纯逻辑模块，不碰 `obsidian`、不碰 DOM；因为断言不能绑死语言，
 * 期望值一律先用 `t()` 算出来（与 `templates.test.ts` 同一套做法）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildTemplateCatalog,
  catalogSize,
  type CatalogInput,
  type CatalogUserTemplate,
} from '../../model/templateCatalog';
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from '../../model/templates';
import { t } from '../../util/i18n';

function userTemplate(
  path: string,
  title: string,
  cards = 3,
  columns = 1,
  minds = 0,
): CatalogUserTemplate {
  return { path, title, summary: { cards, columns, edges: 0, minds } };
}

function catalog(input: Partial<CatalogInput> = {}) {
  return buildTemplateCatalog({
    builtins: BUILTIN_TEMPLATES,
    users: [],
    query: '',
    category: 'all',
    ...input,
  });
}

describe('buildTemplateCatalog 分组', () => {
  it('内置模板按分类声明顺序成组，用户组排在最后', () => {
    const groups = catalog({ users: [userTemplate('Templates/我的.nboard', '我的板')] });

    expect(groups.map((group) => group.key)).toEqual([...TEMPLATE_CATEGORIES, 'user']);
  });

  it('每个内置模板都落在自己的分类组里', () => {
    for (const group of catalog()) {
      if (group.key === 'user') continue;
      expect(group.entries).toHaveLength(1);
      expect(group.entries[0].category).toBe(group.key);
      expect(group.entries[0].source).toBe('builtin');
    }
  });

  it('用户模板不与内置模板混在同一组', () => {
    const groups = catalog({
      users: [
        userTemplate('Templates/研究/甲.nboard', '甲'),
        userTemplate('Templates/乙.nboard', '乙'),
      ],
    });

    const userGroup = groups.find((group) => group.key === 'user');
    expect(userGroup?.entries.map((entry) => entry.title)).toEqual(['甲', '乙']);
    // 其它组一个用户模板都不该有
    for (const group of groups) {
      if (group.key === 'user') continue;
      expect(group.entries.every((entry) => entry.source === 'builtin')).toBe(true);
    }
  });

  it('没有用户模板时不吐出一个空的"我的模板"组', () => {
    expect(catalog().some((group) => group.key === 'user')).toBe(false);
  });
});

describe('buildTemplateCatalog 过滤', () => {
  it('搜索大小写不敏感，命中内置模板的名称', () => {
    const research = BUILTIN_TEMPLATES[0];
    const title = t(research.nameKey);

    const groups = catalog({ query: title.toUpperCase() });
    expect(catalogSize(groups)).toBe(1);
    expect(groups[0].entries[0].ref).toBe(research.id);
  });

  it('搜索也能命中内置模板的说明', () => {
    const research = BUILTIN_TEMPLATES[0];
    // 整句说明的前几个字：确保测的是"说明参与了过滤"，而不是名字碰巧也叫这个
    const needle = t(research.descKey).slice(0, 4);

    const groups = catalog({ query: needle });
    expect(
      groups.flatMap((group) => group.entries).some((entry) => entry.ref === research.id),
    ).toBe(true);
  });

  it('用户模板的路径参与搜索：用户记的是"放在哪个文件夹"，不是模板名', () => {
    const groups = catalog({
      users: [
        userTemplate('Templates/调研/甲.nboard', '甲'),
        userTemplate('Templates/乙.nboard', '乙'),
      ],
      query: '调研',
    });

    expect(catalogSize(groups)).toBe(1);
    expect(groups[0].entries[0].ref).toBe('Templates/调研/甲.nboard');
  });

  it('分类筛选只留下那一组', () => {
    const groups = catalog({ category: TEMPLATE_CATEGORIES[2] });

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(TEMPLATE_CATEGORIES[2]);
  });

  it('搜索与分类筛选是交集', () => {
    const research = BUILTIN_TEMPLATES[0];
    // 拿另一个分类去筛，再用研究模板的名字搜索 —— 交集必然为空
    const other = BUILTIN_TEMPLATES.find((template) => template.category !== research.category)!;
    const groups = catalog({ category: other.category, query: t(research.nameKey) });

    expect(catalogSize(groups)).toBe(0);
  });

  it('什么都没命中时返回空目录，而不是一堆空组', () => {
    expect(catalog({ query: '不存在的模板名字-xyz' })).toEqual([]);
  });
});

describe('buildTemplateCatalog 条目身份', () => {
  it('内置与用户的键各有前缀，且各自唯一', () => {
    const groups = catalog({ users: [userTemplate('Templates/甲.nboard', '甲')] });
    const entries = groups.flatMap((group) => group.entries);
    const keys = entries.map((entry) => entry.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(entries.find((entry) => entry.source === 'builtin')?.key).toMatch(/^builtin:/);
    expect(entries.find((entry) => entry.source === 'user')?.key).toBe('user:Templates/甲.nboard');
  });

  it('交回动作层的是 ref（id / 路径），不是带前缀的 key', () => {
    const groups = catalog({ users: [userTemplate('Templates/甲.nboard', '甲')] });
    const entries = groups.flatMap((group) => group.entries);

    const builtin = entries.find((entry) => entry.source === 'builtin')!;
    expect(builtin.ref).toBe(builtin.key.slice('builtin:'.length));

    const user = entries.find((entry) => entry.source === 'user')!;
    expect(user.ref).toBe('Templates/甲.nboard');
  });

  it('每格都有非空的标题与副标题（空白的一格在网格里就是一个洞）', () => {
    const groups = catalog({ users: [userTemplate('Templates/甲.nboard', '甲', 5, 2)] });

    for (const entry of groups.flatMap((group) => group.entries)) {
      expect(entry.title.trim().length).toBeGreaterThan(0);
      expect(entry.detail.trim().length).toBeGreaterThan(0);
    }
  });

  it('用户模板的副标题是"N 张卡片 · M 个分栏"', () => {
    const groups = catalog({ users: [userTemplate('Templates/甲.nboard', '甲', 5, 2)] });
    const user = groups.find((group) => group.key === 'user')!.entries[0];

    expect(user.detail).toBe(t('modal.template.summary', { cards: '5', columns: '2' }));
  });

  it('★ 带脑图的模板 ⇒ 副标题多一段"K 棵脑图"（不带则一个字不加）', () => {
    const groups = catalog({ users: [userTemplate('Templates/乙.nboard', '乙', 4, 1, 2)] });
    const user = groups.find((group) => group.key === 'user')!.entries[0];

    expect(user.detail).toBe(
      t('modal.template.summaryMinds', { cards: '4', columns: '1', minds: '2' }),
    );
  });
});
