---
name: deep-think-first
description: 见山工作区接受任何新需求（功能 / 架构 / 数据 / 性能 / 模式性 Bug / 产品方向）时，在动手前先做一次结构化需求审视，并产出一份按固定模板填写的审视记录（保存到 .review/）。Use whenever the user in this workspace asks for a new feature or change, proposes an architecture / data / performance decision, or raises a recurring bug or product question — even briefly. Opens with a one-line triage step so mechanical edits (rename / typo / format) skip the ceremony entirely.
---

# 深思先于执行

## 触发后必须产出的东西

一份按 [`assets/request-review-template.md`](assets/request-review-template.md) 完整填写的 markdown 记录，保存到：

```
.review/<YYYY-MM-DD>-<scope>.md
```

零发现也是合法结果（写"未发现"），但模板八章节必须填，不能跳过。

## 分诊（一行判断）

这个请求值不值得审视？满足以下任一即触发：

- 不可逆 / 爆炸半径大（数据迁移、存储选型、删除、公开接口）
- 意图有歧义（用户描述的是手段而非目的）
- 涉及规模（百万字、几百章、长时间会话、本地单机）
- 修的是一类 Bug 的表象而不是根因
- "怎么做 X"，但 X 的前提本身可疑

**不满足以上任何一条**（纯重命名 / 改错别字 / 格式化 / 按既定清单执行）→ 直接做，跳过本 Skill。

## 执行审视（按顺序，每节必须写实质内容）

填模板八个章节，每节不是占位：

1. **重构真实目标**——用户说的是手段，目的是什么？
2. **真实规模走查**——百万字 / 深夜 / 几百章 / 本地单机下走一遍
3. **预演失败**——三周后证明这是灾难，复盘报告写什么
4. **攻击最弱假设**——让请求成立的 2–4 条前提，哪条最可疑
5. **扫描静默排除项**——可用性 / 失败恢复 / 认知负荷 / 数据安全 / 迁移 / 极端输入
6. **二阶效应**——上线后使什么变成可能 / 必然 / 新问题
7. **取证**——声称"现有实现不存在 / 会失败"前，先 grep / git log / 最小复现
8. **结论**——继续做（附调整）/ 重定目标（附新目标）/ 拆解（附子任务）/ 不做（附理由）

## 为什么这样做

执行机器的反面不是"态度端正的机器"。态度不能被命令，只能被操作化。
固定模板 + 强制八章节 = 把"想清楚"翻译成可检查的步骤，避免用"我已经认真思考了"糊弄过去。
八章节覆盖的需求审视维度是行业沉淀（pre-mortem、assumption attack、silent-exclusion scan 等），
把它们固化成模板既保证不遗漏，也避免被某个具体例子带偏成刻舟求剑。

## 反模式

- 只回答被问到的，没问到的维度即使想到了也不写
- 用工作量堆砌代替判断：列 20 个待办不如指出哪 3 个真正要紧
- 把"技术上能做"直接当成"应该做"
- 跳过模板章节或写占位
- 照抄本 Skill 描述里的例子（Milvus / 备份 / 暗色模式）当发现——那些是方法演示，不是清单
