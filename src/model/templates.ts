/**
 * 模板库的模型层（`T4.14` / `F7-06`）。
 *
 * ── 模板是什么 ──
 *
 * **一份"预制"的板文件**。内置的 4 个（研究 / 排期 / 情绪板 / 写作）由本文件的
 * `build*` 用 `createBoardFile` / `createCard` / `createColumn` / `createEdge` **搭**出来 ——
 * 不是内嵌一段 JSON 字面量。这样三种好处是白拿的：类型检查盯着它（改字段名编译期就报）、
 * 新建卡片时的默认值不会被抄漏（`createCard` 是唯一的默认值来源）、
 * 也不会出现"模板里躺着一个 schema 早就删掉的键"。
 *
 * 用户自己的模板（「另存为模板」写出来的）则是**库里的 `.nboard` 文件**，
 * 见 `io/templateLibrary.ts` —— 两种模板在"用"这一步完全同路（都走 `instantiateTemplate`），
 * 区别只在**从哪来**。
 *
 * ── 实例化时到底改了什么 ──
 *
 * `instantiateTemplate()` 把模板变成一块**新板**，只改"属于上一块板"的东西：
 *
 * * **所有 id 重新生成**（板 / 卡 / 栏 / **脑图** / 连线 / 编组），并同步重写引用它们的字段
 *   （`card.columnId`、`edge.from/to.cardId`、`group.cardIds`）。★ 端点的重映射要认
 *   **三种**对象（卡 / 栏 / 脑图，见 `EdgeEndpoint.cardId` 的说明）—— 只认卡片的话，
 *   指向栏或树的连线会被当成"指向不存在的卡片"**静默丢掉**（`2.2.0` 收尾修）。
 *   不重写引用就等于把整块板的连线与归属一起打断 —— 这是本文件最容易错的一处，
 *   所以引用重写集中在 `instantiateTemplate` 里做，别处不许再抄一遍。
 * * **落回原点**（`view` 回到 `{0,0,1}`）：模板作者的视口对使用者没有意义，
 *   从别的白板存出来的模板甚至可能停在一块空白处。内容本身都摆在原点附近。
 * * **`readOnly` 一律清掉**：从一块锁定的板存出来的模板，不该造出一块锁定的新板 ——
 *   那会让用户"新建完就打不开"。
 * * **`aliases` 清空、`parent` 归位**：别名是"这一块板"的身份，父子关系属于库里的位置。
 *
 * 三者**刻意保留**：`view.background`（模板的样子是模板的一部分）、
 * `settings` 的其余字段（网格吸附之类是模板作者调好的）、
 * `presentStep`（**卡与脑图都是**：模板自带的演示路径就是新板的脚本 —— 这一点与
 * `transfer.ts` 的"粘贴时清掉步骤号"**不同**，那边是往**已有**脚本里塞外来的卡，
 * 这里是一块全新的板）。
 *
 * ★ 纯逻辑：不 import `obsidian`、不碰 DOM，可在 node 下单测。
 */

import { ID_PREFIX } from '../constants';
import { createId } from '../util/id';
import { t, type MessageKey } from '../util/i18n';
import { growColumnToFit, relayoutColumns } from './columns';
import {
  createBoardFile,
  createCard,
  createColumn,
  createEdge,
  createMind,
  type CardOverrides,
} from './factories';
import { cloneJson } from './ops';
import { createMindFile } from '../mind/model/factories';
import type { BoardFile, Card, Column, Edge, Group, Mind } from './schema';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/** 模板分类。四个分类 = 四个内置模板，也是模板市场（`T6.09`）的目录分组 */
export type TemplateCategory = 'research' | 'schedule' | 'moodboard' | 'writing';

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  'research',
  'schedule',
  'moodboard',
  'writing',
];

/** 列表里那行"N 张卡片 · M 个分栏 · K 棵脑图"用的数字 */
export interface TemplateSummary {
  cards: number;
  columns: number;
  edges: number;
  /**
   * 脑图（白板级，`2.2.0` 收尾 · 模板对接）。
   *
   * ★ 单独一格而不是并进 `cards`：两者在模板里是**不同**的东西（树是一棵树、
   *   卡片是一张纸），列表那行要按份数说清"这份模板里有什么"。
   */
  minds: number;
}

export interface BuiltinTemplate {
  /** 稳定标识：与显示名解耦（报告、日志、将来的模板市场都用它，改名不影响它） */
  readonly id: string;
  readonly category: TemplateCategory;
  readonly nameKey: MessageKey;
  readonly descKey: MessageKey;
  /** 每次调用都返回**一份全新**的板（连 id 都是新的），可以随便改出来那一份 */
  build(): BoardFile;
}

// ─────────────────────────────────────────────────────────────
// 搭模板用的小工具
// ─────────────────────────────────────────────────────────────

/**
 * 便签卡：模板里最常用的一格 —— 标题 + 一段 markdown。
 *
 * ★ 模板的正文是**用户能看见的字**，所以和界面文案一样走 i18n：
 *   英文环境下新建出来的板不该是一堆中文提示。
 */
function noteCard(
  titleKey: MessageKey,
  mdKey: MessageKey,
  overrides: CardOverrides<'note'> = {},
): Card {
  return createCard('note', {
    showTitle: true,
    title: t(titleKey),
    color: '1',
    content: { md: t(mdKey) },
    ...overrides,
  });
}

/** 待办卡：标题在 `content.title` 上（todo 卡不读 `card.title`），条目留给用户自己加 */
function todoCard(titleKey: MessageKey, overrides: CardOverrides<'todo'> = {}): Card {
  return createCard('todo', {
    content: { title: t(titleKey), items: [] },
    ...overrides,
  });
}

/** 引用卡：一个"把要用的笔记拉进来"的空位（空态文案本身就是在说怎么用） */
function noteRefCard(titleKey: MessageKey, overrides: CardOverrides<'noteRef'> = {}): Card {
  return createCard('noteRef', {
    showTitle: true,
    title: t(titleKey),
    ...overrides,
  });
}

/** 色板卡：预置一组色，双击就能改（空色板看着像坏了） */
function swatchCard(
  title: MessageKey,
  colors: readonly string[],
  overrides: CardOverrides<'swatch'> = {},
): Card {
  return createCard('swatch', {
    showTitle: true,
    title: t(title),
    content: { colors: [...colors] },
    ...overrides,
  });
}

/**
 * 给一块模板的 z 排个序：分栏按顺序在下（`1..n`），卡片与脑图排在其上（`10` 起）。
 *
 * ★ 成员卡片的 z 必须**高于**它所在的分栏，否则卡会被分栏的底板盖住
 *   （`columns.ts` 开头那三条约定里的第 2 条）。这里统一排一次，
 *   比在每个 `createCard` 上手写 `z` 靠谱 —— 手写迟早会漏一张。
 * ★ 脑图（`2.2.0` 收尾）与卡片**同层**、排在卡片之后：树也是一块"内容"，
 *   同样必须在分栏底板之上。
 */
function assignZ(columns: Column[], cards: Card[], minds: Mind[] = []): void {
  columns.forEach((column, index) => {
    column.z = index + 1;
  });
  cards.forEach((card, index) => {
    card.z = 10 + index;
  });
  minds.forEach((mind, index) => {
    mind.z = 10 + cards.length + index;
  });
}

/** 三个内置模板共用的列宽 / 列高基线（数值都是 16 的倍数，吸附网格之后不会变位置） */
const COLUMN_W = 320;
const COLUMN_H = 420;
/** 同级分栏的水平间距（与 `COLUMN_LAYOUT.siblingGap` 同值，但模板只在**生成时**用一次） */
const COLUMN_GAP = 24;
/** 说明卡所在的高度：内容正文从 y=0 开始，说明卡浮在上面 */
const HOWTO_Y = -288;

// ─────────────────────────────────────────────────────────────
// 内置模板 1：桌面研究
// ─────────────────────────────────────────────────────────────

function buildResearch(): BoardFile {
  const colQuestion = createColumn({
    title: t('template.research.colA'),
    x: 0,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });
  const colSources = createColumn({
    title: t('template.research.colB'),
    x: COLUMN_W + COLUMN_GAP,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });
  const colInsight = createColumn({
    title: t('template.research.colC'),
    x: (COLUMN_W + COLUMN_GAP) * 2,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });

  const howto = noteCard('template.research.howto.title', 'template.research.howto.md', {
    x: 0,
    y: HOWTO_Y,
    width: (COLUMN_W + COLUMN_GAP) * 2 + COLUMN_W,
    height: 176,
  });
  const question = noteCard('template.research.q.title', 'template.research.q.md', {
    columnId: colQuestion.id,
    order: 0,
    height: 200,
    color: '4',
  });
  const hypothesis = noteCard('template.research.hypo.title', 'template.research.hypo.md', {
    columnId: colQuestion.id,
    order: 1,
    height: 200,
  });
  const reference = noteRefCard('template.research.ref.title', {
    columnId: colSources.id,
    order: 0,
    height: 168,
  });
  const sources = noteCard('template.research.src.title', 'template.research.src.md', {
    columnId: colSources.id,
    order: 1,
    height: 200,
  });
  const insight = noteCard('template.research.insight.title', 'template.research.insight.md', {
    columnId: colInsight.id,
    order: 0,
    height: 208,
  });
  const conclusion = noteCard('template.research.concl.title', 'template.research.concl.md', {
    columnId: colInsight.id,
    order: 1,
    height: 224,
    color: '5',
  });

  // ★ 一棵"研究问题树"（`2.2.0` 收尾 · 模板对接）：放在三栏**下方**。
  //   为什么内置模板里要真的有树：模板能带脑图这件事，用户不自己存一份模板
  //   就**看不见** —— 用「研究」新建一块板就有一棵树等着写，能力才算是"接上了"。
  const questionTree = createMind({
    x: 0,
    y: COLUMN_H + 48,
    // ★ 根节点的文字要**显式给**（`rootText`）：`createMindFile` 的默认值是通用的
    //   「中心主题」，而模板里这棵树该叫「研究问题」（`2.2.0` 收尾那一批改的默认值）
    mind: createMindFile({
      branches: 3,
      title: t('template.research.mind.root'),
      rootText: t('template.research.mind.root'),
    }),
  });

  const columns = [colQuestion, colSources, colInsight];
  const cards = [howto, question, hypothesis, reference, sources, insight, conclusion];
  assignZ(columns, cards, [questionTree]);

  return createBoardFile({
    meta: { title: t('template.research.name') },
    view: { background: 'dots' },
    columns,
    cards,
    minds: [questionTree],
    // 一条连线说清"结论要回答的是最上面那个问题" —— 模板里只放**有语义**的连线，
    // 不是拿来演示连线功能的
    edges: [createEdge({ cardId: question.id, side: null }, { cardId: conclusion.id, side: null })],
  });
}

// ─────────────────────────────────────────────────────────────
// 内置模板 2：每周排期
// ─────────────────────────────────────────────────────────────

function buildSchedule(): BoardFile {
  const colTodo = createColumn({
    title: t('template.schedule.colA'),
    x: 0,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });
  const colDoing = createColumn({
    title: t('template.schedule.colB'),
    x: COLUMN_W + COLUMN_GAP,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });
  const colDone = createColumn({
    title: t('template.schedule.colC'),
    x: (COLUMN_W + COLUMN_GAP) * 2,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });

  const howto = noteCard('template.schedule.howto.title', 'template.schedule.howto.md', {
    x: 0,
    y: HOWTO_Y,
    width: (COLUMN_W + COLUMN_GAP) * 2 + COLUMN_W,
    height: 176,
  });
  const todo = todoCard('template.schedule.todo', { columnId: colTodo.id, order: 0, height: 260 });
  const ask = noteCard('template.schedule.ask.title', 'template.schedule.ask.md', {
    columnId: colTodo.id,
    order: 1,
    height: 184,
  });
  const doing = todoCard('template.schedule.doing', {
    columnId: colDoing.id,
    order: 0,
    height: 260,
    color: '4',
  });
  const wip = noteCard('template.schedule.wip.title', 'template.schedule.wip.md', {
    columnId: colDoing.id,
    order: 1,
    height: 184,
  });
  const done = todoCard('template.schedule.done', { columnId: colDone.id, order: 0, height: 260 });
  const review = noteCard('template.schedule.review.title', 'template.schedule.review.md', {
    columnId: colDone.id,
    order: 1,
    height: 200,
  });

  const columns = [colTodo, colDoing, colDone];
  const cards = [howto, todo, ask, doing, wip, done, review];
  assignZ(columns, cards);

  return createBoardFile({
    meta: { title: t('template.schedule.name') },
    view: { background: 'grid' },
    columns,
    cards,
    edges: [createEdge({ cardId: todo.id, side: null }, { cardId: doing.id, side: null })],
  });
}

// ─────────────────────────────────────────────────────────────
// 内置模板 3：情绪板（不摆分栏 —— 情绪板本来就是散着摆的）
// ─────────────────────────────────────────────────────────────

function buildMoodboard(): BoardFile {
  const howto = noteCard('template.moodboard.howto.title', 'template.moodboard.howto.md', {
    x: 0,
    y: 0,
    width: 560,
    height: 176,
  });
  const primary = swatchCard(
    'template.moodboard.primary.title',
    ['#0B3D91', '#2A5BD7', '#4C8DFF', '#9DBBFF', '#E7EEFF'],
    { x: 0, y: 208 },
  );
  const accent = swatchCard('template.moodboard.accent.title', ['#FF6B5A', '#F5B544', '#2BB3A3'], {
    x: 272,
    y: 208,
  });

  const vibe = noteCard('template.moodboard.vibe.title', 'template.moodboard.vibe.md', {
    x: 544,
    y: 208,
    width: 280,
    height: 160,
    color: '4',
  });
  const refs = noteCard('template.moodboard.refs.title', 'template.moodboard.refs.md', {
    x: 0,
    y: 400,
    width: 280,
    height: 200,
  });
  const style = noteRefCard('template.moodboard.style.title', {
    x: 312,
    y: 400,
    width: 280,
    height: 168,
  });

  const cards = [howto, primary, accent, vibe, refs, style];
  assignZ([], cards);

  return createBoardFile({
    meta: { title: t('template.moodboard.name') },
    // 情绪板要的是"随便摆"：整块板默认**不吸附网格**，背景也留干净
    view: { background: 'none' },
    settings: { snapToGrid: false },
    cards,
  });
}

// ─────────────────────────────────────────────────────────────
// 内置模板 4：长文骨架
// ─────────────────────────────────────────────────────────────

function buildWriting(): BoardFile {
  const colMaterial = createColumn({
    title: t('template.writing.colA'),
    x: 0,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });
  const colStructure = createColumn({
    title: t('template.writing.colB'),
    x: COLUMN_W + COLUMN_GAP,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });
  const colDraft = createColumn({
    title: t('template.writing.colC'),
    x: (COLUMN_W + COLUMN_GAP) * 2,
    y: 0,
    width: COLUMN_W,
    height: COLUMN_H,
  });

  const howto = noteCard('template.writing.howto.title', 'template.writing.howto.md', {
    x: 0,
    y: HOWTO_Y,
    width: (COLUMN_W + COLUMN_GAP) * 2 + COLUMN_W,
    height: 176,
  });
  const material = noteCard('template.writing.material.title', 'template.writing.material.md', {
    columnId: colMaterial.id,
    order: 0,
    height: 240,
  });
  const refs = noteRefCard('template.writing.refs.title', {
    columnId: colMaterial.id,
    order: 1,
    height: 168,
  });
  const spine = noteCard('template.writing.spine.title', 'template.writing.spine.md', {
    columnId: colStructure.id,
    order: 0,
    height: 200,
    color: '4',
  });
  const outline = noteCard('template.writing.outline.title', 'template.writing.outline.md', {
    columnId: colStructure.id,
    order: 1,
    height: 200,
  });
  const opening = noteCard('template.writing.open.title', 'template.writing.open.md', {
    columnId: colDraft.id,
    order: 0,
    height: 200,
  });
  const closing = noteCard('template.writing.close.title', 'template.writing.close.md', {
    columnId: colDraft.id,
    order: 1,
    height: 184,
  });

  const columns = [colMaterial, colStructure, colDraft];
  const cards = [howto, material, refs, spine, outline, opening, closing];
  assignZ(columns, cards);

  return createBoardFile({
    meta: { title: t('template.writing.name') },
    view: { background: 'plain' },
    columns,
    cards,
    edges: [createEdge({ cardId: spine.id, side: null }, { cardId: opening.id, side: null })],
  });
}

// ─────────────────────────────────────────────────────────────
// 内置模板表
// ─────────────────────────────────────────────────────────────

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    id: 'research',
    category: 'research',
    nameKey: 'template.research.name',
    descKey: 'template.research.desc',
    build: buildResearch,
  },
  {
    id: 'schedule',
    category: 'schedule',
    nameKey: 'template.schedule.name',
    descKey: 'template.schedule.desc',
    build: buildSchedule,
  },
  {
    id: 'moodboard',
    category: 'moodboard',
    nameKey: 'template.moodboard.name',
    descKey: 'template.moodboard.desc',
    build: buildMoodboard,
  },
  {
    id: 'writing',
    category: 'writing',
    nameKey: 'template.writing.name',
    descKey: 'template.writing.desc',
    build: buildWriting,
  },
];

/** 按 id 取内置模板（找不到返回 `null`，不抛） */
export function builtinTemplateById(id: string): BuiltinTemplate | null {
  return BUILTIN_TEMPLATES.find((template) => template.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────
// 实例化 / 描述
// ─────────────────────────────────────────────────────────────

export interface TemplateInstanceOptions {
  /** 新板的标题。省略时沿用模板自己的标题 */
  title?: string;
  /** 新板的父白板（顶级板传 `null`） */
  parent?: string | null;
}

/** 把模板里的一个端点搬到新板的卡片上；指向不存在的卡片时返回 `null`（整条连线丢掉） */
function remapEndpoint(
  endpoint: Edge['from'],
  objectIds: ReadonlyMap<string, string>,
): Edge['from'] | null {
  // 自由端（`cardId` 为空）原样带走：它不指向任何对象，也就无所谓存在不存在
  if (endpoint.cardId.length === 0) return cloneJson(endpoint);
  // 表里查不到 = 指向一个**这次没有一起搬走**的对象（认不出的旧 id）⇒ 这条线丢掉
  const mapped = objectIds.get(endpoint.cardId);
  if (mapped === undefined) return null;
  return { ...cloneJson(endpoint), cardId: mapped };
}

/**
 * 用模板造一块**新板**。
 *
 * @returns 全新的一份 `BoardFile`（与 `source` 不共享任何对象，改它不会碰到模板）
 *
 * ★ 出来的板已经**排好版**（`relayoutColumns` + `growColumnToFit`）：
 *   栏内卡片的位置是派生的，不排的话用户打开会看见卡片还停在模板作者摆的旧位置上 ——
 *   而 `commit()` 只在**有编辑**时才兜这一刀，新建出来的板在第一次编辑之前就得是对的。
 */
export function instantiateTemplate(
  source: BoardFile,
  options: TemplateInstanceOptions = {},
): BoardFile {
  const now = new Date().toISOString();

  const columnIds = new Map<string, string>();
  const columns = source.columns.map((column) => {
    const id = createId(ID_PREFIX.column);
    columnIds.set(column.id, id);
    return { ...cloneJson(column), id };
  });

  const cardIds = new Map<string, string>();
  const cards = source.cards.map((card) => {
    const id = createId(ID_PREFIX.card);
    cardIds.set(card.id, id);
    const columnId = card.columnId ? (columnIds.get(card.columnId) ?? null) : null;
    return { ...cloneJson(card), id, columnId };
  });

  // 脑图（`2.2.0` 收尾 · 模板对接）：容器 id 与板/卡/栏一样要换新。
  // ★ 里面的 `mind`（`MindFile`）**不洗**：它的节点 id 只在那一份脑图里唯一，
  //   随容器一起搬走即可（与"卡片的内容不洗"同一条）。
  const mindIds = new Map<string, string>();
  const minds: Mind[] = (source.minds ?? []).map((mind) => {
    const id = createId(ID_PREFIX.mind);
    mindIds.set(mind.id, id);
    return { ...cloneJson(mind), id };
  });

  // ★ 端点重映射必须吃**合并后的对象表**：连线可以连到卡片、分栏（`O21`）或脑图
  //   （`2.2.0`，还可能是树里的某个节点 —— `nodeId` 不动，它是脑图**内部**的键）。
  //   只用卡片表的话，指向分栏 / 脑图的连线会被 `remapEndpoint` 判成"指向不存在的卡片"
  //   而**静默丢掉** —— 模板一旦带这类连线，用户用出来的板就少了几条线。
  const objectIds = new Map<string, string>([...columnIds, ...cardIds, ...mindIds]);

  const edges = source.edges
    .map((edge) => {
      const from = remapEndpoint(edge.from, objectIds);
      const to = remapEndpoint(edge.to, objectIds);
      if (!from || !to) return null;
      return { ...cloneJson(edge), id: createId(ID_PREFIX.edge), from, to };
    })
    .filter((edge): edge is Edge => edge !== null);

  const groups = source.groups
    .map((group) => {
      const members = group.cardIds
        .map((id) => cardIds.get(id))
        .filter((id): id is string => typeof id === 'string');
      if (members.length === 0) return null;
      return { ...cloneJson(group), id: createId(ID_PREFIX.group), cardIds: members };
    })
    .filter((group): group is Group => group !== null);

  const board = createBoardFile({
    meta: {
      title: options.title ?? source.meta.title,
      icon: source.meta.icon,
      createdAt: now,
      updatedAt: now,
      parent: options.parent ?? null,
      tags: [...source.meta.tags],
      // 别名是"这一块板"的身份，跟模板无关
      aliases: [],
    },
    view: {
      // 落回原点：模板作者的视口对使用者没有意义
      x: 0,
      y: 0,
      zoom: 1,
      background: source.view.background,
    },
    settings: { ...source.settings, readOnly: false },
    columns,
    cards,
    // 一棵树都没有时**不写这个键**（缺席 = 没有脑图，与 `validate` / `createBoardFile` 同一纪律）
    ...(minds.length > 0 ? { minds } : {}),
    edges,
    groups,
  });

  relayoutColumns(board);
  for (const column of board.columns) growColumnToFit(board, column.id);
  return board;
}

/** 列表里那行数字：有多少卡片 / 分栏 / 连线 */
export function describeTemplate(board: BoardFile): TemplateSummary {
  return {
    cards: board.cards.length,
    columns: board.columns.length,
    edges: board.edges.length,
    minds: (board.minds ?? []).length,
  };
}

/**
 * 把一块**正在用的板**打包成一份"模板文件"的内容（「另存为模板」写出去的就是它）。
 *
 * 与 `instantiateTemplate` 是**反方向**的两件事，各自只碰自己那一头：
 * 这里决定"文件长什么样"，那边决定"用出来的一块新板长什么样"。
 *
 * * **换掉 `meta.id`**：模板不是原来那块板，它得能独立存在（也应该有自己的快照 / 引用身份）。
 * * **`parent` 归空**：库里那个"它在谁下面"的位置不属于模板。
 * * **`view` 落回原点**：见文件头注释 —— 模板作者当时的视口对使用者没有意义。
 * * **`readOnly` 清掉**：从一块锁定的板存出来的模板，不该造出一块锁定的新板。
 * * **卡片 / 分栏的 id 保持原样**：这份文件只是"拿来用"的，用的时候 `instantiateTemplate`
 *   会把它们全部换掉；在文件里先把 id 洗一遍只会让 diff 更难读。
 */
export function packTemplate(source: BoardFile, title: string): BoardFile {
  const now = new Date().toISOString();
  return {
    ...cloneJson(source),
    revision: 0,
    meta: {
      ...cloneJson(source.meta),
      id: createId(ID_PREFIX.board),
      title,
      createdAt: now,
      updatedAt: now,
      parent: null,
      aliases: [],
    },
    view: { ...source.view, x: 0, y: 0, zoom: 1 },
    settings: { ...source.settings, readOnly: false },
  };
}
