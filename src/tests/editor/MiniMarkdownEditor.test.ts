/**
 * 轻量 Markdown 编辑器单元测试（T1.33 / `F2.1`）。
 *
 * 这个文件钉两类东西：
 *
 *  1. **行 / 块文法**（纯函数）：`* ` 变 `- `、`3. ` 续成 `4. `、围栏内不当列表……
 *     这些是"看着对、用起来错"的重灾区，必须逐条钉死；
 *  2. **编辑会话**：提交/取消只认第一次、没改不写模型 —— 直接决定白板文件会不会
 *     被"点进点出"标脏。
 *
 * 假 DOM 见 `helpers/fakeDom.ts`：它忠实地实现 `execCommand('insertText')`，
 * 所以生产路径（原生插入）与降级路径（直接改写）都能被覆盖到。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  INDENT_UNIT,
  MiniMarkdownEditor,
  fenceMask,
  indentLines,
  isBlankItem,
  locateLine,
  nextLineMarker,
  outdentLines,
  parseLine,
  resolveInputRule,
  shouldIndentOnTab,
  shouldOutdentOnTab,
} from '../../editor/MiniMarkdownEditor';
import { t } from '../../util/i18n';
import {
  createFakeDocument,
  createFakeElement,
  createKeyEvent,
  type FakeKeyEventInit,
  type FakeTextarea,
} from '../helpers/fakeDom';

// ── 挂载助手 ──────────────────────────────────────────────────

function mount(
  value = '',
  options: {
    withExecCommand?: boolean;
    /** 待办卡的"两格编辑态"用它拦下"换一格"的那次失焦（O02） */
    keepEditingOnBlur?: (event: FocusEvent) => boolean;
  } = {},
) {
  const doc = createFakeDocument({ withExecCommand: options.withExecCommand ?? true });
  const host = createFakeElement(doc);
  const onSubmit = vi.fn();
  const onExit = vi.fn();
  const editor = new MiniMarkdownEditor({
    host: host as unknown as HTMLElement,
    value,
    onSubmit,
    onExit,
    keepEditingOnBlur: options.keepEditingOnBlur,
  });
  const textarea = host.children[0] as FakeTextarea;

  /** 模拟"用户在这个输入框里按键"：真人按下键盘时它必然已经聚焦 */
  const press = (init: FakeKeyEventInit) => {
    textarea.focus();
    const event = createKeyEvent(init);
    textarea.emit('keydown', event);
    return event;
  };

  /** 直接改写内容与光标，模拟"用户已经敲进去的文本" */
  const edit = (nextValue: string, caret: number) => {
    textarea.value = nextValue;
    textarea.setSelectionRange(caret, caret);
  };

  return { editor, host, textarea, onSubmit, onExit, doc, press, edit };
}

// ── 行 / 块文法 ───────────────────────────────────────────────

describe('parseLine', () => {
  it('识别无序 / 有序 / 待办 / 引用，并把缩进原样留在外面', () => {
    expect(parseLine('- 条目')).toMatchObject({ kind: 'bullet', indent: '', marker: '- ' });
    expect(parseLine('  - 条目')).toMatchObject({ kind: 'bullet', indent: '  ', contentStart: 4 });
    expect(parseLine('1. 条目')).toMatchObject({ kind: 'ordered', marker: '1. ' });
    expect(parseLine('10) 条目')).toMatchObject({ kind: 'ordered', marker: '10) ' });
    expect(parseLine('- [x] 完成')).toMatchObject({ kind: 'task', marker: '- [x] ' });
    expect(parseLine('> 引用')).toMatchObject({ kind: 'quote', marker: '> ' });
  });

  it('识别标题与围栏', () => {
    expect(parseLine('## 标题')).toMatchObject({ kind: 'heading', marker: '## ', contentStart: 3 });
    expect(parseLine('```js')).toMatchObject({ kind: 'fence', marker: '```' });
  });

  it('`#标题` 不是标题（CommonMark 要求标记后有空白），7 个 # 也不是', () => {
    expect(parseLine('#标题').kind).toBe('plain');
    expect(parseLine('####### 七级').kind).toBe('plain');
  });

  it('普通段落就是 plain，不会把行中的 `- ` 当成列表', () => {
    expect(parseLine('今天 - 明天').kind).toBe('plain');
  });
});

describe('fenceMask', () => {
  it('开标记行算外部、闭标记行算内部 —— 两侧的按键行为都要走不同分支', () => {
    expect(fenceMask(['```', '代码', '```', '之後'])).toEqual([false, true, true, false]);
  });

  it('没闭合就一直算在内部（用户还在写代码块）', () => {
    expect(fenceMask(['```', '代码', '还是代码'])).toEqual([false, true, true]);
  });

  it('~~ 围栏同样识别，且更长的围栏可以关闭更短的', () => {
    expect(fenceMask(['~~~', 'a', '~~~'])).toEqual([false, true, true]);
    expect(fenceMask(['```', 'a', '````', 'b'])).toEqual([false, true, true, false]);
  });

  it('普通文本没有围栏', () => {
    expect(fenceMask(['abc', 'def'])).toEqual([false, false]);
  });
});

describe('resolveInputRule（行首快捷输入）', () => {
  it('把非规范标记改写成规范写法', () => {
    expect(resolveInputRule('*')).toBe('- ');
    expect(resolveInputRule('  +')).toBe(`${INDENT_UNIT}- `);
    expect(resolveInputRule('1)')).toBe('1. ');
    expect(resolveInputRule('[ ]')).toBe('- [ ] ');
    expect(resolveInputRule('[X]')).toBe('- [x] ');
    expect(resolveInputRule('#######')).toBe('###### ');
  });

  it('已经规范的标记不动，行中的标记也不动', () => {
    expect(resolveInputRule('-')).toBeNull();
    expect(resolveInputRule('#')).toBeNull();
    expect(resolveInputRule('abc*')).toBeNull();
    expect(resolveInputRule('今天 -')).toBeNull();
  });
});

describe('续行与退出', () => {
  it('各类列表都续行，有序序号 +1', () => {
    expect(nextLineMarker(parseLine('- a'))).toBe('- ');
    expect(nextLineMarker(parseLine('  1. a'))).toBe('  2. ');
    expect(nextLineMarker(parseLine('9. a'))).toBe('10. ');
    expect(nextLineMarker(parseLine('- [x] a'))).toBe('- [ ] ');
    expect(nextLineMarker(parseLine('> a'))).toBe('> ');
  });

  it('标题与普通段落不续行', () => {
    expect(nextLineMarker(parseLine('# a'))).toBeNull();
    expect(nextLineMarker(parseLine('正文'))).toBeNull();
  });

  it('标记后面没内容 = 空项，回车应当退出而不是继续', () => {
    expect(isBlankItem('- ', parseLine('- '))).toBe(true);
    expect(isBlankItem('  > ', parseLine('  > '))).toBe(true);
    expect(isBlankItem('- a', parseLine('- a'))).toBe(false);
    // 标题不是"可退出的项"，空标题回车仍应换行
    expect(isBlankItem('# ', parseLine('# '))).toBe(false);
  });
});

describe('缩进', () => {
  it('单行缩进：选区跟着右移一级', () => {
    expect(indentLines('- a', 0, 0)).toEqual({
      value: `${INDENT_UNIT}- a`,
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it('多行缩进：每行各加一级，选区按行数整体右移', () => {
    expect(indentLines('- a\n- b', 0, 7)).toEqual({
      value: `${INDENT_UNIT}- a\n${INDENT_UNIT}- b`,
      selectionStart: 2,
      selectionEnd: 11,
    });
  });

  it('反缩进每行最多去掉一级，顶格的行保持不变', () => {
    expect(outdentLines(`${INDENT_UNIT}- a`, 0, 0)).toEqual({
      value: '- a',
      selectionStart: 0,
      selectionEnd: 0,
    });
    expect(outdentLines('\t- a', 0, 0).value).toBe('- a');
    expect(outdentLines('顶格', 0, 0).value).toBe('顶格');
  });

  it('Tab 只接管列表项与多行选中，普通段落让位给"焦点流"（无障碍）', () => {
    expect(shouldIndentOnTab('正文', 0, 0)).toBe(false);
    expect(shouldIndentOnTab('- a', 2, 2)).toBe(true);
    expect(shouldIndentOnTab('正文\n第二行', 0, 8)).toBe(true);
  });

  it('⇧Tab 只在确实有缩进时接管', () => {
    expect(shouldOutdentOnTab(`${INDENT_UNIT}- a`, 0, 0)).toBe(true);
    expect(shouldOutdentOnTab('- a', 0, 0)).toBe(false);
  });
});

describe('locateLine', () => {
  it('定位光标所在行及其边界（含越界钳制）', () => {
    expect(locateLine('ab\ncd', 0)).toEqual({ index: 0, start: 0, end: 2 });
    expect(locateLine('ab\ncd', 3)).toEqual({ index: 1, start: 3, end: 5 });
    expect(locateLine('ab\ncd', 999)).toEqual({ index: 1, start: 3, end: 5 });
  });
});

// ── 编辑会话 ──────────────────────────────────────────────────

describe('编辑会话', () => {
  it('空卡挂引导文案，聚焦后光标在行首', async () => {
    const { textarea, editor } = mount('');
    expect(textarea.placeholder).toBe(t('card.note.placeholder'));

    editor.focus();
    await Promise.resolve();
    expect(textarea.focused).toBe(true);
    expect(textarea.selectionStart).toBe(0);
  });

  it('有内容时聚焦把光标放到末尾，而不是全选（全选会被随手一个字符覆盖）', async () => {
    const { textarea, editor } = mount('原文');
    expect(textarea.placeholder).toBe('');

    editor.focus();
    await Promise.resolve();
    expect(textarea.selectionStart).toBe(2);
  });

  it('Esc：内容没改 → 不写模型，只请求退出，且不把 Esc 传给画布', () => {
    const { press, onSubmit, onExit } = mount('原文');
    const event = press({ key: 'Escape' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(event.propagationStopped).toBe(true);
  });

  it('⌘Enter：有改动 → 提交新内容再退出', () => {
    const { press, edit, onSubmit, onExit } = mount('原文');
    edit('改过了', 3);
    const event = press({ key: 'Enter', metaKey: true });

    expect(onSubmit).toHaveBeenCalledWith('改过了');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('连续提交只认第一次（Esc 之后 DOM 被换掉还会补一个 blur 上来）', () => {
    const { press, edit, textarea, onSubmit } = mount('原文');
    edit('改过了', 3);
    press({ key: 'Enter', metaKey: true });
    textarea.emit('blur', undefined);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('输入法组词中的按键一律放行（Esc 也不例外，否则会吃掉候选词）', () => {
    const { press, onExit } = mount('原文');
    const event = press({ key: 'Escape', isComposing: true });

    expect(onExit).not.toHaveBeenCalled();
    expect(event.propagationStopped).toBe(false);
  });

  it('⌘Z / ⌘A 等交给浏览器原生行为', () => {
    const { press, onExit } = mount('原文');
    const event = press({ key: 'z', metaKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('`keepEditingOnBlur` 为真 → 这一下失焦既不提交也不退出（焦点只是在同一张卡里换了格）', () => {
    const keepEditingOnBlur = vi.fn(() => true);
    const { edit, textarea, onSubmit, onExit } = mount('原文', { keepEditingOnBlur });
    edit('改过了', 3);
    const event = { relatedTarget: '另一格' } as unknown as FocusEvent;
    textarea.emit('blur', event);

    // ★ 卡片要拿得到那个事件：它得从 `relatedTarget` 里认出"这是我的另一格"
    expect(keepEditingOnBlur).toHaveBeenCalledWith(event);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('`keepEditingOnBlur` 为假 / 不传 → 老规矩：失焦即提交并退出', () => {
    const { edit, textarea, onSubmit, onExit } = mount('原文', {
      keepEditingOnBlur: () => false,
    });
    edit('改过了', 3);
    textarea.emit('blur', { relatedTarget: null });

    expect(onSubmit).toHaveBeenCalledWith('改过了');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('两格之间来回挪几次都不落盘，真正离开时才**只提交一次**', () => {
    const { edit, textarea, onSubmit, onExit } = mount('原文', {
      // 与待办卡同一条判据：焦点还落在卡里的东西上 = 换格
      keepEditingOnBlur: (event) => event.relatedTarget !== null,
    });
    edit('改过了', 3);

    // 在卡里换了三格（清单 → 标题 → 清单）
    textarea.emit('blur', { relatedTarget: '标题框' });
    textarea.emit('blur', { relatedTarget: '清单' });
    textarea.emit('blur', { relatedTarget: '标题框' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    // 真走了：此时才提交（一次），且内容还是那三个字
    textarea.emit('blur', { relatedTarget: null });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('改过了');
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

// ── 编辑行为 ──────────────────────────────────────────────────

describe('行首快捷输入', () => {
  it('`*` + 空格 → `- `', () => {
    const { press, edit, textarea } = mount();
    edit('*', 1);
    const event = press({ key: ' ' });

    expect(textarea.value).toBe('- ');
    expect(textarea.selectionStart).toBe(2);
    expect(event.defaultPrevented).toBe(true);
  });

  it('`[ ]` + 空格 → `- [ ] `（待办项是"无序列表 + 复选框"）', () => {
    const { press, edit, textarea } = mount();
    edit('[ ]', 3);
    press({ key: ' ' });

    expect(textarea.value).toBe('- [ ] ');
  });

  it('行中的 `*` 不触发规则，空格照常输入', () => {
    const { press, edit, textarea } = mount();
    edit('abc*', 4);
    const event = press({ key: ' ' });

    expect(textarea.value).toBe('abc*');
    expect(event.defaultPrevented).toBe(false);
  });

  it('围栏内的 `*` 不触发规则（代码里的星号就是星号）', () => {
    const { press, edit, textarea } = mount();
    edit('```\n*', 5);
    const event = press({ key: ' ' });

    expect(textarea.value).toBe('```\n*');
    expect(event.defaultPrevented).toBe(false);
  });

  it('没有 execCommand 时降级为直接改写，结果一样正确', () => {
    const { press, edit, textarea, doc } = mount('', { withExecCommand: false });
    edit('*', 1);
    press({ key: ' ' });

    expect(doc.insertTextCalls).toBe(0);
    expect(textarea.value).toBe('- ');
  });

  it('优先走 execCommand —— 直接写 `value` 会清空原生撤销栈', () => {
    const { press, edit, doc } = mount('');
    edit('*', 1);
    press({ key: ' ' });

    expect(doc.insertTextCalls).toBe(1);
  });
});

describe('回车', () => {
  it('列表续行', () => {
    const { press, edit, textarea } = mount();
    edit('- a', 3);
    const event = press({ key: 'Enter' });

    expect(textarea.value).toBe('- a\n- ');
    expect(textarea.selectionStart).toBe(6);
    expect(event.defaultPrevented).toBe(true);
  });

  it('有序列表续行且序号 +1', () => {
    const { press, edit, textarea } = mount();
    edit('3. a', 4);
    press({ key: 'Enter' });

    expect(textarea.value).toBe('3. a\n4. ');
  });

  it('空项再回车 = 退出列表（拆掉标记）', () => {
    const { press, edit, textarea } = mount();
    edit(`${INDENT_UNIT}- `, 4);
    press({ key: 'Enter' });

    expect(textarea.value).toBe(INDENT_UNIT);
  });

  it('普通段落不接管回车', () => {
    const { press, edit, textarea } = mount();
    edit('正文', 2);
    const event = press({ key: 'Enter' });

    expect(textarea.value).toBe('正文');
    expect(event.defaultPrevented).toBe(false);
  });

  it('Shift+Enter 是软换行，列表项里也不续行', () => {
    const { press, edit, textarea } = mount();
    edit('- a', 3);
    const event = press({ key: 'Enter', shiftKey: true });

    expect(textarea.value).toBe('- a');
    expect(event.defaultPrevented).toBe(false);
  });

  it('围栏内的列表标记不被当成列表', () => {
    const { press, edit, textarea } = mount();
    edit('```\n- x', 7);
    const event = press({ key: 'Enter' });

    expect(textarea.value).toBe('```\n- x');
    expect(event.defaultPrevented).toBe(false);
  });

  it('围栏内的空白行（且其后没有内容）回车 → 补上闭合围栏', () => {
    const { press, edit, textarea } = mount();
    edit('```\ncode\n', 9);
    const event = press({ key: 'Enter' });

    expect(textarea.value).toBe('```\ncode\n```');
    expect(event.defaultPrevented).toBe(true);
  });

  it('围栏内后面还有内容的空白行不收尾 —— 别把用户代码里的空行截成两块', () => {
    const { press, edit, textarea } = mount();
    edit('```\n\n- x', 4);
    const event = press({ key: 'Enter' });

    expect(textarea.value).toBe('```\n\n- x');
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('Tab', () => {
  it('普通段落不吃 Tab（把焦点还回去）', () => {
    const { press, edit, textarea } = mount();
    edit('正文', 2);
    const event = press({ key: 'Tab' });

    expect(textarea.value).toBe('正文');
    expect(event.defaultPrevented).toBe(false);
  });

  it('列表项 Tab 缩进一级、⇧Tab 反缩进', () => {
    const { press, edit, textarea } = mount();
    edit('- a', 3);
    press({ key: 'Tab' });
    expect(textarea.value).toBe(`${INDENT_UNIT}- a`);

    press({ key: 'Tab', shiftKey: true });
    expect(textarea.value).toBe('- a');
  });
});
