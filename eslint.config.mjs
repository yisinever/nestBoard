import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * 移动端不可用的模块。
 *
 * ★ 插件现在声明 `isDesktopOnly: true`（2026-09-18），这条限制**刻意保留**：
 *   代码里本来就没用它们，留着是给"将来放开移动端"留一条护栏 —— 一旦有人
 *   `import` 了 `fs`，那时再想改回 `false` 就得满仓库找。
 * 需要加密时用 Web API：globalThis.crypto.subtle（见 03 §4）。
 */
const NODE_ONLY_MODULES = ['fs', 'path', 'os', 'crypto', 'child_process', 'electron'];

export default tseslint.config(
  {
    ignores: ['main.js', 'main.js.map', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // TS 自身会报未定义变量，no-undef 在 TS 里只会产生误报
      'no-undef': 'off',

      // 开发日志走 console.debug / console.warn —— 产物中不得残留 console.log / console.error（DoD-1）
      'no-console': ['warn', { allow: ['debug', 'warn'] }],

      eqeqeq: ['error', 'smart'],

      // ★ 移动端守卫：禁止引入 Node 内置模块与 electron
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_ONLY_MODULES.map((name) => ({
            name,
            message: `"${name}" 在移动端不可用；请改用 Web API。`,
          })),
          patterns: [
            {
              group: ['node:*'],
              message: 'Node 内置模块在移动端不可用；请改用 Web API。',
            },
          ],
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  // ── 脑图的模块边界（`06 §2`）────────────────────────────────
  //
  // 脑图（`.nestmind`）与白板是同一条插件里的两个文档类型，**只共用 core 层**
  // （`io/` `util/` `integration/` `ui/` `export/` `editor/`）。这两个方向一旦被允许，
  // 两条线的模型就会互相渗，最后变成"谁也改不动"。
  // ★ `editor/` 是 P4 新增的共享层：`MiniMarkdownEditor` 从 `cards/editor/` 搬了过去 ——
  //   脑图节点的内容区要用它，而 `src/mind/**` 不许 import 白板的 `cards/**`
  //   （与 `Viewport` 搬到 `canvas/` 同一条理由）。
  //
  // ★ 为什么把三种相对深度都列出来：eslint 的 `patterns.group` 匹配的是**导入说明符的字面量**，
  //   而 `src/mind/**` 的文件到 `src/view/` 的距离随层级变化（`../view/x` / `../../view/x` /
  //   `../../../view/x`）。逐个列出比放一个 `**/view/**` 安全 —— 后者会把脑图**自己的**
  //   `src/mind/view/` 也误伤（从 `src/mind/model/` 回头引 `../view/x` 是合法的）。
  {
    files: ['src/mind/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_ONLY_MODULES.map((name) => ({
            name,
            message: `"${name}" 在移动端不可用；请改用 Web API。`,
          })),
          patterns: [
            {
              group: ['node:*'],
              message: 'Node 内置模块在移动端不可用；请改用 Web API。',
            },
            {
              group: [
                '../view/*',
                '../../view/*',
                '../../../view/*',
                '../cards/*',
                '../../cards/*',
                '../../../cards/*',
              ],
              message:
                '脑图不许依赖白板的视图层与卡片层（06 §2）：共用的只有 io/ util/ integration/ ui/ export/。',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
