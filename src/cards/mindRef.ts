/**
 * 脑图卡（`F3a`，用户 2026-09-21）：**把一份 `.nestmind` 拖进白板，卡面上直接编辑它。**
 *
 * ── 它不是什么 ───────────────────────────────────────────────
 *
 * 不是"缩略图 / 摘要 / 全文"那种四档预览（用户明确否掉了）：拖进来就是**脑图组件本身** ——
 * 卡面上能点、能改、能折叠，改的**就是那份文件**。
 *
 * | 手势 | 结果 |
 * |---|---|
 * | 单击节点 | 卡内选中（只影响卡里的高亮） |
 * | 双击节点 | 就地改标题 → 写回 `.nestmind` |
 * | 点节点旁的圆圈 | 折叠 / 展开这一支 → 写回 |
 * | 右键节点 | 菜单由视图画（加子节点 / 加同级 / 删除 / 改标题…） |
 * | 从**根节点**上按住拖 | **拖整张卡**（`F3b`：那一片区域不吃手势，直接冒泡给白板） |
 * | 双击卡的空白处 | 在新标签打开这份脑图 |
 *
 * ── 只画前 3 层 ──────────────────────────────────────────────
 *
 * 卡面比屏幕小得多，整棵树塞进来只会糊成一片：`EmbedMind` 只画前
 * `EMBED_MAX_DEPTH` 层，更深的收成 `+N` 角标（`mind/embed/pruneTree.ts`）。
 *
 * ── 异步读 + 元素复用 ────────────────────────────────────────
 *
 * `render` 是同步的、读文件是异步的 ⇒ 与引用卡 / `.canvas` 卡同一套：
 * ① 每个内容槽一个自增 token（读完先对 token，对不上就丢掉 —— 元素可能已经换主）；
 * ② 拿到模型后再挂 `EmbedMind`，并订上这份脑图的 `changed`（外部编辑 / 我们的写入
 *   都会来），重画时**只换模型**（重画与重新读盘分开：读盘会再跑一遍规范化）。
 */

import type { CardOfType, MindRefContent } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import { takeMindEdit } from '../mind/embed/editRequest';
import { EmbedMind } from '../mind/view/EmbedMind';
import type { MindFile } from '../mind/model/schema';
import type { CardRenderContext, CardTypeDefinition, CardTypeMenuItem } from './registry';

/** 默认尺寸：够画"根 + 2~3 层"（`EMBED_MAX_DEPTH` 那几层），再小就只能靠缩放了 */
export const MIND_REF_DEFAULT_SIZE: Size = { width: 440, height: 320 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须原样摘掉 */
const MIND_REF_CLASSES = [
  'nestboard-mind-ref',
  'nestboard-mind-ref-empty',
  'nestboard-mind-ref-message',
] as const;

/** 槽位 → 当前异步轮次号（同 `cards/noteRef.ts`：元素被复用时旧结果自动作废） */
const tokens = new WeakMap<HTMLElement, number>();
/** 槽位 → 这份脑图的退订函数 */
const watchers = new WeakMap<HTMLElement, () => void>();
/** 槽位 → 挂着的 `EmbedMind`（重画时只换模型，不重建它） */
const embeds = new WeakMap<HTMLElement, EmbedMind>();
/** 槽位 → 此刻画的是哪份文件（异步回来的结果要对得上） */
const sources = new WeakMap<HTMLElement, string>();

/**
 * `pendingEdits`（"加完节点就让我打字"）现在住在 `mind/embed/editRequest.ts` ——
 * 内嵌脑图卡（`F4`）要的是同一件事，只是键从**路径**换成**卡片 id**，共用一份最省。
 */

function beginToken(el: HTMLElement): number {
  const next = (tokens.get(el) ?? 0) + 1;
  tokens.set(el, next);
  return next;
}

function disposeSlot(el: HTMLElement): void {
  watchers.get(el)?.();
  watchers.delete(el);
  embeds.get(el)?.dispose();
  embeds.delete(el);
  sources.delete(el);
}

export const mindRefCard: CardTypeDefinition<'mindRef'> = {
  type: 'mindRef',

  get displayName(): string {
    return t('card.type.mindRef');
  },

  icon: 'network',
  defaultSize: MIND_REF_DEFAULT_SIZE,

  /**
   * 卡面全给那张脑图，所以**不显示标题栏**（与 `.canvas` 卡、PDF 卡同一条）。
   * 「编辑内容」也不给：卡上没有"一段可编辑的正文" —— 要改就去点节点。
   * 「收起 / 展开」同样不给：收起会把唯一的内容藏掉，只剩一张空壳（这张卡没有标题栏可看）。
   */
  menuItems: { editContent: false, showTitle: false, collapse: false },
  /**
   * **无框**（用户 2026-09-21）：与内嵌脑图卡同一条 —— "脑图是作为一个组件出现的，
   * 其实不用底下那个框"。卡片级的入口挂到**根节点**上（拖整张 / 选中 / 右键菜单）。
   * ★ 空态与"文件没了"那两种情况例外：它们只有一句话，无框之后就飘在板上，
   *   所以样式表给它们补了一条虚线占位框（`.nestboard-card.is-bare .nestboard-mind-ref-empty`）。
   */
  chrome: 'bare',

  createDefaultContent(): MindRefContent {
    return { path: '', showSize: false };
  },

  contextMenu(card, menuCtx): CardTypeMenuItem[] {
    const empty = card.content.path.length === 0;
    return [
      {
        id: 'open-mind',
        title: t('menu.card.openMind'),
        icon: 'external-link',
        // 「打开」与「编辑标题」同一条约定：多选时没有唯一目标
        disabled: menuCtx.multiple || empty,
        action: 'openSource',
      },
    ];
  },

  /** 双击卡片（**节点上那一下由 `EmbedMind` 自己收掉**）→ 在新标签打开这份脑图 */
  onDoubleClick(card, ctx): boolean {
    const path = card.content.path;
    if (path.length === 0 || !ctx.minds?.exists(path)) return false;
    ctx.minds.openTab(path);
    return true;
  },

  render(el, card, ctx): void {
    disposeSlot(el);
    el.classList.add('nestboard-mind-ref');
    el.classList.remove('nestboard-mind-ref-empty', 'nestboard-mind-ref-message');

    const path = card.content.path;
    if (path.length === 0) {
      el.classList.add('nestboard-mind-ref-empty');
      renderMessage(el, t('card.mindRef.empty'));
      return;
    }
    const minds = ctx.minds;
    if (!minds || !minds.exists(path)) {
      renderMessage(el, t('card.mindRef.missing'));
      return;
    }

    const token = beginToken(el);
    sources.set(el, path);
    renderMessage(el, '');
    void minds.open(path).then((mind) => {
      // 读回来时这张卡可能已经被换掉 / 被删（元素复用）⇒ 整个丢弃
      if (tokens.get(el) !== token || sources.get(el) !== path) return;
      if (!mind) {
        renderMessage(el, t('card.mindRef.broken'));
        return;
      }
      mountEmbed(el, mind, ctx, path, card.id);
      ctx.contentReady?.();
    });
  },

  destroy(el): void {
    disposeSlot(el);
    tokens.delete(el);
    el.classList.remove(...MIND_REF_CLASSES);
  },

  /** 导出成 Markdown 给一个链接：Obsidian 自己会用脑图视图打开它（这不是可嵌入的 `![[…]]`） */
  toMarkdown(card): string {
    return card.content.path.length > 0 ? `[[${card.content.path}]]` : '';
  },
};

/** 卡面上的那句话（空串 = 内容槽先空着，等模型读回来） */
function renderMessage(el: HTMLElement, text: string): void {
  el.textContent = '';
  if (text.length === 0) return;
  el.classList.add('nestboard-mind-ref-message');
  const box = el.ownerDocument.createElement('div');
  box.className = 'nestboard-mind-ref-note';
  box.textContent = text;
  el.append(box);
}

/**
 * 把 `EmbedMind` 挂上去，并订上这份脑图。
 *
 * ★ 订阅回调里重画时**只换模型**（`embed.update(minds.get(path))`），不重新 `open()`：
 *   写入是我们自己发起的，`open()` 会给回同一份内存模型；而"重新读盘"会让每次改一个字
 *   都跑一遍规范化。
 * ★ 订阅要挂在**内容槽**上、`destroy` 里退掉：卡片进复用池后索引还在广播，
 *   留着就是白跑（与引用卡的反链角标同一条纪律）。
 */
function mountEmbed(
  el: HTMLElement,
  mind: MindFile,
  ctx: CardRenderContext,
  path: string,
  cardId: string,
): void {
  const minds = ctx.minds;
  if (!minds) return;

  const embed = new EmbedMind({
    doc: el.ownerDocument,
    host: el,
    mind,
    // 白板只读 / 这份脑图处于保护态（解析失败）时：一个编辑手势都不接
    readOnly: Boolean(ctx.readOnly) || minds.isReadOnly(path),
    mutate: (mutator) => minds.mutate(path, mutator),
    // 根节点上右键也给节点菜单（`F4` 起的口径：卡片级入口挂到根节点上 —— 根节点那一份
    // 菜单里会并上"卡片级"那一套，而卡片菜单是**按卡**算的 ⇒ 这里得告诉视图是哪张卡）
    allowRootMenu: true,
    onNodeMenu: minds.nodeMenu
      ? (nodeId, event) =>
          // `editKey` = 那份文件：这张卡取"加完节点进编辑器"的请求就是按路径取的
          //（`takeMindEdit(path)`）—— 菜单那边必须用同一个键，否则请求没人取
          minds.nodeMenu?.({ path, nodeId, event, cardId, editKey: path })
      : undefined,
    // 点节点 → 视图那条**底部快捷操作栏**换成"这个节点"（`F4`，用户 2026-09-21）
    onSelect: minds.nodeFocus ? (nodeId) => minds.nodeFocus?.({ path, nodeId, cardId }) : undefined,
    resolveResource: (target) => ctx.notes?.resourceUrl(target) ?? null,
    refMissing: (target) => (ctx.notes ? !ctx.notes.exists(target) : false),
    // 内容块里的 Markdown：与脑图画布同一条（渲染器是异步的，这里吞掉它 —— 这一层是同步的）
    renderMarkdown: (markdown, host) => {
      void ctx.renderMarkdown(markdown, host).catch(() => undefined);
    },
    labels: {
      handle: (state) =>
        state.collapsed
          ? t('mind.handle.expand', { count: state.count })
          : t('mind.handle.collapse'),
      more: (count) => t('card.mindRef.more', { count }),
    },
    // 视图那侧刚加了一个节点 ⇒ 画完这一帧就进编辑器（键 = 这份脑图的路径）
    consumeEditRequest: () => takeMindEdit(path),
    // 装不下就请**卡片长大**，别把节点缩小（用户 2026-09-21）
    onRequiredSize: (size) => ctx.growTo?.(size),
  });
  embeds.set(el, embed);

  watchers.set(
    el,
    minds.watch(path, () => {
      if (sources.get(el) !== path) return;
      const next = minds.get(path);
      if (next) embed.update(next);
    }),
  );
}

/** 这张卡的路径（测试与"断链检查"都用得上；不从 `content` 现读是为了类型收窄） */
export function mindRefPathOf(card: CardOfType<'mindRef'>): string {
  return card.content.path;
}
