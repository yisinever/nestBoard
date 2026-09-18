/**
 * 仅标题卡（`A3`，用户 2026-09-18；同日按反馈简化）。
 *
 * ── 它长什么样 ───────────────────────────────────────────────
 *
 * **一个圆角块 + 一行字**：底色就是**卡片自己的颜色**（画在卡片外壳上，卡面里**没有**
 * 第二层底色）、没有边框、文字默认**白色**（可在快捷操作栏里改字色）。
 *
 * ── 两次改动的来龙去脉（用户 2026-09-18）──────────────────────
 *
 * * **去掉"带气泡 / 指针方向"两档**：只保留纯圆角。原来的 `shape` / `tail` 两个键
 *   连同右键菜单里那几项一起删掉（这一版还没发出去，旧文件里残留的键读的时候直接忽略）。
 * * **去掉卡面里的那层底色**：从前是"卡壳一层 + 卡面里再铺一层同色"，
 *   视觉上多一层、也让人以为那层是可以单独改的。现在颜色只画在**外壳**上
 *   （与图片卡同一个手法），卡面本身透明。
 * * **加便签卡同款的快捷操作栏**：标记 / 粗 / 斜 / 下划线 / 字色 / 底色 —— 但**不含**
 *   "编辑内容"（这行字双击就能改，不需要一个"编辑内容"的入口）。
 *   于是 `card.icon` 与 `card.titleStyle` 这两个字段在这张卡上也真的生效了
 *   （从前它们存得进去、却没人画）。
 *
 * ★ 那行字住在**卡片标题**里（`CardBase.title`，用户 2026-09-18："它现在直接展示的是
 *   内容文字，实际上应该是直接展示标题文字"）：这张卡没有"标题 + 正文"两段，这行字就是
 *   它的全部。放 `title` 上之后，"编辑标题"、属性面板的「标题」、导出 / 收起那一行读的
 *   都是同一处。（旧版存在 `content.text` 里，读入口 `model/validate` 会顺手搬过去，
 *   老卡片一个字都不丢。）
 */

import type { CardTitleStyle } from '../model/schema';
import type { Size } from '../util/geometry';
import { t } from '../util/i18n';
import type { CardRenderContext, CardTypeDefinition } from './registry';

/** 默认尺寸：一行字那么高（它就是一枚"标签"，撑高了就不像标签了） */
export const TITLE_CARD_DEFAULT_SIZE: Size = { width: 200, height: 56 };

/** 本定义往槽位元素上加的 class，`destroy()` 必须**原样摘掉**（复用池里的节点会串味） */
const TITLE_CARD_CLASSES = ['nestboard-title-card', 'is-editing', 'is-empty'] as const;

/** 本定义写在元素上的行内自定义属性，`destroy()` 同样要摘干净 */
const TITLE_CARD_STYLE_VARS = ['font-weight', 'font-style', 'text-decoration', 'color'] as const;

export const titleCard: CardTypeDefinition<'titleCard'> = {
  type: 'titleCard',

  get displayName(): string {
    return t('card.type.titleCard');
  },

  icon: 'tag',
  /**
   * 右键菜单：这三项对这张卡没有意义（用户 2026-09-18："这些菜单对于标题卡没意义"）——
   *  * 「编辑内容」：那行字双击就能改，不必再给一个入口（与快捷操作栏同一条）；
   *  * 「显示 / 隐藏标题」：这张卡**没有标题行**，那行字就是它的全部（`card.title`）；
   *  * 「收起 / 展开」：收起只会把**唯一的内容**藏掉 —— 一张只剩空壳的标签卡。
   * ★ 是"整项不出现"而不是置灰：置灰是"此刻不能做"，不出现是"这张卡上没有这件事"。
   */
  menuItems: { editContent: false, showTitle: false, collapse: false },
  defaultSize: TITLE_CARD_DEFAULT_SIZE,

  createDefaultContent() {
    return { text: '' };
  },

  render(el: HTMLElement, card, ctx: CardRenderContext): void {
    el.classList.add('nestboard-title-card');
    el.classList.remove('is-editing', 'is-empty');
    delete el.dataset.placeholder;

    if (ctx.mode === 'edit') {
      renderEditor(el, card, ctx);
      return;
    }

    const doc = el.ownerDocument;
    // ★ 那行字 = **卡片标题**（`CardBase.title`），不是内容
    const text = card.title;

    const row = doc.createElement('div');
    row.className = 'nestboard-title-card-line';

    // 标记（`card.icon`）：与便签 / 白板卡同一个字段、同一处位置（文字前面）。
    // ★ 存在卡片自己的字段里（不是内容）—— 于是"标记"这个能力在这张卡上与别处一致
    const icon = card.icon ?? '';
    if (icon.length > 0) {
      const mark = doc.createElement('span');
      mark.className = 'nestboard-title-card-icon';
      mark.textContent = icon;
      row.appendChild(mark);
    }

    const line = doc.createElement('span');
    line.className = 'nestboard-title-card-text';
    if (text.length > 0) {
      line.textContent = text;
    } else {
      el.classList.add('is-empty');
      line.textContent = t('card.titleCard.placeholder');
    }
    applyTitleStyle(line, card.titleStyle);
    row.appendChild(line);

    el.replaceChildren(row);
  },

  /**
   * 收起后标题行写什么（与链接卡那一条同因）：这张卡的标题字段**永远是空的**
   * （文字住在内容里），不接管这一步，收起后的标签卡就是一条空白。
   */
  collapsedTitle(card): string {
    return card.title;
  },

  toMarkdown(card): string {
    return card.title;
  },

  destroy(el: HTMLElement): void {
    el.classList.remove(...TITLE_CARD_CLASSES);
    delete el.dataset.placeholder;
    for (const name of TITLE_CARD_STYLE_VARS) el.style.removeProperty(name);
    el.replaceChildren();
  },
};

/**
 * 把标题格式写进那一行（`card.titleStyle`：粗 / 斜 / 下划线 / 字色）。
 *
 * ★ 与便签卡标题带读的是**同一份数据**（`CardBase.titleStyle`）—— 快捷操作栏那排按钮
 *   改的就是它，这里只负责画出来。字段没设过就是默认那一档（不加粗、不斜、没下划线、
 *   **字色留白**：样式表里的白，用户挑过才盖掉）。
 * ★ 用行内样式而不是类：这四个值互相独立（粗 + 斜 + 下划线可以同时来），
 *   写类就得有 8 种组合的类名。
 */
function applyTitleStyle(el: HTMLElement, style: CardTitleStyle | undefined): void {
  // ★ 一律走 `style.setProperty` 而不是 `el.style.fontWeight = …`：仓库里其它地方
  //   （色板卡的墨色、图片卡的裁剪比例）都走 `setProperty`，假 DOM 也只实现它 ——
  //   直接赋属性在单测里读不回来，"存得进去却测不到"正是最该避免的一类盲区
  el.style.setProperty('font-weight', style?.bold === true ? 'var(--font-bold, 700)' : 'normal');
  el.style.setProperty('font-style', style?.italic === true ? 'italic' : 'normal');
  el.style.setProperty('text-decoration', style?.underline === true ? 'underline' : 'none');
  // 字色：用户挑过才写（没挑过时**不写**这个属性 ⇒ 落回样式表里的白）
  if (style?.ink) el.style.setProperty('color', style.ink);
}

/**
 * 编辑态：**一行输入框**（照地图卡"地点名"那套）。
 *
 * ★ `Enter` 提交、`Esc` 放弃、失焦提交：这张卡改的就是一句话。
 * ★ 其余按键 `stopPropagation`：不拦的话画布会把方向键 / Delete 当成"移动 / 删除这张卡"。
 * ★ 组字中的按键一律放过（中文输入法选字时 `Enter` 是选字，不是提交）。
 */
function renderEditor(
  el: HTMLElement,
  card: { title: string },
  ctx: CardRenderContext,
): void {
  el.classList.add('is-editing');
  const doc = el.ownerDocument;

  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'nestboard-title-card-input';
  input.value = card.title;
  input.placeholder = t('card.titleCard.placeholder');
  input.spellcheck = false;

  let finished = false;
  const exit = (): void => {
    if (finished) return;
    finished = true;
    ctx.setMode('display');
  };
  const commit = (): void => {
    if (finished) return;
    const next = input.value.trim();
    finished = true;
    // 没改就不写：否则每次点进点出都会递增 revision、把文件标脏（与便签 / 色板同一条）
    // ★ 写的是**卡片标题**（`ctx.updateCard`）—— 与右键「编辑标题」同一个字段，
    //   卡片上显示的就是它
    if (next !== card.title) ctx.updateCard({ title: next });
    ctx.setMode('display');
  };

  input.addEventListener('pointerdown', (event: Event) => event.stopPropagation());
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      exit();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commit();
      return;
    }
    event.stopPropagation();
  });

  el.replaceChildren(input);
  input.focus();
}
