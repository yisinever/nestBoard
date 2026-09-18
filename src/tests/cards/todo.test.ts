/**
 * 待办卡单元测试（T3.01 / T3.02 / `F2.6`）。
 *
 * 渲染要在真环境里验，这里钉住四件容易出错、且都能在 node 下判死的事：
 *   1. **Markdown 往返**（T3.02）：`todoToMarkdown` / `markdownToTodo` 必须互为反函数 ——
 *      否则"编辑一下再退出"就会悄悄吃掉用户的字；
 *   2. **缩进编码**：`TodoItem` 没有 `depth`，层级只能藏在 `text` 的前导空白里，
 *      于是"往返恒等"和"层级推得对"是同一条不变量的两面；
 *   3. **勾选只改模型**：点复选框必须 `preventDefault`（视觉由重画决定），
 *      否则只读板上会出现"勾上了但没存"的假象；
 *   4. **编辑态的两格怎么收口**（O02）：标题框与清单**只能在整次编辑结束时**
 *      合成一次 patch 落盘 —— 每写一次模型就会清掉编辑态（`updateCardContent`），
 *      收早了用户看到的是"点一下标题，清单没了"。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  TODO_DEFAULT_SIZE,
  countTodoDone,
  isCompletedCollapsed,
  markdownToTodo,
  setCompletedCollapsed,
  splitTodoIndent,
  todoCard,
  todoDepth,
  todoToMarkdown,
  toggleTodoItem,
} from '../../cards/todo';
import type { CardRenderContext } from '../../cards/registry';
import { createCard } from '../../model/factories';
import type { TodoContent, TodoItem } from '../../model/schema';
import { t } from '../../util/i18n';
import {
  type FakeDocument,
  type FakeElement,
  type FakeTextarea,
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
} from '../helpers/fakeDom';

// ── 纯逻辑 ────────────────────────────────────────────────────

describe('splitTodoIndent / todoDepth', () => {
  it('拆出前导空白与正文', () => {
    expect(splitTodoIndent('  买牛奶')).toEqual({ indent: '  ', body: '买牛奶' });
    expect(splitTodoIndent('无缩进')).toEqual({ indent: '', body: '无缩进' });
  });

  it('2 个空格算一级，Tab 也算一级', () => {
    expect(todoDepth('顶级')).toBe(0);
    expect(todoDepth('  一级')).toBe(1);
    expect(todoDepth('    二级')).toBe(2);
    expect(todoDepth('\t一 Tab')).toBe(1);
  });

  it('层级封顶：再深的缩进不再往下挤正文', () => {
    expect(todoDepth('            '.repeat(1) + '  超深')).toBe(6);
  });

  it('单个空格不算一级（手打的零碎空白不该变成层级）', () => {
    expect(todoDepth(' 半级')).toBe(0);
  });
});

describe('countTodoDone / toggleTodoItem', () => {
  const items: TodoItem[] = [
    { text: 'a', done: false },
    { text: 'b', done: true },
    { text: 'c', done: true },
  ];

  it('数出已完成项', () => {
    expect(countTodoDone(items)).toBe(2);
    expect(countTodoDone([])).toBe(0);
  });

  it('取反指定项且不改原数组', () => {
    const next = toggleTodoItem(items, 0);
    expect(next[0].done).toBe(true);
    expect(items[0].done).toBe(false);
    expect(next[1]).toBe(items[1]);
  });

  it('下标越界时原样返回（点击与重画之间不能假设还同步）', () => {
    expect(toggleTodoItem(items, 99)).toEqual(items);
    expect(toggleTodoItem(items, -1)).toEqual(items);
  });
});

describe('todoToMarkdown', () => {
  it('按标准任务语法逐行写出，勾选态用 `x`', () => {
    const content: TodoContent = {
      title: '',
      items: [
        { text: '买牛奶', done: false },
        { text: '遛狗', done: true },
      ],
    };
    expect(todoToMarkdown(content)).toBe('- [ ] 买牛奶\n- [x] 遛狗');
  });

  it('把 `text` 里的前导空白还原成缩进', () => {
    const content: TodoContent = {
      title: '',
      items: [
        { text: '父项', done: false },
        { text: '  子项', done: false },
      ],
    };
    expect(todoToMarkdown(content)).toBe('- [ ] 父项\n  - [ ] 子项');
  });

  it('有标题时写成 `# 标题` + 空行', () => {
    const content: TodoContent = { title: '本周', items: [{ text: 'a', done: false }] };
    expect(todoToMarkdown(content)).toBe('# 本周\n\n- [ ] a');
  });

  it('空清单也能安全序列化', () => {
    expect(todoToMarkdown({ title: '', items: [] })).toBe('');
  });
});

describe('markdownToTodo', () => {
  it('解析任务行（含 `*` / `+` 变体与大小写 `x`）', () => {
    expect(markdownToTodo('- [ ] a\n* [x] b\n+ [X] c')).toEqual({
      title: '',
      items: [
        { text: 'a', done: false },
        { text: 'b', done: true },
        { text: 'c', done: true },
      ],
    });
  });

  it('空任务项（`- [ ]`）也能解析成一项', () => {
    expect(markdownToTodo('- [ ]')).toEqual({
      title: '',
      items: [{ text: '', done: false }],
    });
  });

  it('留出缩进给 `text`：往返不丢层级', () => {
    expect(markdownToTodo('- [ ] 父\n  - [x] 子').items).toEqual([
      { text: '父', done: false },
      { text: '  子', done: true },
    ]);
  });

  it('普通列表行收成未勾选项，标记剥掉', () => {
    expect(markdownToTodo('- 只写了个破折号').items).toEqual([
      { text: '只写了个破折号', done: false },
    ]);
  });

  it('裸文本行也收下：只想列几行字的人不该被迫先打 `- `', () => {
    expect(markdownToTodo('买菜\n接孩子').items).toEqual([
      { text: '买菜', done: false },
      { text: '接孩子', done: false },
    ]);
  });

  it('空行跳过', () => {
    expect(markdownToTodo('- [ ] a\n\n\n- [ ] b').items).toHaveLength(2);
  });

  it('首个非空行是 `# 标题` 时当标题，且不作为待办项', () => {
    expect(markdownToTodo('# 本周\n- [ ] a')).toEqual({
      title: '本周',
      items: [{ text: 'a', done: false }],
    });
  });

  it('正文中间的 `# xxx` 不是标题（只有首行有资格）', () => {
    expect(markdownToTodo('- [ ] a\n# 这是内容').items).toEqual([
      { text: 'a', done: false },
      { text: '# 这是内容', done: false },
    ]);
  });
});

describe('Markdown 往返（T3.02 的核心不变量）', () => {
  it('内容 → Markdown → 内容 是恒等的', () => {
    const content: TodoContent = {
      title: '发布清单',
      items: [
        { text: '改版本号', done: true },
        { text: '  跑测试', done: false },
        { text: '', done: false },
      ],
    };
    expect(markdownToTodo(todoToMarkdown(content))).toEqual(content);
  });

  it('Markdown → 内容 → Markdown 在正规输入上恒等', () => {
    const markdown = '# 发布清单\n\n- [x] 改版本号\n  - [ ] 跑测试';
    expect(todoToMarkdown(markdownToTodo(markdown))).toBe(markdown);
  });
});

// ── 卡片定义契约 ──────────────────────────────────────────────

describe('todoCard 定义', () => {
  it('暴露类型 / 默认尺寸 / 默认内容', () => {
    expect(todoCard.type).toBe('todo');
    expect(todoCard.defaultSize).toEqual(TODO_DEFAULT_SIZE);
    expect(todoCard.createDefaultContent()).toEqual({ title: '', items: [] });
  });

  it('显示名走 i18n', () => {
    expect(todoCard.displayName).toBe(t('card.type.todo'));
  });

  it('导出为 Markdown 用标准任务语法', () => {
    const card = createCard('todo', {
      content: { title: '', items: [{ text: 'a', done: true }] },
    });
    expect(todoCard.toMarkdown?.(card, { sourcePath: '' })).toBe('- [x] a');
  });
});

// ── 渲染 ──────────────────────────────────────────────────────

function renderTodo(
  content: TodoContent,
  overrides: Partial<CardRenderContext> = {},
): { el: FakeElement; card: ReturnType<typeof createCard<'todo'>>; doc: FakeDocument } {
  const doc = createFakeDocument();
  const el = createFakeElement(doc);
  const card = createCard('todo', { content });
  todoCard.render(el as unknown as HTMLElement, card, {
    sourcePath: '',
    ...overrides,
  } as unknown as CardRenderContext);
  return { el, card, doc };
}

/** `el.children[0]` 的列表容器（本定义总是先画列表） */
function listOf(el: FakeElement): FakeElement {
  return el.children[0] as FakeElement;
}

describe('渲染：显示态', () => {
  it('空清单 → 引导文案 + 占位标记', () => {
    const { el } = renderTodo({ title: '', items: [] });
    expect(el.classList.contains('is-empty')).toBe(true);
    expect(el.dataset.placeholder).toBe('true');
    expect((el.children[0] as FakeElement).textContent).toBe(t('card.todo.empty'));
  });

  it('逐项画复选框，完成项带 `is-done`', () => {
    const { el } = renderTodo({
      title: '',
      items: [
        { text: 'a', done: false },
        { text: 'b', done: true },
      ],
    });
    const rows = listOf(el).children as FakeElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].classList.contains('is-done')).toBe(false);
    expect(rows[1].classList.contains('is-done')).toBe(true);
  });

  it('缩进写成 `--nestboard-todo-depth` 行内样式', () => {
    const { el } = renderTodo({
      title: '',
      items: [
        { text: '父', done: false },
        { text: '  子', done: false },
      ],
    });
    const rows = listOf(el).children as FakeElement[];
    expect(rows[0].style.getPropertyValue('--nestboard-todo-depth')).toBe('0');
    expect(rows[1].style.getPropertyValue('--nestboard-todo-depth')).toBe('1');
  });

  it('有标题时先画标题', () => {
    const { el } = renderTodo({ title: '本周', items: [{ text: 'a', done: false }] });
    expect((el.children[0] as FakeElement).textContent).toBe('本周');
  });
});

describe('渲染：勾选只改模型', () => {
  it('点复选框 → `updateContent` 收到取反后的清单，并阻止默认行为', () => {
    const updateContent = vi.fn();
    const { el } = renderTodo(
      {
        title: '',
        items: [
          { text: 'a', done: false },
          { text: 'b', done: true },
        ],
      },
      { mode: 'display', updateContent } as unknown as Partial<CardRenderContext>,
    );

    const box = listOf(el).children[0] as unknown as FakeElement;
    const checkbox = (box as unknown as { children: FakeElement[] }).children[0];
    const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    checkbox.emit('click', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(updateContent).toHaveBeenCalledWith({
      items: [
        { text: 'a', done: true },
        { text: 'b', done: true },
      ],
    });
  });

  it('指针按下不冒泡给画布（否则勾一下会顺手把卡片拖走）', () => {
    const { el } = renderTodo({ title: '', items: [{ text: 'a', done: false }] });
    const row = listOf(el).children[0] as unknown as FakeElement;
    const checkbox = (row as unknown as { children: FakeElement[] }).children[0];
    const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    checkbox.emit('pointerdown', event);
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});

describe('渲染：已完成折叠', () => {
  it('有完成项时给出折叠开关，点击只切类不写模型', () => {
    const updateContent = vi.fn();
    const { el, card } = renderTodo(
      {
        title: '',
        items: [
          { text: 'a', done: false },
          { text: 'b', done: true },
        ],
      },
      { mode: 'display', updateContent } as unknown as Partial<CardRenderContext>,
    );

    setCompletedCollapsed(card.id, false);
    const list = listOf(el);
    const toggle = el.children[1] as FakeElement;
    expect((toggle.children[1] as FakeElement).textContent).toBe(
      t('card.todo.completed', { count: 1 }),
    );

    toggle.emit('click', { stopPropagation: vi.fn(), preventDefault: vi.fn() });

    expect(list.classList.contains('is-hide-done')).toBe(true);
    expect(isCompletedCollapsed(card.id)).toBe(true);
    // 折叠纯属显示偏好：绝不能顺手改内容
    expect(updateContent).not.toHaveBeenCalled();
  });

  it('折叠状态活过重画', () => {
    const content: TodoContent = {
      title: '',
      items: [
        { text: 'a', done: false },
        { text: 'b', done: true },
      ],
    };
    const first = renderTodo(content);
    setCompletedCollapsed(first.card.id, true);
    const again = renderTodo(content);
    // 换一张卡就是默认展开；同一张卡（同 id）才是折叠
    expect(listOf(again.el).classList.contains('is-hide-done')).toBe(false);

    const sameCardDoc = createFakeDocument();
    const sameEl = createFakeElement(sameCardDoc);
    setCompletedCollapsed(first.card.id, true);
    todoCard.render(sameEl as unknown as HTMLElement, first.card, {
      sourcePath: '',
    } as unknown as CardRenderContext);
    expect(listOf(sameEl).classList.contains('is-hide-done')).toBe(true);
  });

  it('没有完成项时不给折叠开关', () => {
    const { el } = renderTodo({ title: '', items: [{ text: 'a', done: false }] });
    expect(el.children).toHaveLength(1);
  });
});

describe('渲染：编辑态', () => {
  /** 编辑态的默认入口就是两格：标题框 + 清单编辑器（O02） */
  function splitEdit(
    content: TodoContent,
    overrides: Partial<CardRenderContext> = {},
  ): {
    el: FakeElement;
    input: FakeElement;
    textarea: FakeTextarea;
    updateContent: ReturnType<typeof vi.fn>;
    setMode: ReturnType<typeof vi.fn>;
  } {
    const updateContent = vi.fn();
    const setMode = vi.fn();
    const { el } = renderTodo(content, {
      mode: 'edit',
      updateContent,
      setMode,
      ...overrides,
    } as unknown as Partial<CardRenderContext>);
    return {
      el,
      input: el.children[0] as unknown as FakeElement,
      textarea: (el.children[1] as FakeElement).children[0] as unknown as FakeTextarea,
      updateContent,
      setMode,
    };
  }

  it('两格各管一块：标题进标题框，清单里没有 `# 标题` 那一行', () => {
    const { input, textarea } = splitEdit({
      title: '本周',
      items: [{ text: 'a', done: true }],
    });
    expect(input.value).toBe('本周');
    expect(textarea.value).toBe('- [x] a');
  });

  it('光标先落在标题框上（清单那格不抢）', () => {
    const { input, textarea } = splitEdit({ title: '本周', items: [{ text: 'a', done: false }] });
    expect(input.focused).toBe(true);
    expect(textarea.focused).toBe(false);
  });

  it('标题框按 Enter → 焦点交给清单，且**不提交**（写进模型就等于这次编辑结束了）', async () => {
    const { input, textarea, updateContent, setMode } = splitEdit({
      title: '',
      items: [{ text: 'a', done: false }],
    });
    input.value = '写了一半';
    input.emit('keydown', createKeyEvent({ key: 'Enter' }));
    // 编辑器的 focus() 故意延后一轮微任务（渲染瞬间节点还没进文档）
    await Promise.resolve();

    expect(textarea.focused).toBe(true);
    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
  });

  it('输入法组词中的 Enter 不算"往下走"（否则选字选到一半光标就跑了）', async () => {
    const { input, textarea } = splitEdit({ title: '', items: [{ text: 'a', done: false }] });
    input.emit('keydown', createKeyEvent({ key: 'Enter', isComposing: true }));
    input.emit('keydown', createKeyEvent({ key: 'Enter', keyCode: 229 }));
    await Promise.resolve();

    expect(textarea.focused).toBe(false);
  });

  it('标题框失焦且焦点离开卡片 → 标题与清单**一次 patch** 落盘，并回显示态', () => {
    const items = [{ text: 'a', done: false }];
    const { input, textarea, updateContent, setMode } = splitEdit({ title: '旧', items });
    input.value = '新标题';
    textarea.value = '- [ ] a\n- [ ] b';
    input.emit('blur', { relatedTarget: null });

    expect(updateContent).toHaveBeenCalledTimes(1);
    expect(updateContent).toHaveBeenCalledWith({
      title: '新标题',
      items: [
        { text: 'a', done: false },
        { text: 'b', done: false },
      ],
    });
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('焦点只在卡内换格（清单 → 标题）→ 不提交、不退出', () => {
    const { input, textarea, updateContent, setMode } = splitEdit({
      title: '旧',
      items: [{ text: 'a', done: false }],
    });
    textarea.value = '- [ ] a\n- [ ] b';
    // 目标节点是同一张卡里的标题框 —— 这正是 `keepEditingOnBlur` 要放行的那一下
    textarea.emit('blur', { relatedTarget: input });

    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
  });

  it('焦点在卡内换格后标题框失焦 → 清单那格的字照样收下', () => {
    const { input, textarea, updateContent } = splitEdit({
      title: '旧',
      items: [{ text: 'a', done: false }],
    });
    textarea.value = '- [ ] a\n- [ ] b';
    textarea.emit('blur', { relatedTarget: input });
    input.emit('blur', { relatedTarget: null });

    expect(updateContent).toHaveBeenCalledWith({
      title: '旧',
      items: [
        { text: 'a', done: false },
        { text: 'b', done: false },
      ],
    });
  });

  it('★ 落过盘之后不再写第二遍（清单提交完，标题框还会补一个 blur 上来）', () => {
    const { input, textarea, updateContent } = splitEdit({
      title: '旧',
      items: [{ text: 'a', done: false }],
    });
    textarea.value = '- [ ] a\n- [ ] b';
    // 清单那格失焦且焦点离开卡片 → 收下（这一次是这次编辑唯一的写入）
    textarea.emit('blur', { relatedTarget: null });
    expect(updateContent).toHaveBeenCalledTimes(1);

    // 重绘会把节点换掉，浏览器/编辑器随即再补一个 blur；第二次写拦不住的话
    // （`items` 是新解析出来的数组，按引用比永远算"变了"）会多一步 ⌘Z
    input.emit('blur', { relatedTarget: null });
    expect(updateContent).toHaveBeenCalledTimes(1);
  });

  it('标题框按 Esc → 放弃**这一格**，清单那格照旧收下', () => {
    const { input, textarea, updateContent, setMode } = splitEdit({
      title: '原名',
      items: [{ text: 'a', done: false }],
    });
    input.value = '改了一半';
    textarea.value = '- [ ] a\n- [ ] b';
    input.emit('keydown', createKeyEvent({ key: 'Escape' }));

    expect(updateContent).toHaveBeenCalledWith({
      title: '原名',
      items: [
        { text: 'a', done: false },
        { text: 'b', done: false },
      ],
    });
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('清单里手写 `# 标题`，标题框空着 → 它成为标题（源码习惯不该丢字）', () => {
    const { input, textarea, updateContent } = splitEdit({ title: '', items: [] });
    input.value = '';
    textarea.value = '# 手写的标题\n- [ ] a';
    input.emit('blur', { relatedTarget: null });

    expect(updateContent).toHaveBeenCalledWith({
      title: '手写的标题',
      items: [{ text: 'a', done: false }],
    });
  });

  it('点进点出（一个字没改）不会把文件标脏', () => {
    const { input, updateContent, setMode } = splitEdit({
      title: '本周',
      items: [{ text: 'a', done: true }],
    });
    input.emit('blur', { relatedTarget: null });

    expect(updateContent).not.toHaveBeenCalled();
    expect(setMode).toHaveBeenCalledWith('display');
  });

  it('`⌘`+双击那条路（`editEntry: raw`）仍是整份源码一块 textarea', async () => {
    const updateContent = vi.fn();
    const setMode = vi.fn();
    const { el } = renderTodo({ title: '本周', items: [{ text: 'a', done: true }] }, {
      mode: 'edit',
      editEntry: 'raw',
      updateContent,
      setMode,
    } as unknown as Partial<CardRenderContext>);
    // 老路只有一格：textarea 直接挂在内容槽上，没有标题框
    const textarea = el.children[0] as unknown as FakeTextarea;
    await Promise.resolve();

    expect(textarea.value).toBe('# 本周\n\n- [x] a');
    expect(textarea.focused).toBe(true);
    // 提交的还是"整份源码解析回来的内容"
    textarea.value = '# 改过\n\n- [ ] a';
    textarea.emit('keydown', createKeyEvent({ key: 'Enter', metaKey: true }));
    expect(updateContent).toHaveBeenCalledWith({
      title: '改过',
      items: [{ text: 'a', done: false }],
    });
  });
});
