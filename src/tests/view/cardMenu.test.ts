/**
 * 卡片右键菜单的**绑定**测试（T1.41 / T2.02）。
 *
 * 规格层本身是纯数据，这里只钉一件容易出错的事：卡片定义说的
 * "我要一个『裁剪图片』"能不能被正确翻译成"对**这张**卡调用 `cropImage`"。
 *
 * ★ 两种失败都要挡住：
 *  * 能力缺失（嵌入视图 / 测试上下文里没有对话框）→ 整项**不出现**，
 *    而不是留一个点了没反应的死项；
 *  * 绑错目标（多选时点哪张裁哪张）→ 必须传 `target.id`。
 *
 * ★ 两种"形状"也各有一次：**档位项**（卡面预览的四档，`O09` 加了 mini）传的是
 *   "切成哪一档"这个常量，**开关项**（深色便签，`O06`）只传卡片自己 ——
 *   绑错了不会报错，只会把卡切成"下一档"以外的某个档。
 */

import { describe, expect, it, vi } from 'vitest';
import { createCard, createColumn, createEdge } from '../../model/factories';
import type { CardMenuItemKey } from '../../cards/registry';
import {
  buildCanvasMenuSpec,
  buildCardMenuSpec,
  buildColumnMenuSpec,
  buildEdgeMenuSpec,
  type CardMenuActions,
  type ColumnMenuActions,
  type EdgeMenuActions,
  type TypeMenuInput,
} from '../../view/interact/cardMenu';

function makeActions(overrides: Partial<CardMenuActions> = {}): CardMenuActions {
  return {
    edit: vi.fn(),
    editTitle: vi.fn(),
    setShowTitle: vi.fn(),
    toggleCollapse: vi.fn(),
    setColor: vi.fn(),
    setAccent: vi.fn(),
    pickColor: vi.fn(),
    bringToFront: vi.fn(),
    sendToBack: vi.fn(),
    copy: vi.fn(),
    cut: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    promote: vi.fn(),
    toggleLock: vi.fn(),
    openSource: vi.fn(),
    relink: vi.fn(),
    ...overrides,
  };
}

const CROP_ITEM = { id: 'image-crop', title: 'Crop image', action: 'cropImage' } as const;
const ANNOTATE_ITEM = {
  id: 'image-annotate',
  title: 'Draw on image',
  action: 'inkAnnotate',
} as const;

// ─────────────────────────────────────────────────────────────
// 「编辑内容」的存在性（O35）
//
// 通用菜单第一项叫「编辑内容」，可当类型的双击被自己接走时（文件卡 = 用系统应用打开、
// 链接卡 = 跳浏览器、白板卡 = 进子板），它点下去是**跳转**而不是编辑 —— 名不副实。
// 视图把注册表的 `inlineEditable(type)` 传进来，为 `false` 时这一项**整项不出现**。
// ─────────────────────────────────────────────────────────────

describe('buildCardMenuSpec × 「编辑内容」（O35）', () => {
  const target = createCard('file', { content: { path: 'a.pdf', showSize: true } });

  it('双击会进编辑态的类型：照旧给「编辑内容」', () => {
    const spec = buildCardMenuSpec({ selection: [target], target, actions: makeActions() });
    expect(spec.some((entry) => entry.id === 'edit')).toBe(true);
  });

  it('★ 双击被类型接走的类型：整项不出现（不置灰 —— 它对这种类型根本不成立）', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      inlineEdit: false,
    });

    expect(spec.some((entry) => entry.id === 'edit')).toBe(false);
    // 只挪走这一项：其余各项一个都不许少
    expect(spec.some((entry) => entry.id === 'edit-title')).toBe(true);
    expect(spec.some((entry) => entry.id === 'toggle-collapse')).toBe(true);
    expect(spec.some((entry) => entry.id === 'duplicate')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 类型可以关掉那几项"对它没意义"的通用项（`A3` 仅标题卡，用户 2026-09-18）
//
// 卡片定义写 `menuItems: { editContent: false, showTitle: false, collapse: false }`，
// 视图翻成集合递给规格层 —— 命中的项**整项不出现**（不是置灰）。
// ─────────────────────────────────────────────────────────────

describe('buildCardMenuSpec × 类型关掉的通用项（仅标题卡）', () => {
  const target = createCard('titleCard', { title: '标签' });

  it('★ 这三项整项不出现，其余各项一个不少', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      hiddenItems: new Set<CardMenuItemKey>(['editContent', 'showTitle', 'collapse']),
    });
    const ids = spec.map((entry) => entry.id);

    expect(ids).not.toContain('edit');
    expect(ids).not.toContain('toggle-title');
    expect(ids).not.toContain('toggle-collapse');
    // 只挪走这三项
    expect(ids).toContain('edit-title');
    expect(ids).toContain('color');
    expect(ids).toContain('duplicate');
  });

  it('缺省（没传 `hiddenItems`）＝ 全都要：三项照旧摆出来', () => {
    const ids = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
    }).map((entry) => entry.id);

    expect(ids).toContain('edit');
    expect(ids).toContain('toggle-title');
    expect(ids).toContain('toggle-collapse');
  });
});

describe('buildCardMenuSpec × 类型菜单项', () => {
  it('cropImage：绑定到被右击的那张卡', () => {
    const target = createCard('image', { content: { path: 'a.png' } });
    const cropImage = vi.fn();
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ cropImage }),
      typeItems: [CROP_ITEM],
    });

    const item = spec.find((entry) => entry.id === 'image-crop');
    expect(item).toBeDefined();
    item?.run?.();
    expect(cropImage).toHaveBeenCalledWith(target.id);
  });

  it('cropImage：视图没提供能力时整项不出现（不留死项）', () => {
    const target = createCard('image', { content: { path: 'a.png' } });
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      typeItems: [CROP_ITEM],
    });
    expect(spec.some((entry) => entry.id === 'image-crop')).toBe(false);
  });

  it('inkAnnotate：接到视图的"给我一支笔"上（不收 id，标注算谁由笔迹的落点决定）', () => {
    const target = createCard('image', { content: { path: 'a.png' } });
    const inkAnnotate = vi.fn();
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ inkAnnotate }),
      typeItems: [ANNOTATE_ITEM],
    });

    const item = spec.find((entry) => entry.id === 'image-annotate');
    expect(item).toBeDefined();
    item?.run?.();
    expect(inkAnnotate).toHaveBeenCalledTimes(1);
  });

  it('inkAnnotate：视图没有手绘能力时整项不出现（与 cropImage 同一套约定）', () => {
    const target = createCard('image', { content: { path: 'a.png' } });
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      typeItems: [ANNOTATE_ITEM],
    });
    expect(spec.some((entry) => entry.id === 'image-annotate')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 分组项（一层子菜单，T7.09 / F7-10）
//
// 白板卡要摆"卡面预览"的四个互斥档位。平铺成四项的话，右键菜单里会出现一排
// 标题几乎一样、还各自带勾的项（四个勾并存看着像多选）。分组 + 展开是唯一
// 读得懂的摆法。这里钉三件事：子项的动作**真的绑上了**、绑不上时**整组不出现**、
// 只读时**整组一起灰**。
// ─────────────────────────────────────────────────────────────

const PREVIEW_GROUP: TypeMenuInput = {
  id: 'board-preview',
  title: 'Card preview',
  children: [
    { id: 'board-preview-thumb', title: 'Thumbnail', action: 'boardPreviewThumb' },
    { id: 'board-preview-mini', title: 'Mini', action: 'boardPreviewMini' },
    { id: 'board-preview-live', title: 'Live view', action: 'boardPreviewLive' },
    { id: 'board-preview-none', title: 'None', action: 'boardPreviewNone' },
  ],
};

describe('buildCardMenuSpec × 分组项（一层子菜单）', () => {
  const target = createCard('boardRef', {
    content: { path: 'Boards/子板.nboard', preview: 'thumb', showCount: true },
  });

  const childrenOf = (spec: ReturnType<typeof buildCardMenuSpec>) =>
    spec.find((entry) => entry.id === 'board-preview')?.children ?? [];

  it('四个档位绑到**同一个** `boardPreview` 上，各自带自己的档位', () => {
    const boardPreview = vi.fn();
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ boardPreview }),
      typeItems: [PREVIEW_GROUP],
    });

    const children = childrenOf(spec);
    expect(children.map((entry) => entry.id)).toEqual([
      'board-preview-thumb',
      'board-preview-mini',
      'board-preview-live',
      'board-preview-none',
    ]);
    // ★ 绑的是"档位常量"而不是"下一档"：菜单项是**选择**，不是开关
    for (const [index, mode] of (['thumb', 'mini', 'live', 'none'] as const).entries()) {
      children[index]?.run?.();
      expect(boardPreview).toHaveBeenLastCalledWith(target, mode);
    }
    expect(boardPreview).toHaveBeenCalledTimes(4);
  });

  it('★ 视图没有 `boardPreview` 能力 → 整组不出现（留个展开后空着的小三角最糟）', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      typeItems: [PREVIEW_GROUP],
    });
    expect(spec.some((entry) => entry.id === 'board-preview')).toBe(false);
  });

  it('组里绑不上的子项被剔掉，绑得上的照常绑', () => {
    const boardPreview = vi.fn();
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ boardPreview }),
      typeItems: [
        {
          id: 'mixed',
          title: 'Mixed',
          children: [
            { id: 'mixed-live', title: 'live', action: 'boardPreviewLive' },
            // 测试上下文里没有"打开另一个视图"这一层 → `openBoard` 绑不上
            { id: 'mixed-open', title: 'open', action: 'openBoard' },
          ],
        },
      ],
    });

    expect(spec.find((entry) => entry.id === 'mixed')?.children?.map((entry) => entry.id)).toEqual([
      'mixed-live',
    ]);
  });

  it('一个子项都绑不上 → 整组不出现', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      typeItems: [
        {
          id: 'dead',
          title: 'Dead',
          children: [{ id: 'dead-open', title: 'open', action: 'openBoard' }],
        },
      ],
    });
    expect(spec.some((entry) => entry.id === 'dead')).toBe(false);
  });

  it('★ 只读板：子项跟着父项一起灰（只灰父项挡不住"展开再点"）', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      readOnly: true,
      actions: makeActions({ boardPreview: vi.fn() }),
      typeItems: [PREVIEW_GROUP],
    });

    const group = spec.find((entry) => entry.id === 'board-preview');
    expect(group?.disabled).toBe(true);
    expect(group?.children).toHaveLength(4);
    expect(group?.children?.every((child) => child.disabled === true)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 深色便签开关（O06）
//
// 改的是**这张卡的内容**（`NoteContent.variant`），于是与图标那两项一样要钉：
// 绑到被右击的那张卡、能力缺失时整项不出现。区别在它是**开关** ——
// 视图侧收的只是"切哪一张"，"变深色还是变浅色"已经由卡片定义写进标题
// （见 `note.test.ts`），绑定层不该再猜一次方向。
// ─────────────────────────────────────────────────────────────

const NOTE_VARIANT_ITEM = {
  id: 'note-variant',
  title: 'Dark note',
  action: 'toggleNoteVariant',
} as const;

describe('buildCardMenuSpec × 深色便签（O06）', () => {
  const target = createCard('note', { content: { md: 'hi' } });

  it('toggleNoteVariant：绑定到被右击的那张卡（不收"切成哪种"，只收 id）', () => {
    const toggleNoteVariant = vi.fn();
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ toggleNoteVariant }),
      typeItems: [NOTE_VARIANT_ITEM],
    });

    const item = spec.find((entry) => entry.id === 'note-variant');
    expect(item).toBeDefined();
    item?.run?.();
    expect(toggleNoteVariant).toHaveBeenCalledWith(target.id);
    expect(toggleNoteVariant).toHaveBeenCalledTimes(1);
  });

  it('视图没提供能力 → 整项不出现（不留点了没反应的死项）', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      typeItems: [NOTE_VARIANT_ITEM],
    });
    expect(spec.some((entry) => entry.id === 'note-variant')).toBe(false);
  });

  it('只读板：整项灰掉（改内容的事在只读板上没有例外）', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      readOnly: true,
      actions: makeActions({ toggleNoteVariant: vi.fn() }),
      typeItems: [NOTE_VARIANT_ITEM],
    });
    expect(spec.find((entry) => entry.id === 'note-variant')?.disabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 白板卡卡面图标（O10）
//
// 两个动作都改**这张卡的内容**（`BoardRefContent.icon`），所以两件事必须钉住：
// 绑到被右击的那张卡、以及能力缺失时整项不出现（不留点了没反应的死项）。
// ─────────────────────────────────────────────────────────────

const ICON_ITEM = { id: 'board-icon', title: 'Add icon', action: 'pickBoardIcon' } as const;
const ICON_CLEAR_ITEM = {
  id: 'board-icon-clear',
  title: 'Remove icon',
  action: 'clearBoardIcon',
} as const;

describe('buildCardMenuSpec × 白板卡图标（O10）', () => {
  const target = createCard('boardRef', {
    content: { path: 'Boards/子板.nboard', preview: 'thumb', showCount: true },
  });

  it('pickBoardIcon：绑定到被右击的那张卡', () => {
    const pickBoardIcon = vi.fn();
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ pickBoardIcon }),
      typeItems: [ICON_ITEM],
    });

    const item = spec.find((entry) => entry.id === 'board-icon');
    expect(item).toBeDefined();
    item?.run?.();
    expect(pickBoardIcon).toHaveBeenCalledWith(target.id);
  });

  it('clearBoardIcon：绑定到被右击的那张卡', () => {
    const clearBoardIcon = vi.fn();
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ clearBoardIcon }),
      typeItems: [ICON_CLEAR_ITEM],
    });

    const item = spec.find((entry) => entry.id === 'board-icon-clear');
    expect(item).toBeDefined();
    item?.run?.();
    expect(clearBoardIcon).toHaveBeenCalledWith(target.id);
  });

  it('视图没提供能力 → 整项不出现（与 boardPreview 同一套约定）', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      typeItems: [ICON_ITEM, ICON_CLEAR_ITEM],
    });
    expect(spec.some((entry) => entry.id === 'board-icon' || entry.id === 'board-icon-clear')).toBe(
      false,
    );
  });

  it('★ 只读板：图标项置灰（改的是内容，不是 `openSource` 那类纯读动作）', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      readOnly: true,
      actions: makeActions({ pickBoardIcon: vi.fn(), clearBoardIcon: vi.fn() }),
      typeItems: [ICON_ITEM, ICON_CLEAR_ITEM],
    });

    expect(spec.find((entry) => entry.id === 'board-icon')?.disabled).toBe(true);
    expect(spec.find((entry) => entry.id === 'board-icon-clear')?.disabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 只读板上的菜单（T4.06 / 03 §2.5）
// ─────────────────────────────────────────────────────────────

describe('只读板 × 右键菜单（T4.06）', () => {
  const target = createCard('note', { title: '卡' });

  /** 只读板上仍然可用的项 = 没有 `disabled` 的项 */
  const enabledIds = (spec: ReturnType<typeof buildCardMenuSpec>): string[] =>
    spec.filter((entry) => entry.disabled !== true).map((entry) => entry.id);

  it('卡片菜单：会改模型的项**全部置灰**而不是消失', () => {
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      readOnly: true,
    });
    // 菜单不该变短：一排灰项 + 屏幕上的锁定提示条，才说得清"是这块板不让改"
    expect(spec.length).toBeGreaterThan(10);
    // ★ 只剩「复制」：它写的是**系统剪贴板**，`.nboard` 一个字节都不动
    //   （T4.15 —— 归档板上把一块旧板子的内容搬去新板，正是它最有用的场合）
    expect(enabledIds(spec)).toEqual(['copy']);
  });

  it('★ 卡片菜单：纯读的类型项照常可用（归档不等于断掉一切）', () => {
    const openSource = { id: 'note-ref-open', title: '打开源笔记', action: 'openSource' } as const;
    const openBoard = { id: 'board-open', title: '打开白板', action: 'openBoard' } as const;
    const fetchPreview = { id: 'link-fetch', title: '拉预览', action: 'fetchPreview' } as const;
    const relink = { id: 'note-ref-relink', title: '重新链接', action: 'relink' } as const;
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ openBoard: vi.fn(), fetchPreview: vi.fn() }),
      readOnly: true,
      typeItems: [openSource, openBoard, fetchPreview, relink],
    });

    expect(enabledIds(spec).sort()).toEqual(['board-open', 'copy', 'link-fetch', 'note-ref-open']);
    // `relink` 会把断链重新指向一个文件 —— 那也是写模型，只读板上必须灰
    expect(spec.find((entry) => entry.id === 'note-ref-relink')?.disabled).toBe(true);
  });

  it('★ 认不出来路的类型项默认置灰（宁可多灰一项，也不放一个能写的入口）', () => {
    const unknown = { id: 'mystery', title: '未知动作' } as const;
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      readOnly: true,
      typeItems: [unknown],
    });
    expect(spec.find((entry) => entry.id === 'mystery')?.disabled).toBe(true);
  });

  it('连线菜单：没有"纯读"项，整个置灰（线型 / 箭头 / 颜色 / 删除都改写模型）', () => {
    const edge = createEdge({ cardId: 'a', side: 'right' }, { cardId: 'b', side: 'left' });
    const actions: EdgeMenuActions = {
      setStyle: vi.fn(),
      setEnds: vi.fn(),
      setColor: vi.fn(),
      pickColor: vi.fn(),
      setRouting: vi.fn(),
      straighten: vi.fn(),
      editLabel: vi.fn(),
      clearLabel: vi.fn(),
      remove: vi.fn(),
    };
    const spec = buildEdgeMenuSpec({ edge, actions, readOnly: true });
    expect(spec.length).toBeGreaterThan(0);
    expect(spec.every((entry) => entry.disabled === true)).toBe(true);
  });

  it('分栏菜单：「转成编组」紧跟在「拆成多个分栏」后面，不足两张时置灰（O04）', () => {
    const actions: ColumnMenuActions = {
      rename: vi.fn(),
      toggleCollapse: vi.fn(),
      splitIntoColumns: vi.fn(),
      toGroup: vi.fn(),
      setColor: vi.fn(),
      pickColor: vi.fn(),
      remove: vi.fn(),
    };
    const column = createColumn({ title: '栏' });
    const spec = buildColumnMenuSpec({ column, memberCount: 3, actions, readOnly: false });
    const ids = spec.map((entry) => entry.id);
    // 两个方向（栏 → 多个栏 / 栏 → 编组）紧挨着摆：它们是同一件事的两种去处
    expect(ids.indexOf('column-to-group')).toBe(ids.indexOf('column-split') + 1);
    spec.find((entry) => entry.id === 'column-to-group')?.run?.();
    expect(actions.toGroup).toHaveBeenCalledWith(column.id);

    // 编组至少两张（单成员组会被自动解散）→ 一张卡的栏点下去等于没点
    const one = buildColumnMenuSpec({ column, memberCount: 1, actions, readOnly: false });
    expect(one.find((entry) => entry.id === 'column-to-group')?.disabled).toBe(true);
  });

  it('分栏菜单：连"折叠"也置灰（collapsed 会写进 .nboard，不是纯界面状态）', () => {
    const actions: ColumnMenuActions = {
      rename: vi.fn(),
      toggleCollapse: vi.fn(),
      splitIntoColumns: vi.fn(),
      toGroup: vi.fn(),
      setColor: vi.fn(),
      pickColor: vi.fn(),
      remove: vi.fn(),
    };
    const spec = buildColumnMenuSpec({
      column: createColumn({ title: '栏' }),
      memberCount: 3,
      actions,
      readOnly: true,
    });
    expect(spec.every((entry) => entry.disabled === true)).toBe(true);
  });

  it('画布菜单：只读时创建项一个都不出现，"看"的动作与解锁留着', () => {
    const spec = buildCanvasMenuSpec({
      // 视图在只读板上就是这么调的：那几个会改模型的根本不传
      selectAll: vi.fn(),
      fitContent: vi.fn(),
      zoomReset: vi.fn(),
      unlockBoard: vi.fn(),
    });
    expect(spec.map((entry) => entry.id)).toEqual([
      'select-all',
      'fit-content',
      'zoom-reset',
      'unlock-board',
    ]);
  });

  it('画布菜单：可写时给出创建项，并只给"锁定"这一个方向', () => {
    const spec = buildCanvasMenuSpec({
      newNote: vi.fn(),
      draw: vi.fn(),
      selectAll: vi.fn(),
      fitContent: vi.fn(),
      zoomReset: vi.fn(),
      lockBoard: vi.fn(),
    });
    const ids = spec.map((entry) => entry.id);
    expect(ids).toContain('new-note');
    expect(ids).toContain('draw');
    expect(ids).toContain('lock-board');
    // 没锁的板上不该出现"解锁"：那一行点了必定失败
    expect(ids).not.toContain('unlock-board');
  });

  it('★ 画布菜单：「新建便签」留在最上面，其余"空白纸"收进「更多卡片」子菜单（`C2`）', () => {
    const newSyncNote = vi.fn();
    const newComment = vi.fn();
    const spec = buildCanvasMenuSpec({
      newNote: vi.fn(),
      newSyncNote,
      newComment,
      selectAll: vi.fn(),
      fitContent: vi.fn(),
      zoomReset: vi.fn(),
    });

    // 最常见的那个动作**不多点一次**：它不进子菜单
    expect(spec[0]?.id).toBe('new-note');

    const more = spec.find((item) => item.id === 'new-cards');
    expect(more).toBeDefined();
    const children = more?.children ?? [];
    expect(children.map((entry) => entry.id)).toEqual(['new-sync-note', 'new-comment']);

    // 挪进子菜单不该把动作弄丢（`run` 要跟着走）
    children.find((entry) => entry.id === 'new-sync-note')?.run?.();
    expect(newSyncNote).toHaveBeenCalledTimes(1);
    children.find((entry) => entry.id === 'new-comment')?.run?.();
    expect(newComment).toHaveBeenCalledTimes(1);
  });

  it('★ 画布菜单：「更多卡片」里也摆着新增的四张卡（`A1`–`A4`）', () => {
    const spec = buildCanvasMenuSpec({
      newNote: vi.fn(),
      newTitleCard: vi.fn(),
      newGallery: vi.fn(),
      newVideo: vi.fn(),
      newAudio: vi.fn(),
      selectAll: vi.fn(),
      fitContent: vi.fn(),
      zoomReset: vi.fn(),
    });

    const children = (spec.find((item) => item.id === 'new-cards')?.children ?? []).map(
      (entry) => entry.id,
    );
    expect(children).toEqual(['new-title-card', 'new-gallery', 'new-video', 'new-audio']);
  });

  it('画布菜单：只读板上"空白纸"一项都不出现（连「更多卡片」那一格也没有）', () => {
    const spec = buildCanvasMenuSpec({
      selectAll: vi.fn(),
      fitContent: vi.fn(),
      zoomReset: vi.fn(),
    });
    const ids = spec.map((entry) => entry.id);
    expect(ids).not.toContain('new-note');
    expect(ids).not.toContain('new-cards');
    // 一个子项都绑不上 ⇒ 整组不出现（规格层给的是空 `children`，`bindCardMenuItems` 会丢掉它）
    expect((spec.find((entry) => entry.id === 'new-cards')?.children ?? []).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 重置旋转（T7.06 / `F2-00-10`）
//
// 菜单里只有"回正"这一项：转多少度有手柄（拖手柄 + `⇧` 吸附到 15°），
// 菜单里再摆一排角度只是把同一个能力说两遍。三条"不出现"的规矩各有理由，
// 而且都只能在这里钉住 —— 规格层返回的是一个数组，缺项与多一项都看不出来。
// ─────────────────────────────────────────────────────────────

describe('buildCardMenuSpec · 重置旋转', () => {
  it('转过的卡片：出现，且绑到被右击的**那张**卡上', () => {
    const resetRotation = vi.fn();
    const target = { ...createCard('note'), rotation: 30 };
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ resetRotation }),
      typeItems: [],
    });

    const entry = spec.find((item) => item.id === 'reset-rotation');
    expect(entry).toBeDefined();
    entry?.run?.();
    expect(resetRotation).toHaveBeenCalledWith(target.id);
  });

  it('★ 没转过的卡片：整项**不出现**（而不是留一个永远点不动的灰项）', () => {
    const target = createCard('note');
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions({ resetRotation: vi.fn() }),
      typeItems: [],
    });

    expect(spec.some((item) => item.id === 'reset-rotation')).toBe(false);
  });

  it('★ 多选时不给：旋转本身没有多选语义，"重置哪一张"没有答案', () => {
    const target = { ...createCard('note'), rotation: 30 };
    const other = { ...createCard('note'), id: 'other', rotation: 15 };
    const spec = buildCardMenuSpec({
      selection: [target, other],
      target,
      actions: makeActions({ resetRotation: vi.fn() }),
      typeItems: [],
    });

    expect(spec.some((item) => item.id === 'reset-rotation')).toBe(false);
  });

  it('视图没接这个能力（只读板 / 嵌入视图）→ 不出现，而不是点了没反应', () => {
    const target = { ...createCard('note'), rotation: 30 };
    const spec = buildCardMenuSpec({
      selection: [target],
      target,
      actions: makeActions(),
      typeItems: [],
    });

    expect(spec.some((item) => item.id === 'reset-rotation')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 卡片菜单 · 「排列与编组」子菜单（`C2`，用户 2026-09-18："右键菜单整理"）
// ─────────────────────────────────────────────────────────────

describe('buildCardMenuSpec · 排列与编组（C2）', () => {
  const specOf = (count: number, actions: ReturnType<typeof makeActions>) => {
    const target = createCard('note');
    const selection = [
      target,
      ...Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
        ...createCard('note'),
        id: `c_${index}`,
      })),
    ];
    return buildCardMenuSpec({ selection, target, actions, typeItems: [] });
  };

  const arrangeChildrenOf = (spec: ReturnType<typeof buildCardMenuSpec>) =>
    (spec.find((item) => item.id === 'arrange')?.children ?? []).map((item) => item.id);

  it('★ 对齐 / 分布 / 编组 / 分栏四类都收进 `arrange`，一级菜单里不再各占一行', () => {
    const spec = specOf(
      3,
      makeActions({
        align: vi.fn(),
        distribute: vi.fn(),
        group: vi.fn(),
        ungroup: vi.fn(),
        collectIntoColumn: vi.fn(),
        splitIntoColumns: vi.fn(),
      }),
    );

    const topLevel = spec.map((item) => item.id);
    for (const id of [
      'align-left',
      'distribute-x',
      'group',
      'ungroup',
      'collect-into-column',
      'split-into-columns',
    ]) {
      expect(topLevel, id).not.toContain(id);
    }

    const children = arrangeChildrenOf(spec);
    expect(children).toContain('align-left');
    expect(children).toContain('distribute-x');
    expect(children).toContain('group');
    expect(children).toContain('split-into-columns');
  });

  it('一张卡：对齐与分布整批不出现（谈不上对齐），拆栏还在但置灰（至少要两张）', () => {
    const spec = specOf(
      1,
      makeActions({
        align: vi.fn(),
        distribute: vi.fn(),
        collectIntoColumn: vi.fn(),
        splitIntoColumns: vi.fn(),
      }),
    );

    const children = arrangeChildrenOf(spec);
    expect(children).not.toContain('align-left');
    expect(children).not.toContain('distribute-x');
    expect(children).toContain('split-into-columns');

    const split = spec
      .find((item) => item.id === 'arrange')
      ?.children?.find((item) => item.id === 'split-into-columns');
    expect(split?.disabled).toBe(true);
  });
});
