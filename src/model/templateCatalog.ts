/**
 * 本地模板市场（`T6.09` / `F7-06`）的目录逻辑。
 *
 * ── 这里只做"分目录 + 过滤"，不做渲染 ──
 *
 * 市场之所以叫"市场"，是因为它有**目录**：内置模板按分类分组、用户模板自成一组；
 * 搜索框与分类切换只是在这张目录上做减法。这一层不碰 DOM、不读磁盘
 * （模板数据由调用方查好再传进来），于是整段逻辑能在 node 下单测 ——
 * "排出来好不好看"那部分留给 `ui/modals/TemplateModal.ts`。
 *
 * ★ **键（`key`）与显示名解耦**：内置模板的键是 `builtin:<id>`、用户模板是 `user:<路径>`。
 *   标题可以跟着语言变、用户也能改名，键不行 —— 它是渲染列表与去重的身份。
 *   选中时交回动作层的是 `ref`（内置 id / 用户路径），不是 `key` —— 别让 `key` 的前缀
 *   变成调用方要 `slice` 的隐式协议。
 *
 * ★ **用户模板不与内置模板挤在同一个分类里**：用户模板没有分类，硬塞进"研究"是瞎猜。
 *   单独一组"我的模板"，与旧选择器里"内置在前、用户在后"的直觉一致。
 *
 * ★ 过滤**同时**匹配名称、说明与路径：模板一多，光靠名字记不住，
 *   而"我放在 `研究/` 文件夹里的那份"往往才是用户真正的记忆方式。
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM，可在 node 下单测。
 */

import { t } from '../util/i18n';
import {
  TEMPLATE_CATEGORIES,
  type BuiltinTemplate,
  type TemplateCategory,
  type TemplateSummary,
} from './templates';

export type TemplateSource = 'builtin' | 'user';

/** 分组键：内置按分类，用户模板一律一组 */
export type CatalogGroupKey = TemplateCategory | 'user';

/** 分类筛选值：`'all'` = 不过滤 */
export type CatalogCategoryFilter = CatalogGroupKey | 'all';

/**
 * 用户模板在图里需要的全部字段。
 *
 * 刻意只声明**结构化最小形状**（与 `io/templateLibrary.ts` 的 `UserTemplate` 同构），
 * 让 `model/` 不必反向 import `io/` —— 层与层的方向不能因为一个列表类型就翻过来。
 */
export interface CatalogUserTemplate {
  path: string;
  title: string;
  summary: TemplateSummary;
}

/** 画廊里的一格 */
export interface CatalogEntry {
  /** 稳定键：`builtin:<id>` / `user:<路径>`。DOM 用它做 `data-key` 与去重 */
  key: string;
  source: TemplateSource;
  /** 源对象标识：内置模板 id / 用户模板路径 —— 选中时原样交回动作层 */
  ref: string;
  title: string;
  /** 第二行：内置是说明，用户是"N 张卡片 · M 个分栏" */
  detail: string;
  /** 内置模板恒有分类；用户模板为 `null`（它归"我的模板"那一组） */
  category: TemplateCategory | null;
  /** 过滤用的小写串（名称 + 说明 + 路径），预先存下来，免得每次按键重算 */
  haystack: string;
}

export interface CatalogGroup {
  key: CatalogGroupKey;
  entries: CatalogEntry[];
}

export interface CatalogInput {
  builtins: readonly BuiltinTemplate[];
  users: readonly CatalogUserTemplate[];
  /** 搜索词（大小写不敏感，空串 = 不过滤） */
  query: string;
  category: CatalogCategoryFilter;
}

/**
 * 把模板摊平成一份**分好组、过滤过**的目录。
 *
 * 组顺序固定为「分类声明顺序 → 我的模板」，空组会被丢掉：一个标题下面空着
 * 比不放这个标题更糟（用户会以为加载失败）。
 */
export function buildTemplateCatalog(input: CatalogInput): CatalogGroup[] {
  const needle = input.query.trim().toLowerCase();

  const groups: CatalogGroup[] = TEMPLATE_CATEGORIES.map((category) => ({
    key: category,
    entries: input.builtins.filter((template) => template.category === category).map(builtinEntry),
  }));
  groups.push({ key: 'user', entries: input.users.map(userEntry) });

  return groups
    .filter((group) => input.category === 'all' || group.key === input.category)
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) => matches(entry, needle)),
    }))
    .filter((group) => group.entries.length > 0);
}

/** 目录里的总格数（测试与"一份都没有"的判断都用它，省得各处再 `flat()` 一次） */
export function catalogSize(groups: readonly CatalogGroup[]): number {
  return groups.reduce((total, group) => total + group.entries.length, 0);
}

function builtinEntry(template: BuiltinTemplate): CatalogEntry {
  const title = t(template.nameKey);
  const detail = t(template.descKey);
  return {
    key: `builtin:${template.id}`,
    source: 'builtin',
    ref: template.id,
    title,
    detail,
    category: template.category,
    haystack: `${title} ${detail}`.toLowerCase(),
  };
}

function userEntry(template: CatalogUserTemplate): CatalogEntry {
  return {
    key: `user:${template.path}`,
    source: 'user',
    ref: template.path,
    title: template.title,
    // 有脑图才多那一段（`2.2.0` 收尾）：绝大多数模板一棵都没有，
    // 让每一行都拖着"0 棵脑图"只是噪音
    detail:
      template.summary.minds > 0
        ? t('modal.template.summaryMinds', {
            cards: String(template.summary.cards),
            columns: String(template.summary.columns),
            minds: String(template.summary.minds),
          })
        : t('modal.template.summary', {
            cards: String(template.summary.cards),
            columns: String(template.summary.columns),
          }),
    category: null,
    // 带上路径：不同文件夹里各有一份同名模板是常态，标题分不开它们
    haystack: `${template.title} ${template.path}`.toLowerCase(),
  };
}

function matches(entry: CatalogEntry, needle: string): boolean {
  return needle.length === 0 || entry.haystack.includes(needle);
}
