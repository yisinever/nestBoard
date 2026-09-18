import { defineConfig } from 'vitest/config';

/**
 * v1.0.0 的发布门槛之一（`03 §8.3` / `T4.18`）：**`model/` 与 `export/` 覆盖率 ≥ 70%**。
 *
 * 门槛写进配置而不是写在文档里，是因为"数字只有被人看见才会被守住" ——
 * 配 `thresholds` 之后，`npm run test:coverage` 一旦跌破 70% 就**直接退出非 0**，
 * 不需要谁记得去看报告。
 *
 * 为什么只对这两个目录设门槛：它们是**纯逻辑**（`03 §2` 的 JSON 可序列化前提，
 * 零 Obsidian / 零 DOM 依赖），可以完整地在 node 里跑；而 `view/` / `ui/` 的
 * 覆盖率天然被渲染路径拉低，拿它当门槛只会逼着写"为了覆盖率而覆盖率"的测试。
 */
const LOGIC_THRESHOLD = {
  statements: 70,
  branches: 70,
  functions: 70,
  lines: 70,
} as const;

export default defineConfig({
  test: {
    // model/ 与 export/ 是纯逻辑（零 Obsidian、零 DOM 依赖），跑在 node 环境即可
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 测试文件已就位，`passWithNoTests` 已移除：没有用例跑 = CI 失败，
    // 否则测试文件被误删 / 路径写错时 CI 会"静默变绿"。
    coverage: {
      provider: 'v8',
      // 只统计发布门槛覆盖的两个目录（其余目录的估算不参与判定，但也不会污染数字）
      include: ['src/model/**/*.ts', 'src/export/**/*.ts'],
      // 测试自身不进报告；`schema.ts` 是纯类型声明，没有可执行语句
      exclude: ['src/**/*.test.ts', 'src/model/schema.ts'],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // 按目录分别卡（而不是只卡一个总数）：`model/` 涨到 99% 也救不了 `export/` 掉到 60%
      thresholds: {
        'src/model/**/*.ts': LOGIC_THRESHOLD,
        'src/export/**/*.ts': LOGIC_THRESHOLD,
      },
    },
  },
});
