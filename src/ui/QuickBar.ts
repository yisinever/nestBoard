/**
 * 选中一个对象时的**快捷操作栏**（脑图节点 `08 §3` / 白板便签 `O38`）。
 *
 * ── 两个调用方，一套实现 ───────────────────────────────────
 *
 * * **脑图**（`mind/view/MindView`）：选中单个节点时出现在画布下方居中；
 * * **白板**（`view/BoardView`）：选中单张便签时同上。
 *
 * 两边的按钮**逐个对应同一件事**（标记 / 加粗 / 斜体 / 下划线 / 字色 / 底色 / 编辑内容），
 * 差别只在"改的是谁"—— 于是这里只认回调与"现在是什么"，具体写回交给各自的视图
 * （脑图走 `ops.setIcon` / `setNodeStyle`，白板走 `ops.updateCardLook` / `updateCards`）。
 *
 * ── 三条口径 ──────────────────────────────────────────────
 *
 * 1. **只作用于整条标题**：标题是**一行纯文本**，没有"选区"这回事（`08 §3.2`）；
 * 2. **多选时整条收起**：多选能做的事与单节点差别太大，挤在一条栏里只会让人点错；
 * 3. **端口进、句柄出**（与 `CanvasControls` 同一条做法）：它不 import `obsidian`、
 *    不认识模型 ⇒ 能在假 DOM 下把"点 B 叫了谁 / 现在按着哪个态"逐条测掉。
 *
 * ★ "当前值"的标记**不查 DOM**（假 DOM 没有 `querySelectorAll`）：建弹层时把
 *   「元素 ↔ 它代表的值」记在一张表里，`syncPressed` 直接走那张表。
 * ★ `insertImage: false` = **不画那个按钮**：白板便签现在不做插图（用户 2026-09-16
 *   "拆入图片按钮先不做"），但两边的其余按钮仍然共用这一份实现。
 */

import { t, type MessageKey } from '../util/i18n';
import { EMOJI_GROUPS, type EmojiGroupKey } from '../util/emoji';
import { THEME_COLOR_OPTIONS } from '../util/color';
import { themeColorPreviewOf } from '../mind/model/palette';
import type { CardColor, HexColor, ThemeColor } from '../model/schema';

/**
 * 标题字色可选的几个色块（`08 §3.2`：**只给色块，不做色盘**）。
 *
 * ★ 带**白**：底色是深色时白字是唯一读得清的选项 —— 少了它这一栏就少了半条命。
 * ★ 顺序：先"默认观感"的黑与白，再是几个常用色相。
 */
export const MIND_TITLE_INKS: readonly HexColor[] = [
  '#1f2328',
  '#ffffff',
  '#c0392b',
  '#1f6feb',
  '#1a7f37',
  '#8250df',
];

/**
 * **文字高亮**可选的几个色块（`N3-f`：荧光笔那一档）。
 *
 * ★ 全是**浅色**：高亮是"划在文字背后"的底，深色会把字盖住 ——
 *   字色（`ink`）由对比度推 / 用户自己挑，这一档只负责"划哪一支笔"。
 * ★ 与字色那六格**刻意不共用一张表**：两张表想要的明度正好相反
 *   （字色要深、高亮要浅），合成一张必然会有人需要"反过来"的那一格。
 */
export const MIND_TITLE_HIGHLIGHTS: readonly HexColor[] = [
  '#fff3b0', // 黄（最常用的一支）
  '#d3f9d8', // 绿
  '#cfe8ff', // 蓝
  '#ffd6e0', // 粉
  '#ffe8cc', // 橙
  '#e9d8fd', // 紫
];

/** 标记分组 → 分组标题的 i18n 键（一个字面量一张表，见 `buildIconPopover` 的注释） */
const GROUP_LABEL_KEYS: Record<EmojiGroupKey, Parameters<typeof t>[0]> = {
  symbols: 'mind.emojiGroup.symbols',
  geometry: 'mind.emojiGroup.geometry',
  office: 'mind.emojiGroup.office',
  status: 'mind.emojiGroup.status',
  docs: 'mind.emojiGroup.docs',
  ideas: 'mind.emojiGroup.ideas',
  time: 'mind.emojiGroup.time',
  people: 'mind.emojiGroup.people',
  nature: 'mind.emojiGroup.nature',
  tools: 'mind.emojiGroup.tools',
};

/** 栏上可以有的按钮（`O38`） */
export type QuickBarFeature =
  /** 标记（emoji） */
  | 'icon'
  | 'bold'
  | 'italic'
  | 'underline'
  /** 标题**字色** */
  | 'ink'
  /** 标题**文字背后的高亮**（`N3-f`：荧光笔那一档） */
  | 'highlight'
  /** 卡片**底色** */
  | 'color'
  /** 最后那个按钮：便签是「编辑内容」、白板卡是「编辑标题」（见 `editLabel`） */
  | 'editNote'
  | 'insertImage'
  /**
   * 「连线」（`N1-b`）：从当前这个节点拉一条**关联线**出去。
   *
   * ★ 只有脑图的**单节点**栏才画它：起点必须是明确的"这一个"，多选时那点谁都不对
   *   （`MindView` 的多选按钮集 `MULTI_NODE_FEATURES` 里没有它）；
   *   白板那两类卡片的按钮集里也没有 ⇒ 那边永远不会画出来。
   */
  | 'link';

/** 全都画（脑图那条线走这一档） */
const ALL_FEATURES: ReadonlySet<QuickBarFeature> = new Set<QuickBarFeature>([
  'icon',
  'bold',
  'italic',
  'underline',
  'ink',
  'highlight',
  'color',
  'editNote',
  'insertImage',
  'link',
]);

/** 当前选中节点的那几个值（`node` 为 `null` = 整条藏起来） */
export interface NodeToolbarState {
  node: {
    id: string;
    /** 空串 = 没有标记 */
    icon: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    /** 显式设过的主色；`null` = 跟着层级默认走 */
    color: CardColor | null;
    /** 显式设过的字色；`null` = 按底色对比度推 */
    ink: HexColor | null;
    /** 显式设过的**文字高亮**（`N3-f`）；`null` = 没有高亮 */
    highlight: HexColor | null;
  } | null;
  /** 能不能改（只读库 / 保护态时整排置灰） */
  writable: boolean;
  /**
   * **这一张卡能改哪几样**；不在集合里的按钮**不画**。缺省 = 全都有。
   *
   * ★ 放**状态**里而不是建栏时定死：同一条栏要同时伺候好几种卡片 ——
   *   便签有"标题整条格式"（粗 / 斜 / 下划线 / 字色），白板卡没有；
   *   白板卡只要"标记 + 底色 + 编辑标题"。建两条栏（各写一份）会让
   *   "一边加了按钮、另一边忘了"变成必然。
   * ★ 不是"置灰"而是"不画"：置灰是"这件事现在不能做"，不画是"这张卡上没有这件事" ——
   *   便签上摆一个永远灰着的 B，用户只会以为按钮坏了。
   */
  features?: ReadonlySet<QuickBarFeature>;
  /**
   * 最后那个按钮怎么称呼（`editNote` 那一格）。
   *
   * ★ 文案**由视图给**（`t()` 的键是联合类型，视图手里才有"这张卡是什么"）：
   *   便签给「编辑内容」，白板卡给「编辑标题」—— 点下去做的事也不同（见 `onEditNote`）。
   */
  editLabel?: MessageKey;
}

export interface NodeToolbarOptions {
  /** 挑了一个标记（空串 = 清除） */
  onIcon: (icon: string) => void;
  onBold: () => void;
  onItalic: () => void;
  onUnderline: () => void;
  /** 挑了一个主色（`null` = 回到层级默认） */
  onColor: (color: CardColor | null) => void;
  /** 挑了一个字色（`null` = 按底色对比度推） */
  onInk: (ink: HexColor | null) => void;
  /** 挑了一个**文字高亮**（`N3-f`；`null` = 去掉高亮） */
  onHighlight: (highlight: HexColor | null) => void;
  /** 最后一个按钮（便签 = 编辑内容 / 白板卡 = 编辑标题，看 `state.editLabel`） */
  onEditNote: () => void;
  onInsertImage: () => void;
  /** 「连线」（`N1-b`）：从当前节点开始拉一条关联线 */
  onLink: () => void;
  /** 主题色编号 → 真实色号（色块要画成用户主题里那个色，不然是骗人的） */
  resolveTheme?: (color: ThemeColor) => HexColor;
}

export interface NodeToolbar {
  readonly element: HTMLElement;
  setState(state: NodeToolbarState): void;
  /** 收起弹层（点画布别处 / 关视图 / 换文件时调） */
  closePopovers(): void;
  /**
   * 直接打开**标记**弹层（白板卡右键菜单那一项用，`O10`）；开不了给 `false`。
   *
   * ★ 返回布尔而不是"保证打开"：调用方据此决定要不要退回旧的选择器 ——
   *   多选 / 只读 / 栏没建起来时，那条路仍然要能走通。
   */
  openIconPicker(): boolean;
}

type PopoverKind = 'icon' | 'ink' | 'highlight' | 'color';

/** 弹层里"这个元素代表哪个值"（用来标当前值） */
interface Marked {
  element: HTMLElement;
  value: string;
}

export function buildNodeToolbar(doc: Document, options: NodeToolbarOptions): NodeToolbar {
  const root = doc.createElement('div');
  root.className = 'nestboard-mind-toolbar';

  const popover = doc.createElement('div');
  popover.className = 'nestboard-mind-toolbar__popover';

  let open: PopoverKind | null = null;
  let marked: Marked[] = [];
  let state: NodeToolbarState = { node: null, writable: false };

  // ── 按钮 ──
  const icon = textButton(doc, 'is-icon', t('mind.toolbar.mark'), () => toggle('icon'));
  const bold = textButton(doc, 'is-bold', t('mind.toolbar.bold'), () => options.onBold());
  const italic = textButton(doc, 'is-italic', t('mind.toolbar.italic'), () => options.onItalic());
  const underline = textButton(doc, 'is-underline', t('mind.toolbar.underline'), () =>
    options.onUnderline(),
  );
  const ink = textButton(doc, 'is-ink', t('mind.toolbar.ink'), () => toggle('ink'));
  // ★ 「高亮」（`N3-f`）紧挨着字色：两件都是"改字这一块"，摆一起好找（底色是另一类，排在它们右边）
  const highlight = textButton(doc, 'is-highlight', t('mind.toolbar.highlight'), () =>
    toggle('highlight'),
  );
  const color = textButton(doc, 'is-color', t('mind.toolbar.color'), () => toggle('color'));
  const note = textButton(doc, 'is-note', t('mind.toolbar.editNote'), () => options.onEditNote());
  const image = textButton(doc, 'is-image', t('mind.toolbar.insertImage'), () =>
    options.onInsertImage(),
  );
  // ★ 「连线」排在**最右**：它是"从这张卡出发去连一个别的"，
  //   与前面那些"改这张卡自己的样子"不是一类（用户也是这么说的：最右多一格）
  const link = textButton(doc, 'is-link', t('mind.toolbar.link'), () => options.onLink());

  bold.textContent = 'B';
  italic.textContent = 'I';
  underline.textContent = 'U';
  ink.textContent = 'A';
  highlight.textContent = '🖍';
  color.textContent = '◧';
  note.textContent = '¶';
  image.textContent = '🖼';
  link.textContent = '↗';

  // 两条分隔线留成**变量**：某一侧的按钮全都不画时，它得跟着一起消失
  //（否则白板卡那条栏会剩成"标记 | 空的竖线 | 编辑标题"，多出一道具名其妙的线）
  const sepA = separator(doc);
  const sepB = separator(doc);

  root.append(
    icon,
    sepA,
    bold,
    italic,
    underline,
    ink,
    highlight,
    color,
    sepB,
    note,
    image,
    link,
    popover,
  );

  /** 按 `state.features` 决定哪几个按钮**不画**（不是置灰，见 `NodeToolbarState.features`） */
  function applyFeatures(): void {
    const on: ReadonlySet<QuickBarFeature> = state.features ?? ALL_FEATURES;
    const format: readonly QuickBarFeature[] = [
      'bold',
      'italic',
      'underline',
      'ink',
      'highlight',
      'color',
    ];
    const tail: readonly QuickBarFeature[] = ['editNote', 'insertImage', 'link'];

    icon.classList.toggle('is-hidden', !on.has('icon'));
    for (const [key, button] of [
      ['bold', bold],
      ['italic', italic],
      ['underline', underline],
      ['ink', ink],
      ['highlight', highlight],
      ['color', color],
      ['editNote', note],
      ['insertImage', image],
      ['link', link],
    ] as const) {
      button.classList.toggle('is-hidden', !on.has(key));
    }

    // 分隔线：左右两组**都有东西**时才留
    sepA.classList.toggle('is-hidden', !on.has('icon') || !format.some((key) => on.has(key)));
    sepB.classList.toggle(
      'is-hidden',
      !format.some((key) => on.has(key)) || !tail.some((key) => on.has(key)),
    );

    // 最后那个按钮叫什么（便签「编辑内容」/ 白板卡「编辑标题」）
    // ★ 走 `setAttribute` 而不是 `.title =`：假 DOM 里只有属性看得见
    //   （`FakeElement` 没有 title 这个访问器），而这条正是要测的东西
    const label = t(state.editLabel ?? 'mind.toolbar.editNote');
    note.setAttribute('title', label);
    note.setAttribute('aria-label', label);
  }

  /**
   * 打开一个弹层；开不了（没选中 / 只读）给 `false`。
   *
   * ★ 单独抽出来是给**别处**用的：白板卡右键菜单的「卡面图标…」直接叫它
   *   （用户 2026-09-16："选图标的组件，应该用和便签卡选标记同样的组件"）——
   *   右键一张卡会先把它选成单选，栏正显示着它，于是那一项就等于"打开栏上的标记"。
   */
  function openPopover(kind: PopoverKind): boolean {
    if (state.node === null || !state.writable) return false;
    open = kind;
    popover.className = 'nestboard-mind-toolbar__popover is-open';
    if (kind === 'icon') buildIconPopover(doc, popover, options, afterPick, register);
    else buildSwatches(doc, popover, kind, options, afterPick, register);
    syncPressed();
    return true;
  }

  /** 开 / 关一个弹层（再点同一个按钮就是收起） */
  function toggle(kind: PopoverKind): void {
    // ★ 先记下"原来开着的是不是它"，再关 —— 反过来写的话 `open` 已经被清成 `null`，
    //   那一句判断永远为假，于是"再点一次"会**再打开一遍**（看起来像按钮没反应）
    const wasOpen = open === kind;
    closePopovers();
    if (wasOpen) return;
    openPopover(kind);
  }

  function closePopovers(): void {
    open = null;
    marked = [];
    popover.className = 'nestboard-mind-toolbar__popover';
    popover.replaceChildren();
  }

  /** 记一笔"这个元素代表这个值"（弹层的当前值标记靠它，不查 DOM） */
  function register(element: HTMLElement, value: string): void {
    marked.push({ element, value });
  }

  /** 点了弹层里的一项：先收起弹层（视图随后会回灌新状态） */
  function afterPick(): void {
    closePopovers();
  }

  function syncPressed(): void {
    const node = state.node;
    const off = !state.writable || node === null;
    for (const button of [
      bold,
      italic,
      underline,
      ink,
      highlight,
      color,
      icon,
      note,
      image,
      link,
    ]) {
      button.classList.toggle('is-disabled', off);
    }
    bold.classList.toggle('is-active', node?.bold === true);
    italic.classList.toggle('is-active', node?.italic === true);
    underline.classList.toggle('is-active', node?.underline === true);
    icon.textContent = node && node.icon.length > 0 ? node.icon : '🙂';
    ink.classList.toggle('has-value', Boolean(node?.ink));
    highlight.classList.toggle('has-value', Boolean(node?.highlight));
    color.classList.toggle('has-value', Boolean(node?.color));

    // 当前值的小勾：走上面那张表，不查 DOM
    for (const item of marked) {
      const current =
        open === 'icon'
          ? item.value === (node?.icon ?? '')
          : open === 'ink'
            ? item.value === (node?.ink ?? '')
            : open === 'highlight'
              ? item.value === (node?.highlight ?? '')
              : String(node?.color ?? '') === item.value;
      item.element.classList.toggle('is-current', current);
    }
  }

  return {
    element: root,
    setState(next: NodeToolbarState): void {
      // ★ **换了节点就把弹层收掉**：留着上一个人的色块，点下去是给新节点上色 ——
      //   用户看到的与将发生的对不上（选中态那几个小勾也跟着一起翻新）
      const switched = state.node?.id !== next.node?.id;
      state = next;
      root.classList.toggle('is-hidden', next.node === null);
      if (next.node === null || !next.writable || switched) closePopovers();
      // 按钮集**先**定下来再刷"按着哪个态"：反过来的话，刚被藏起来的那个按钮
      // 会先给用户看一眼再消失（一帧的闪烁，切换卡片类型时看得见）
      applyFeatures();
      syncPressed();
    },
    closePopovers,
    openIconPicker: () => openPopover('icon'),
  };
}

function buildIconPopover(
  doc: Document,
  popover: HTMLElement,
  options: NodeToolbarOptions,
  afterPick: () => void,
  register: (element: HTMLElement, value: string) => void,
): void {
  const groups = doc.createElement('div');
  groups.className = 'nestboard-mind-toolbar__groups';

  for (const group of EMOJI_GROUPS) {
    const row = doc.createElement('div');
    row.className = 'nestboard-mind-toolbar__group';

    const label = doc.createElement('span');
    label.className = 'nestboard-mind-toolbar__group-label';
    // ★ 键写成**字面量映射**而不是模板串：`t()` 的键是联合类型，
    //   拼出来的字符串过不了类型（也就少了"加了分组忘了加文案"这种错）
    label.textContent = t(GROUP_LABEL_KEYS[group.key]);
    row.appendChild(label);

    const strip = doc.createElement('div');
    strip.className = 'nestboard-mind-toolbar__strip';
    for (const emoji of group.emojis) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'nestboard-mind-toolbar__emoji';
      button.textContent = emoji;
      button.title = emoji;
      button.addEventListener('click', () => {
        options.onIcon(emoji);
        afterPick();
      });
      register(button, emoji);
      strip.appendChild(button);
    }
    row.appendChild(strip);
    groups.appendChild(row);
  }
  popover.appendChild(groups);

  popover.appendChild(
    clearButton(doc, t('mind.toolbar.clearMark'), () => {
      options.onIcon('');
      afterPick();
    }),
  );
}

/** 字色 / 高亮 / 底色共用的色块行（`kind` 决定点了调谁） */
function buildSwatches(
  doc: Document,
  popover: HTMLElement,
  kind: 'ink' | 'highlight' | 'color',
  options: NodeToolbarOptions,
  afterPick: () => void,
  register: (element: HTMLElement, value: string) => void,
): void {
  const row = doc.createElement('div');
  row.className = 'nestboard-mind-toolbar__swatches';

  if (kind === 'ink') {
    for (const hex of MIND_TITLE_INKS) {
      const button = swatch(doc, hex, () => options.onInk(hex), afterPick);
      register(button, hex);
      row.appendChild(button);
    }
  } else if (kind === 'highlight') {
    // 高亮（`N3-f`）：另一支**浅色**表（字色要深、高亮要浅，两张表刻意分开）
    for (const hex of MIND_TITLE_HIGHLIGHTS) {
      const button = swatch(doc, hex, () => options.onHighlight(hex), afterPick);
      register(button, hex);
      row.appendChild(button);
    }
  } else {
    for (const theme of THEME_COLOR_OPTIONS) {
      // 色块画成**用户主题里那个色**（否则是骗人的）：解析不出来才退回近似表
      const hex = themeColorPreviewOf(theme, options.resolveTheme);
      const button = swatch(doc, hex, () => options.onColor(theme), afterPick);
      register(button, theme);
      row.appendChild(button);
    }
  }
  popover.appendChild(row);

  popover.appendChild(
    clearButton(
      doc,
      kind === 'ink'
        ? t('mind.toolbar.clearInk')
        : kind === 'highlight'
          ? t('mind.toolbar.clearHighlight')
          : t('mind.toolbar.clearColor'),
      () => {
        if (kind === 'ink') options.onInk(null);
        else if (kind === 'highlight') options.onHighlight(null);
        else options.onColor(null);
        afterPick();
      },
    ),
  );
}

function swatch(
  doc: Document,
  hex: HexColor,
  onClick: () => void,
  afterPick: () => void,
): HTMLElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'nestboard-mind-toolbar__swatch';
  // 色块自己带颜色：写进 `style.background`（假 DOM 下也读得出来）
  button.style.background = hex;
  button.title = hex;
  button.setAttribute('aria-label', hex);
  button.addEventListener('click', () => {
    onClick();
    afterPick();
  });
  return button;
}

function clearButton(doc: Document, label: string, onClick: () => void): HTMLElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'nestboard-mind-toolbar__clear';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function textButton(
  doc: Document,
  className: string,
  label: string,
  onClick: () => void,
): HTMLElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `nestboard-mind-toolbar__button ${className}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

function separator(doc: Document): HTMLElement {
  const el = doc.createElement('span');
  el.className = 'nestboard-mind-toolbar__sep';
  return el;
}
