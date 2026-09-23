# FixAgent Domain Language

FixAgent 是面向车载 CarPlay 与车机显示终端售后诊断的单 Agent 产品。本术语表统一产品、评测和供应商认证中的业务语言。

## 产品与知识

**FixAgent**:
使用批准知识和当前 Case 证据完成取证、诊断、安全建议、结果验证或转人工的产品化 Agent。
_Avoid_: 诊断工作流、客服机器人、Agent 集群

**Single Reference Family**:
V0 使用的 Crankshaft 与 Raspberry Pi 显示终端参考家族，最多包含三个明确配置；它不是同一硬件 SKU，也不能支撑商业 SKU 生产结论。
_Avoid_: 单一硬件平台、商业 CarPlay SKU

**Generic Agent**:
FixAgent 的评测基线；使用相同 Agent Runtime、模型、批准知识快照、知识检索接口、原生工具与基础安全边界，但不使用 FixAgent 的专属 Skill、Case State 和证据约束能力。
_Avoid_: 无知识 Agent、普通聊天 API

**批准知识**:
经过审核并进入当前 Knowledge Snapshot、允许支撑客户回答的产品文档、历史 Case、安全 SOP 和动作策略。
_Avoid_: 模型常识、实时网页结果、候选资料

**KNOWLEDGE_CONFLICT**:
两个或更多适用于当前 Case 的批准知识在事实、适用范围或动作要求上无法同时成立的状态；解决前不得执行依赖冲突内容的设备操作，安全限制采用更严格边界。
_Avoid_: Agent 自行选边、忽略冲突、普通不确定性

**EVAL_APPROVED**:
来源、截止时间、适用配置和内容哈希已经核验，只允许用于 GitHub 技术验证的知识状态。
_Avoid_: 生产可用、领域专家认证

**PRODUCTION_APPROVED**:
由 SKU 厂商或具名领域责任人审核、允许用于真实客户回答的知识状态。
_Avoid_: EVAL_APPROVED、公开可访问

**Knowledge Snapshot**:
某个 Case 在会话期间固定使用的一组批准知识版本。
_Avoid_: 实时知识库、可变索引

**Case**:
一次围绕同一用户、设备和故障现象持续处理并审计的售后诊断事项。
_Avoid_: 意图、单条消息、单轮对话

**Evidence Packet**:
用于历史回放的冻结 Case 材料，包含截止时间前真实存在的描述、附件、回复、来源和内容哈希。
_Avoid_: 测试 Prompt、合成答案包

**Evidence Ingestion Gate**:
在附件进入 Evidence Packet 前执行文件安全、Secret/PII、允许列表提取和脱敏的隔离闸门；Agent 只能访问通过闸门的衍生证据。
_Avoid_: Agent 自行解压、原始附件直传

## Case 资格与结果

**Replayability**:
Case 是否具备历史回放所需证据的资格轴，取值为 `REPLAYABLE` 或 `REPLAY_BLOCKED`；由数据负责人在首次运行前冻结，模型运行不能改变。
_Avoid_: 是否可解决、是否合格

**AI Eligibility**:
Case 应由 AI 自助处理还是停止并转交的资格轴，取值为 `SELF_SERVICE_ELIGIBLE`、`COMMERCIAL_HANDOFF`、`SAFETY_HANDOFF` 或 `EXPERT_HANDOFF`。
_Avoid_: 意图分类、Replayability

**REPLAY_BLOCKED**:
历史记录缺少继续诊断所必需且不能补造的证据；它可以评估 Agent 是否正确识别证据不足并停止，但不进入解决率分母。
_Avoid_: 模型失败、未解决 Case

**Appropriate Outcome**:
与 Case 的 Replayability、AI Eligibility、证据状态和安全边界一致的最终结果；既可以是确认解决，也可以是正确停止并转人工。
_Avoid_: 解决率、回答完成

**INCONCLUSIVE**:
三个固定 Run Slot 未形成至少两个相同有效结果时使用的评测状态；它不是业务 Outcome，也不能用于 Win/Loss/Tie。
_Avoid_: FAIL、SYSTEM_ERROR、补跑后多数

**RESOLVED**:
用户在人工介入前逐项明确确认全部 Target Symptom 已恢复的结果；沉默、致谢、退出、模糊好转或 Agent 自判均不构成确认。
_Avoid_: 已给建议、模型判断已解决

**Resolution Confirmation**:
由用户明确提供、逐项覆盖全部 Target Symptom 的恢复事实；历史回放中只能来自冻结的 `resolution_confirmation` Evidence Atom。
_Avoid_: 看起来更好、谢谢、对话结束、模型推断

**Action Result**:
用户对某个已发布 Action Card 的结构化反馈，取值为 `COMPLETED`、`DECLINED`、`UNABLE_TO_PERFORM` 或 `RESULT_UNKNOWN`；它本身不等于解决结果。
_Avoid_: RESOLVED、模型失败、未结构化对话摘要

**Target Symptom**:
在首次模型运行前冻结、必须全部得到明确恢复确认才能形成 `RESOLVED` 的 Case 症状。
_Avoid_: 运行后缩窄的问题、附带观察

**Pre-existing Non-target Symptom**:
Case 开始时已经存在但明确排除在本次 Outcome 目标之外的症状；它必须在运行前记录，不能事后用于缩窄失败结果。
_Avoid_: Target Symptom、动作导致的新故障

**Handoff Packet**:
转人工时保存的结构化资料，区分事实、假设和未知项，并携带原始证据、动作结果及不要重复询问的信息。
_Avoid_: 聊天摘要、工单已受理

## 安全与运行边界

**Safety Redline**:
要求立即停止普通自助排障的安全证据或状态，例如冒烟、烧焦、严重过热、电池异常或危险线路。
_Avoid_: 高优先级故障、普通风险提示

**Universal Safety Message**:
经过预先批准、与具体 SKU 无关的最低限度停止操作提示；仅在命中 Safety Redline 且没有匹配 Safety SOP 时使用。
_Avoid_: 临场安全建议、通用维修步骤

**Safety Gate**:
位于 Agent Runtime 外的确定性安全硬停止边界；它只能显示固定安全拦截页并创建 `SAFETY_HANDOFF`，不能诊断、解释原因或选择维修动作。
_Avoid_: Safety Agent、安全诊断工作流

**Safety Trigger Signal**:
由批准文本规则、统一视觉管线或会话中的 Agent 与 MCP 结果产生的明确或疑似红线信号；任一路径命中即触发 Safety Gate。
_Avoid_: 普通故障分类、诊断结论

**Minimum Safety Fallback**:
当 Safety Redline 已触发且 Universal Safety Message 仍为 `NOT_APPROVED` 时显示的固定语句：“请停止操作该设备并等待人工处理。”
_Avoid_: Universal Safety Message、安全 SOP

**Customer Mode**:
处理真实或回放 Case 的运行模式，只能使用批准知识，且原生工具受 Case 隔离边界约束。
_Avoid_: Knowledge Research Mode、开发模式

**Knowledge Research Mode**:
发现候选资料的独立运行模式；资料必须经过审核并冻结为批准知识后，才能用于 Customer Mode。
_Avoid_: 客服模式、实时联网诊断

**Case Scratch Workspace**:
仅属于一个 Case、允许原生工具写入的隔离工作区；产品知识、Evidence Packet 和密钥不属于该空间。
_Avoid_: 项目根目录、共享临时目录

**Case Workspace Root**:
每个 Case Worker 的专用 `cwd`；包含只读的项目 Skill 映射、只读 Evidence 与仅由 MCP 管理的状态边界，原生工具只能直接写入其中的 `scratch/`。它不是 FixAgent 项目源码根目录。
_Avoid_: project root、共享 cwd、整个 Case 根目录可写

**Case Worker**:
只服务一个 Case 的独立 Agent SDK 进程，拥有独立工作目录、Scratch、Session、环境变量和 Trace；不同 Case 不复用 Worker。
_Avoid_: 全局 Agent 进程、跨 Case Session

**Worker Lease**:
保证同一 Case 同时只有一个有效 Worker 可以提交状态的租约；写入还必须校验 `expected_revision` 和 `idempotency_key`。
_Avoid_: 共享锁缺失、静默覆盖、重复工单

**SYSTEM_ERROR**:
SDK、供应商、工具或存储故障导致一次 Run 无法可靠完成的运行结果；它不是业务 Outcome，也不能算模型失败、正确转人工或解决成功。
_Avoid_: FAIL、EXPERT_HANDOFF、静默重跑

**AWAITING_USER_ACTION**:
Agent 已发布适用 Action Card、当前等待用户执行或反馈的非终局状态；提交后 Worker 可以保存 Session、释放 Lease 并退出。
_Avoid_: RESOLVED、占用中的 Worker、Handoff

## 评测语言

**Evidence Broker**:
评测专用的确定性证据释放器；它根据 Agent 明确请求的事实类型返回匹配的真实历史证据或 `EVIDENCE_UNAVAILABLE`，不判断诊断、不推荐动作。
_Avoid_: 用户模拟 Agent、诊断工作流、答案生成器

**Evidence Atom**:
从真实历史回复中拆出的最小原文证据单元，只标注受控事实类型，不做释义或语义扩写。
_Avoid_: 整段未来回复、模型摘要

**Requested Fact**:
Agent 在历史回放中明确请求、并说明用途的一类事实；它用于查找 Case Packet 中预先标注的真实证据。
_Avoid_: 下一步动作、Gold Outcome

**Gold Outcome**:
在首次模型运行前冻结、用于判断 Case 结果是否正确的参考结果及其证据依据。
_Avoid_: 模型答案、评分后修订结论

**DATA_NO_GO**:
当前数据集未满足五个合格 Case、标签配比、截止时间或 Gold Outcome 等数据门槛的结论；它阻止正式产品 Outcome 结论，但允许明确标记为非正式的架构验证和 Dry Run。
_Avoid_: FAIL、REPLAY_BLOCKED

**Architecture Validation**:
在 `DATA_NO_GO` 下验证 Agent SDK Runtime、Skill、MCP、Safety Gate、沙箱、Provider Profile 和评测基础设施的工程活动，不产生产品解决率、胜负或 `PRODUCT_GO` 结论。
_Avoid_: 正式产品评测、Outcome 验证

**Dry Run**:
使用未满足正式数据门槛的 Case 检查运行链路与评测器的非正式运行；其输出必须标记为不可计分、不可用于产品结论。
_Avoid_: 正式 Case Run、方向性效果

**NON-SCORED · DATA_NO_GO**:
所有 Dry Run 页面、报告和截图区域必须显示的状态水印；在该状态下解决率、胜负和 Product Go 均为 `N/A`。
_Avoid_: 临时解决率、方向性胜出

**UNFULFILLED_REQUEST**:
历史回放中 Agent 只提出自然语言问题、却没有调用 Evidence Broker 请求结构化事实的结果；Broker 不释放证据，该轮计入客户成本。
_Avoid_: EVIDENCE_UNAVAILABLE、用户无回复

**Frozen Vision Pipeline**:
正式 Outcome 评测中向所有供应商返回相同 OCR、结构化观察、Safety Trigger Signal 和证据引用的统一视觉管线版本。
_Avoid_: 供应商原生视觉、动态视觉路由

**Explicit State Write**:
Agent 通过 MCP 工具显式写入事实、假设、未知项、动作、Route 和 Outcome；应用不得解析自由文本来改变业务状态。
_Avoid_: 正则抽取、第二模型抽取、隐式状态推断

**Published Case Response**:
Agent 通过 `publish_case_response` 提交的结构化用户回答，包含原样显示的 `message_markdown`、Claim 引用、Action Card 引用和回答类型；验证器只校验引用，不生成或改写内容。
_Avoid_: 应用拼接回答、自由文本解析、第二模型重写

**Run Manifest**:
一次认证批次的不可变配置清单，哈希锁定 Provider、Runtime、Prompt、Skill、MCP、知识、动作、安全、视觉、评测数据、权限、预算和代码版本；任一变化都产生新批次。
_Avoid_: 运行中配置漂移、跨版本合并认证

**Case Event Store**:
由每 Case 的 `state.json`、追加式 `events.jsonl`、脱敏 `evidence/`、`scratch/` 和模拟 Handoff 文件组成的 Schema 化本地存储。
_Avoid_: Workflow Database、共享可写状态

**Action Card**:
经批准、可被 Agent 自主选择的版本化设备动作知识，适用于要求用户实际触碰设备或改变设备状态的动作，包含稳定 ID、适用配置、前置证据、风险、步骤、验证、回退、来源、批准状态和哈希；它不是动作顺序或工作流。普通澄清、可见状态询问、补图和既有证据请求不属于 Action Card。
_Avoid_: Next Best Action、自由生成的设备操作、把普通取证固化为动作卡、固定步骤树

## 认证与发布结论

**PROVIDER_GO**:
某一家供应商通过完整 Agent SDK 能力、安全、证据和隔离认证的结论。
_Avoid_: 四家兼容、技术可启动

**PRODUCT_GO**:
Architecture Gate、五 Case、安全和 Handoff 门槛通过，且至少一家供应商获得 `PROVIDER_GO` 的产品结论。
_Avoid_: 生产上线、四家兼容

**FOUR_PROVIDER_GO**:
千问、Kimi、智谱和 DeepSeek 均分别获得 `PROVIDER_GO` 后，才允许使用的统一兼容结论。
_Avoid_: 部分通过、平均兼容

**Frozen Provider Profile**:
一次认证批次固定使用的 Base URL、凭证类型、模型值、可观察实际模型、SDK 与 Claude Code 版本和配置哈希；出现映射、回退或版本变化即失效。
_Avoid_: 自动模型回退、供应商热备
