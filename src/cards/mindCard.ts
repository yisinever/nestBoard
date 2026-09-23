/**
 * 白板内建的**脑图卡**（`F4`，用户 2026-09-21："直接在白板内部建立的脑图……只是不指向
 * 具体某个文件，和脑图文件卡操作相同"）。
 *
 * ── 与脑图文件卡（`cards/mindRef.ts`，`F3a`）的关系 ──────────
 *
 * **同一套可编辑组件，只有数据源不同**：
 *
 * | | 数据在哪 | 怎么读 | 怎么写 |
 * |---|---|---|---|
 * | 文件卡 `mindRef` | 一份 `.nestmind` | `MindRepository.open(path)` | 仓储 `mutate`（原子写 + 冲突检测） |
 * | 内嵌卡 `mind`（本文件） | **这张卡的 `content.mind`** | 直接就是模型 | `ctx.updateContent`（**白板的撤销栈**） |
 *
 * 于是它天然两头都占便宜：不建文件、跟着 `.nboard` 一起走、改一次 = 白板撤销一步；
 * 代价是"这份脑图只活在这块板里"。想搬出去就用节点菜单里的**导出为 `.nestmind`**
 * （`BoardView.showMindNodeMenu`）。
 *
 * ── 它没有什么 ───────────────────────────────────────────────
 *
 * * **没有"整卡编辑态"**（`autoEditOnCreate: false`）：编辑发生在卡内那一层
 *   （点节点改名 / 右键加节点），与文件卡一模一样；
 * * 没有标题栏、没有「编辑内容」「收起」那三项（`menuItems`），理由同文件卡。
 *
 * ── 尺寸 ─────────────────────────────────────────────────────
 *
 * 新建时按内容算（`sizeForContent` → `mindCardSizeFor`，用户要的"尺寸随内容自适应"）；
 * 之后不再反复改用户摆好的尺寸 —— 内容长大了由卡内那层**整体缩放到装下**兜住
 * （见 `mind/view/EmbedMind.ts`）。
 */

import type { CardOfType, MindContent } from '../model/schema';
import { newMindContent } from '../model/factories';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import { requestMindEdit, takeMindEdit } from '../mind/embed/editRequest';
import { mindCardSizeFor, INLINE_MIND_FALLBACK_SIZE } from '../mind/embed/embedGeometry';
import type { MindInlineSource } from '../mind/embed/MindBridge';
import { mindToMarkdown } from '../mind/export/toMarkdown';
import type { MindFile } from '../mind/model/schema';
import { EmbedMind } from '../mind/view/EmbedMind';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 本定义往槽位元素上加的 class，`destroy()` 必须原样摘掉 */
const MIND_CARD_CLASSES = ['nestboard-mind-ref', 'nestboard-mind-card'] as const;

/**
 * 一个内容槽上挂着的东西：`EmbedMind` + **当前那一帧的卡片引用**。
 *
 * ★ 为什么卡片引用要跟着每帧刷新，而不是在 `buildEmbed` 里捕获一次：
 *   撤销 / 重做会把模型换成**历史快照里的新对象**（`restoreContent` 直接换掉
 *   `board.cards`）。捕获一次的话，闭包里那个 `card` 就停在"撤销之前"，
 *   之后再改一个节点会把**已经被撤掉的内容**又写回去。
 * ★ `embed` 只建一次（重画时只换模型）：重建会把卡内选中态与正在编辑的输入框一起扔掉。
 */
interface MindCardSlot {
  cardId: string;
  card: CardOfType<'mind'>;
  embed: EmbedMind;
}

/** 槽位 → 这一份挂载状态 */
const slots = new WeakMap<HTMLElement, MindCardSlot>();

export const mindCard: CardTypeDefinition<'mind'> = {
  type: 'mind',

  get displayName(): string {
    return t('card.type.mind');
  },

  icon: 'network',
  // 兜底尺寸（真正的新建尺寸由 `sizeForContent` 按内容算，见文件头）
  defaultSize: INLINE_MIND_FALLBACK_SIZE,
  // 不走白板那套"整卡编辑态"：编辑发生在卡内（`BoardView.createCardAt` 会改成
  // "把光标送进中心主题"，见那里新建分支的注释）
  autoEditOnCreate: false,
  menuItems: { editContent: false, showTitle: false, collapse: false },
  /**
   * **无框**（用户 2026-09-21："脑图是作为一个组件出现的，其实不用底下那个框"）。
   *
   * ★ 卡片级的那些入口（拖整张、选中、右键菜单）没丢，只是**挂到了根节点上** ——
   *   同一天定的口径：拖根节点 = 拖整张脑图（`pointerdown` 从根上冒泡给卡片层），
   *   根节点右键 = 节点菜单 + 卡片菜单（`BoardView.showMindNodeMenu`）。
   */
  chrome: 'bare',

  createDefaultContent(): MindContent {
    // ★ 走工厂、不在这里手搓：初始形态（中心主题 + 3 个分支）由 `newMindContent` 一处说了算
    return newMindContent();
  },

  /** 新建时按内容算尺寸（"尺寸随内容自适应"，`F4`） */
  sizeForContent(content): Size {
    return mindCardSizeFor(content.mind);
  },

  render(el, card, ctx): void {
    el.classList.add('nestboard-mind-ref', 'nestboard-mind-card');
    const existing = slots.get(el);
    if (existing && existing.cardId === card.id) {
      // ★ 先换引用再重画（见 `MindCardSlot` 那条：撤销回来的是另一批对象）
      existing.card = card;
      // ★★ 必须把那棵 DOM **放回去**：卡片层每次重画内容槽都先 `content.textContent = ''`
      //    （`CardLayer.renderContent`），我们那些构件（世界 / 连线层 / 节点层）被摘下来了 ——
      //    只 `update()` 不挂回去的话，重画出来的东西全落在**不在文档里的**元素上，
      //    用户看到的就是"一改节点，整张卡空了"（`F4` 手工验收报的第一个 bug）。
      attachEmbed(el, existing.embed);
      existing.embed.update(card.content.mind);
      return;
    }
    // 同一个槽位上换了另一张卡（复用池）：上一份必须解绑，而且**要把它的那棵 DOM 摘掉** ——
    // 只 `dispose()` 的话它还在槽里杵着，新那份一挂就叠成两张图
    if (existing) {
      existing.embed.element.remove();
      existing.embed.dispose();
      slots.delete(el);
    }
    const slot: MindCardSlot = { cardId: card.id, card, embed: null as unknown as EmbedMind };
    slot.embed = buildEmbed(el, slot, ctx);
    slots.set(el, slot);
    attachEmbed(el, slot.embed);
  },

  destroy(el): void {
    const slot = slots.get(el);
    if (slot) {
      // 连 DOM 一起摘掉：回收池里的槽位要**干净**（只 `dispose()` 的话那棵图还挂在上面，
      // 下一位租客一渲染就叠成两张）
      slot.embed.element.remove();
      slot.embed.dispose();
      slots.delete(el);
    }
    el.classList.remove(...MIND_CARD_CLASSES);
  },

  /** 导出成 Markdown：那就是这份脑图的大纲（不带 `# 文档标题`，它只是板里的一张卡） */
  toMarkdown(card): string {
    return mindToMarkdown(card.content.mind, { includeTitle: false });
  },
};

/**
 * 把嵌图的根元素放回内容槽 —— 已经在里面就什么都不做。
 *
 * ★ 为什么需要这一步：卡片层每次重画内容槽都先清空它（`CardLayer.renderContent`
 *   的 `content.textContent = ''`，指纹一变就走这条路）。被清掉的是**宿主里的引用**，
 *   `EmbedMind` 自己那些构件（世界 / 连线层 / 节点层）还在内存里好好的 ——
 *   所以这里只把根元素挂回去，然后照常 `update()` 换模型（不重建，卡内选中态与
 *   正在编辑的输入框都保住）。
 */
function attachEmbed(el: HTMLElement, embed: EmbedMind): void {
  const root = embed.element;
  if (root.parentElement !== el) el.appendChild(root);
}

function buildEmbed(el: HTMLElement, slot: MindCardSlot, ctx: CardRenderContext): EmbedMind {
  const source: MindInlineSource = {
    // 卡片 id 在槽位建立时就定了（同一个槽位上换卡会重建，见 `render`）—— 捕获一份就够
    cardId: slot.card.id,
    read: () => slot.card.content.mind,
    mutate: (mutator) => {
      // ★ 深拷贝再改：`updateContent` 那边存的是白板的历史快照（JSON 字符串），
      //   但我们不该把**内存里那一份**就地改掉 —— 那份同时还是别处的当前值
      //   （撤销栈的基线、`read()` 的返回值）
      const next = cloneMind(slot.card.content.mind);
      if (mutator(next) === false) return false;
      ctx.updateContent({ mind: next });
      return true;
    },
    // 视图在"加子节点"之后立刻把光标送过来（它与卡片隔着菜单那一层，见 `editRequest`）
    requestEdit: (nodeId) => requestMindEdit(slot.card.id, nodeId),
  };

  return new EmbedMind({
    doc: el.ownerDocument,
    host: el,
    mind: slot.card.content.mind,
    readOnly: ctx.readOnly === true,
    mutate: source.mutate,
    // 根节点上右键也给节点菜单。
    // ★ `F4` 起**两张脑图卡都给**（用户 2026-09-21："这些功能都放到脑图的根节点上去"）：
    //   根节点那一份菜单里既有节点级的（加子节点 / 加同级 / 折叠 / 导出），
    //   又并上了卡片级的（颜色 / 锁定 / 复制 / 删除…），见 `BoardView.showMindNodeMenu`。
    allowRootMenu: true,
    onNodeMenu: (nodeId, event) => {
      ctx.minds?.nodeMenu?.({
        path: '',
        nodeId,
        event,
        cardId: slot.card.id,
        /* 老卡：请求键就是那张卡 */
        editKey: slot.card.id,
        inline: source,
      });
    },
    // 点节点 → 视图那条**底部快捷操作栏**换成"这个节点"（`F4`，用户 2026-09-21）
    onSelect: (nodeId) => {
      ctx.minds?.nodeFocus?.({ path: '', nodeId, cardId: slot.card.id, inline: source });
    },
    resolveResource: (target) => ctx.notes?.resourceUrl(target) ?? null,
    refMissing: (target) => (ctx.notes ? !ctx.notes.exists(target) : false),
    renderMarkdown: (markdown, host) => {
      void ctx.renderMarkdown(markdown, host).catch(() => undefined);
    },
    labels: {
      handle: (state) =>
        state.collapsed
          ? t('mind.handle.expand', { count: state.count })
          : t('mind.handle.collapse'),
      more: (count) => t('card.mind.more', { count }),
    },
    // 视图那侧刚加了节点 ⇒ 画完这一帧就进编辑器（键 = 这张卡的 id）
    consumeEditRequest: () => takeMindEdit(slot.card.id),
    // 装不下就请**卡片长大**，别把节点缩小（用户 2026-09-21）
    onRequiredSize: (size) => ctx.growTo?.(size),
  });
}

/** 深拷贝一份模型（见 `source.mutate` 里那条理由） */
function cloneMind(mind: MindFile): MindFile {
  return JSON.parse(JSON.stringify(mind)) as MindFile;
}
