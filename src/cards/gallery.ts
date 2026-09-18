/**
 * 图集卡（`A4`，用户 2026-09-18："支持图集卡片 —— 可上传多张图片（会放到 ob 仓库下），
 * 以卡牌形式展示，有一定层叠效果、有一定动效；点击之后会切换"）。
 *
 * ── 它长什么样 ───────────────────────────────────────────────
 *
 * 当前那张图铺满卡片，**后面两张露一点边**（错开 + 缩小 + 阴影）—— 一眼看出"这里不止一张"；
 * 右下角 `3 / 7` 说清"这是第几张"；两侧悬停出现上一张 / 下一张箭头。
 *
 * ── 三个刻意的决定 ──────────────────────────────────────────
 *
 * 1. **入口是"一次拖进两张以上图片"**（`model/drop.ts` 的 `cardsForDropPaths`），
 *    不做"每次问一句：分成多张卡还是一张图集"的对话框 —— 那个提问本身比这个功能还重，
 *    而手势已经说清意思了（一起拖进来 = 摆在一起）。一张图仍是图片卡（原样不动）。
 * 2. **翻页不抢单击**：卡片的第一交互永远是拖，把单击吃掉就等于让这张卡没法挪
 *    （与文件卡"播放态才吃指针"同一条纪律）。于是翻页走**两只箭头**（它们自己挡冒泡）
 *    与**双击**（用户说的"点击之后会切换"——双击是它在不干扰拖动的前提下能做到的版本）。
 * 3. **`index` 只是数据、不是状态**：翻到第几张写回内容里，于是关掉重开还停在那一张，
 *    而且**一次翻页 = 一步撤销**（与卡片上任何别的改动一样）。
 */

import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 默认尺寸：与图片卡同宽（一组图就该按图片的尺寸摆） */
export const GALLERY_DEFAULT_SIZE: Size = { width: 320, height: 240 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（复用池里的节点会串味） */
const GALLERY_CLASSES = ['nestboard-gallery', 'is-missing', 'is-empty'] as const;

export const galleryCard: CardTypeDefinition<'gallery'> = {
  type: 'gallery',

  get displayName(): string {
    return t('card.type.gallery');
  },

  icon: 'images',
  defaultSize: GALLERY_DEFAULT_SIZE,

  createDefaultContent() {
    return { paths: [] };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-gallery');
    el.classList.remove('is-missing', 'is-empty');
    delete el.dataset.placeholder;

    const doc = el.ownerDocument;
    const { paths } = card.content;

    if (paths.length === 0) {
      el.classList.add('is-empty');
      el.dataset.placeholder = 'true';
      el.replaceChildren(doc.createTextNode(t('card.gallery.empty')));
      return;
    }

    const index = clampIndex(card.content.index, paths.length);
    const current = paths[index] ?? '';
    const url = ctx.notes?.resourceUrl(current) ?? null;

    if (url === null) {
      // 这一张丢了（改名 / 删掉）：说清楚是**哪一张**，而不是让卡面一片空白
      el.classList.add('is-missing');
      el.dataset.placeholder = 'true';
      el.replaceChildren(doc.createTextNode(t('card.file.missing', { path: current })));
      return;
    }

    const stack = doc.createElement('div');
    stack.className = 'nestboard-gallery-stack';

    // 牌堆：先画后面两张（它们在当前这张**下面**），错开与缩小交给样式表
    for (const depth of [2, 1]) {
      const behind = doc.createElement('div');
      behind.className = `nestboard-gallery-card is-behind-${depth}`;
      stack.appendChild(behind);
    }

    const main = doc.createElement('img');
    main.className = 'nestboard-gallery-image';
    main.src = url;
    main.alt = '';
    main.draggable = false;
    // 图裂了就说清楚是哪一张，而不是留一个裂图图标（与图片卡同一条）
    main.addEventListener('error', () => {
      el.classList.add('is-missing');
      el.replaceChildren(doc.createTextNode(t('card.file.missing', { path: current })));
      ctx.contentReady?.();
    });
    main.addEventListener('load', () => ctx.contentReady?.());
    stack.appendChild(main);

    // 两只箭头：**挡住冒泡**，否则按下去就成了"拖卡 / 框选"
    const prev = buildArrow(doc, 'prev', t('card.gallery.prev'));
    const next = buildArrow(doc, 'next', t('card.gallery.next'));
    prev.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
    next.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
    prev.addEventListener('click', (event: Event) => {
      event.stopPropagation();
      turn(card, -1, (patch) => ctx.updateContent(patch));
    });
    next.addEventListener('click', (event: Event) => {
      event.stopPropagation();
      turn(card, 1, (patch) => ctx.updateContent(patch));
    });

    const counter = doc.createElement('span');
    counter.className = 'nestboard-gallery-counter';
    counter.textContent = t('card.gallery.counter', { index: index + 1, total: paths.length });

    stack.append(prev, next, counter);
    el.replaceChildren(stack);
  },

  /**
   * 双击 = **翻到下一张**（用户："点击之后会切换"）。
   *
   * ★ 单击留给"选中 / 拖卡"（见文件头第 2 条），所以这一档落在双击上。
   * ★ 只有一张图时**不接管**（返回 `false`）：那时双击什么都没得翻，
   *   交给视图按默认处理更像话（也顺带让"编辑内容"这类通用项仍然可用）。
   */
  onDoubleClick(card, ctx): boolean {
    const total = card.content.paths.length;
    if (total < 2) return false;
    turn(card, 1, (patch) => ctx.applyContent(patch));
    return true;
  },

  /**
   * 收起后标题行写什么：`3 / 7`。
   *
   * ★ 不接管的话，收起后的图集卡是一条空白（它的 `CardBase.title` 永远是空的）——
   *   而"这是第几张 / 共几张"正是这张卡最该说的一句话。
   */
  collapsedTitle(card): string {
    const total = card.content.paths.length;
    if (total === 0) return '';
    return t('card.gallery.counter', { index: clampIndex(card.content.index, total) + 1, total });
  },

  /** 导出成 Markdown：一组图就是一组内嵌（顺序就是卡面上的顺序） */
  toMarkdown(card): string {
    return card.content.paths.map((path) => `![[${path}]]`).join('\n');
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...GALLERY_CLASSES);
    delete el.dataset.placeholder;
    el.replaceChildren();
  },
};

/** `index` 夹进合法范围：文件里的坏值不该让卡面一片空白 */
function clampIndex(index: number | undefined, total: number): number {
  const raw = typeof index === 'number' && Number.isFinite(index) ? Math.floor(index) : 0;
  return Math.min(Math.max(0, total - 1), Math.max(0, raw));
}

/**
 * 翻一张：**到头回环**（一组图是循环看的，最后一张再按下就该回第一张）。
 *
 * ★ 写回内容的口子由调用方给（`apply`）：渲染上下文与动作上下文是**两个接口**
 *   （前者 `updateContent`、后者 `applyContent`），而"翻页"这件事两边都要用 ——
 *   把口子收成一个参数，就不必让这个纯函数认识两种上下文。
 */
function turn(
  card: { content: { paths: string[]; index?: number } },
  delta: number,
  apply: (patch: { index: number }) => void,
): void {
  const total = card.content.paths.length;
  if (total < 2) return;
  const index = clampIndex(card.content.index, total);
  apply({ index: (index + delta + total) % total });
}

/** 一只箭头（`data-direction` 给样式表定位，图标用字符省一次 `setIcon` 依赖） */
function buildArrow(doc: Document, direction: 'prev' | 'next', label: string): HTMLElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'nestboard-gallery-arrow';
  button.dataset.direction = direction;
  button.textContent = direction === 'prev' ? '‹' : '›';
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}
