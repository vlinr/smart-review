---
id: project-conventions
name: 项目规范示例（请复制到 .smart-review/skills/ 并修改）
modes: [diff, batch]
match: []
priority: 5
---

# 项目规范示例

> 此为外置文档型 Skill 示例。复制为 `.smart-review/skills/project-conventions.md` 并按团队规范修改后，提交审查时会自动注入全文。有 `match` 路径时仅在命中文件上生效；没有 `match` 则每次审查都会带上。

## 示例检查项

1. 禁止在业务代码中直接使用 `console.log` 输出用户数据
2. API 层必须统一错误处理，不得吞掉异常
3. 新增对外接口须考虑幂等与向后兼容

请仅针对 **本次变更引入** 的违规项报告问题。
