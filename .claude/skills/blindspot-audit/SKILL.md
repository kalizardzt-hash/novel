---
name: blindspot-audit
description: 在重构后、发现遗漏 Bug 后、或发布前，枚举你（AI）实际未触及、未验证的代码与状态面，并产出一份按固定模板填写的盲区审查报告（保存到 .audit/）。Use after a refactor that touched core architecture, after you discover a bug you missed, before declaring work complete or shipping, or whenever the user says "审计 / 审查 / 盲区 / 走查 / 发版前 / 我觉得不放心" — anywhere the question "what could still be broken?" is worth turning into a checked artifact. NOT for implementing features; this produces a report, not code.
---

# 盲区审查（Blindspot Audit）

## 触发后必须产出的东西

一份按 [`assets/audit-report-template.md`](assets/audit-report-template.md) 完整填写的 markdown 报告，保存到：

```
.audit/<YYYY-MM-DD>-<scope>.md
```

`<scope>` 用本次审查对象命名（如 `lm-adapter-swap`、`release-v0.2`）。
**零发现也是合法结果**——必须把"未发现"明文写在对应章节里，不能跳过模板。

## 执行（按顺序，不要跳）

1. **接触面清单**——把"实际读过 / 改过 / 跑过"的路径列左列，把"同类但没动过"的列右列。两列差集 = 盲区。
2. **状态组合矩阵**——对每个关键交互入口，逐行勾选"空 / 加载中 / 错误 / 过期 / 权限不足 / 并发"六个状态维度的覆盖情况（✓ / ✗ / N/A）。常见未勾选项是"错误"和"空"，那是 bug 高发区。
3. **基线对比**（仅重构 / 迁移）——重构前应用能做到的事，逐条标"重构后状态"（仍可用 / 已破坏 / 不再适用 + 验证方式）。
4. **手动走查**——把前几步的结论翻译成可点击清单，在浏览器或 e2e 里**实际**走一遍，每条记录 ✓ 或 ✗ + 证据。
5. **发现的问题**——按 P0/P1/P2 分级。零发现写"本次审查未发现新盲区"，但必须填章节。
6. **失败归因**（仅当本次循环中有遗漏 Bug 时）——三问：在改动范围吗？流程哪步漏了？失败模式是什么？→ 编码成下次自动化检查项。

## 为什么这样做

自动化测试只覆盖它设计覆盖的东西；typecheck / build / 单测证明语法合法，不证明行为正确。
最常见的一类回归——"导航点击不响应"、"状态切换不刷新"、"权限边界静默放行"——发生在测试未触及的路径上，且没有任何自动化信号能预警。
固定模板 + 强制填所有章节 = 把"没找到"从"看起来没问题"变成显式声明，让盲区可被看见、被决定是否补测。

## 反模式

- 看到 `pnpm test` 全绿就宣称完成
- 重构后只 spot-check 一两个交互
- 跳过模板章节或写"待补充"占位
- 用"测试覆盖"的代码路径证明"未触及面不存在"——循环论证
- 把报告写成永远"未发现新盲区"的套话
