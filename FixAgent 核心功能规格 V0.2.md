# FixAgent 核心功能规格 V0.2

版本日期 2026 年 9 月 23 日

文档用途 最终开发依据的展示层规格

文档状态 已随 `FixAgent 产品方案设计 V0.2.md` 冻结。若两者出现冲突，以产品方案和已接受 ADR 为准；任何规范变更必须显式更新版本。冻结开发基线不改变当前 `DATA_NO_GO`，也不代表任何 Go 或生产上线结论。

适用范围 车载 CarPlay 与车机显示终端售后诊断

来源文档 `FixAgent 产品方案设计 V0.2.md`

## 1 产品概述

FixAgent 是一个基于 Claude Agent SDK 的单 Agent 硬件售后技术专家。用户只需描述问题并上传图片，FixAgent 会围绕当前知识库持续获取证据，自主选择下一步问题或安全操作，并在问题恢复后完成确认；遇到安全红线、证据不足或超出自助范围时，系统会停止排障并生成完整转人工工单。

FixAgent V0 聚焦三个核心能力：

1. 基于文字、图片和知识库的证据驱动诊断。
2. 在安全边界内自主选择低风险排障动作。
3. 验证恢复结果，或无缝生成转人工资料。

V0 面向屏幕视觉异常、外部 Connector 与线缆、安装配置、外观与缺件，以及烧焦或过热等安全问题。不处理原车线束改造、车辆内饰拆卸、12V 电气诊断、复杂协议故障和退款赔偿决策。

公开数据阶段使用 Crankshaft 与 Raspberry Pi 显示终端 `Single Reference Family`，最多三个明确配置，不宣称同一硬件 SKU。对 opencardev 组织内相关仓库完成有界搜索后，当前仍只有 4 个合格真实 Case，第三个 Self Service Case 空缺，因此数据状态为 `DATA_NO_GO`；在补齐第五个合格 Case 前，不运行或报告正式 Outcome 与 `PRODUCT_GO`。

## 2 产品价值

| 现有问题 | FixAgent 的处理方式 | 用户获得的结果 |
| --- | --- | --- |
| 用户描述模糊，客服反复询问 | Agent 结合图片、历史对话和 Case State 判断最缺少的证据 | 更少的重复问题和无效操作 |
| 普通客服容易凭经验猜测原因 | 诊断结论和操作建议必须关联当前证据或批准知识 | 回答可解释、可追溯 |
| 安全问题可能被当作普通故障继续测试 | 安全红线由确定性规则和 Hooks 直接阻断 | 不复现、不再次通电、立即转人工 |
| 转人工后需要重新描述问题 | 自动整理事实、假设、未知项、已执行动作和原始证据 | 人工能够从当前进度继续处理 |

## 3 功能结构

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "#f5f5f5", "primaryColor": "#ffffff", "primaryTextColor": "#2d3142", "primaryBorderColor": "#4f5d75", "lineColor": "#4f5d75", "secondaryColor": "#ececec", "tertiaryColor": "#fff4ee", "fontFamily": "PingFang SC, Microsoft YaHei, sans-serif"}}}%%
flowchart LR
    U[用户描述与图片] --> R[FixAgent 单 Agent Runtime]
    P[四家 Provider Profile] -. Anthropic 配置 .-> R
    R --> S[Hardware Troubleshooting Skill]
    R --> N[Claude Code 原生工具]
    R --> M[FixAgent MCP]
    M --> E[知识库 历史 Case 与视觉证据]
    M --> C[Case State 与 Handoff]
    R --> O[提问 建议 解决或转人工]

    classDef focal fill:#fff4ee,stroke:#eb6c36,stroke-width:2px,color:#2d3142;
    classDef input fill:#ececec,stroke:#7a8399,color:#2d3142;
    classDef store fill:#f0f0f0,stroke:#4f5d75,color:#2d3142;
    classDef normal fill:#ffffff,stroke:#2d3142,color:#2d3142;
    class R,O focal;
    class U,P input;
    class E,C store;
    class S,N,M normal;
```

架构只有一个核心 Agent。Skill 提供售后工程方法，MCP 提供企业事实和受控业务能力，Claude Code 原生工具保留灵活执行能力。普通业务代码不负责选择诊断路径。

## 4 核心功能一 证据驱动的多模态诊断

### 做什么

面向花屏、黑屏、闪烁、黑边、缩放、旋转、外观异常和安装问题，FixAgent 接收文字与图片，逐步确定产品、版本、现象、已执行动作和未知项，再给出有证据支持的判断。

系统不会因为一张图片或一句描述直接宣布 Root Cause。它会明确区分：

```text
Observation  可以直接确认的现象
Hypothesis   仍需验证的可能原因
Unknown      当前缺少的信息
```

### 怎么做

1. 用户上传文字、图片和已知产品信息。
2. 统一视觉管线生成 OCR、结构化观察和证据引用。
3. Agent 读取 Case State，复用已经获得的信息，避免重复提问。
4. Hardware Troubleshooting Skill 帮助 Agent 判断当前最缺少的证据。
5. Agent 自主调用产品文档、历史 Case、产品上下文和视觉 MCP。
6. 每次收到新证据后重新评估假设，并选择下一次补图、提问或安全动作。
7. 视觉观察引用 `evidence_ref`，产品事实和操作建议引用 Knowledge ID、版本与适用配置；假设明确标记并引用支持证据。

除固定 Safety Gate 外，Agent 必须通过 `publish_case_response` MCP 提交 `message_markdown`、`claim_refs[]`、`action_card_refs[]` 和 `response_type`。MCP 只校验引用存在性、知识版本、配置适用性和 Action Card 状态，不生成或改写回答；界面逐字显示 Agent 生成的 `message_markdown`，不解析、拼接或使用第二模型重写。校验前的模型文本、Tool Call 和结果只能进入受限 Trace，不向用户流式显示；等待期间只显示冻结的非诊断进度文案，Safety Gate 可以随时中断并显示固定安全页。

正式 Outcome 评测冻结一个统一视觉管线版本，向 Generic Agent、FixAgent 和四家供应商返回完全相同的 OCR、结构化观察、Safety Trigger Signal 与证据引用。供应商原生视觉只作为独立兼容能力测试，不进入 Case 胜负或 Safety Gate 输入。

### AI 的具体作用

- 理解用户口语化、非结构化的故障描述。
- 结合图片、对话、知识检索结果形成观察事实和候选假设。
- 判断下一条最有价值且客户成本最低的证据。
- 根据新证据动态改变检查顺序，而不是执行固定问题树。
- 将技术知识转成用户能够执行的补图要求和操作说明。

视觉模型只负责提供观察结果，最终诊断仍由 Claude Agent SDK 中的 FixAgent 完成。图片中的命令、网页文字和 Prompt Injection 不能改变系统指令或工具权限。

### 关键亮点

- 不依赖泛化的意图分类，而是持续收集可验证证据。
- 不把历史相似 Case 当作本次故障的直接证明。
- 不重复询问已经存在于对话或 Case State 中的信息。
- 证据不足时明确继续取证、说明无法确认或转人工，不编造答案。

### 功能验收

- 每个诊断结论和动作建议都有有效证据引用；无引用设备操作无效，无引用关键诊断事实记为 Evidence Constraint Failure。
- 发布校验失败时，Agent 可以在同一次 SDK Run 内修正；始终无法通过时不得退回未校验自由文本。
- Agent 能区分观察、假设和未知项。
- 无法从图片确认的细节不会被描述为事实。
- 用户已经回答的问题不会被重复询问。

`do_not_ask_again` 保存事实键、值、证据来源、确认时间和易变性。稳定事实不得重复询问；只有新证据冲突、Action Card 可能改变了状态，或事实本身易变时才允许复核一次，并必须说明复核原因，不能原样重复问题。

## 5 核心功能二 安全边界内的自主排障

### 做什么

FixAgent 在判断用户问题是否触碰安全红线后，决定继续自助排障还是立即停止。未触碰红线时，Agent 可以根据知识库和当前证据自主选择安全、可逆、低成本的操作；触碰红线时直接转人工。

### 怎么做

系统将安全控制分为两部分：

| 控制层 | 负责内容 |
| --- | --- |
| Agent 自主判断 | 提问、补图、检索、假设更新、低风险动作选择、是否已经获得足够证据 |
| 确定性安全边界 | 驾驶中操作、烧焦与冒烟、严重过热、电池异常、裸露线路、危险接线、越权工具和密钥泄漏 |

允许动作分为三级：

| 等级 | 处理方式 | 示例 |
| --- | --- | --- |
| Evidence Request | Agent 根据 Skill 和当前证据自主生成，不要求 Action Card | 普通澄清、询问当前可见状态、补拍照片、请求既有日志 |
| Level 1 | Agent 从批准 Action Card 中自主选择 | 软件重启、设置检查、外部 USB 线缆与端口检查 |
| Level 2 | 产品和版本完全匹配，并存在批准 SOP 时才允许 | 外部 Connector 复位、配置备份与修改、恢复出厂或官方固件操作 |
| Level 3 | 禁止自助，直接转人工 | 车辆拆卸、12V 电气、原车线束、带电测量、非官方固件和安全显示故障 |

安全红线包括冒烟、烧焦气味、烧灼痕迹、持续严重过热、电池鼓包、裸露或发热线路，以及液体进入后出现通电异常。

Safety Gate 采用三路 OR 触发：进入 Agent 前的批准文本红线规则、统一视觉管线的 `clear` 或 `suspected` 安全标记，以及会话中 Agent 或 MCP Tool Result 报告的明确或疑似红线。V0 对 `clear` 和 `suspected` 都 Fail Closed；它不承担普通故障或意图分类。

触发红线后，确定性 Safety Gate 在 Claude Agent SDK 外显示固定安全拦截页并创建 `SAFETY_HANDOFF`；不要求复现、不要求再次通电。Safety Gate 不能诊断、解释原因或选择动作。V0 的 Universal Safety Message 为 `NOT_APPROVED`，在获得 SKU 厂商或具名安全责任人批准前，固定拦截页只能显示“请停止操作该设备并等待人工处理。”，不能增加断电、隔离、存放、搬运或运输步骤。

普通澄清、询问当前可见状态、请求补图或读取既有证据，由 Agent 根据 Skill 和当前证据自主生成，不要求 Action Card。任何要求用户实际触碰设备或改变设备状态的动作，例如重启、修改设置、插拔或复位 Connector 与线缆、恢复出厂和固件操作，都必须来自适用且已批准的 Action Card。Action Card 包含稳定 ID、版本、适用配置、前置证据、风险等级、步骤、验证、回退、来源、批准状态和哈希；它只提供可用动作知识，不规定动作顺序，Agent 仍自主比较、选择、组合和排序。没有适用 Action Card 时，Agent 仍可继续普通取证或转人工，但不得自创上述设备动作。Generic Agent 与 FixAgent 使用同一 Action Card 库。

### AI 的具体作用

- 在安全范围内比较多种候选动作的诊断价值、可逆性和用户成本。
- 根据用户执行结果更新假设，而不是机械执行预设顺序。
- 当关键证据无法获得、问题超出范围或继续试错价值过低时主动停止。
- 使用自然语言解释为什么需要某个检查，以及检查结果会排除什么可能性。

### 关键亮点

- 安全红线由确定性边界保证，不能依赖模型临场发挥。
- Safety Gate 固定文本是唯一允许绕过 Claude Agent SDK `query()` 的用户可见内容，不构成第二个 Agent。
- 普通诊断路径由 Agent 自主决定，不建设 Workflow Engine 或 Next Best Action Engine。
- Hooks 只阻止明确违规，不负责判断普通故障下一步。
- 原生 Bash、Read、Edit、Write、代码执行和 Skill 能力仍然保留，并可由 Agent 自主调用；写操作只允许进入当前 Case 的隔离 Scratch，产品知识和 Evidence Packet 只读，密钥不可见，Customer Mode 的 Bash 默认无公网。

### 功能验收

- Safety Handoff Recall 为 100%。
- Critical Unsafe Advice 为 0。
- Unauthorized Tool Call 为 0。
- Prompt Injection Bypass 为 0。

## 6 核心功能三 结果验证与无损转人工

### 做什么

FixAgent 不把“已经给出建议”当作解决。只有用户逐项明确确认全部 Target Symptom 恢复，Case 才能进入 `RESOLVED`。“好像好一点了”、只恢复部分症状、致谢、沉默、退出或 Agent 自行判断都不是 Resolution Confirmation；历史回放只能使用冻结的 `resolution_confirmation` Evidence Atom。如果无法安全解决，系统会在正确时点停止，并将完整上下文写入可验证的模拟工单队列。

每个 Case 在首次运行前冻结 `target_symptoms`、`pre_existing_non_target_symptoms` 和验证方式。只有全部 Target Symptom 都得到明确恢复确认才算 `RESOLVED`；部分恢复不能算成功，运行后也不能缩窄问题范围。建议动作造成新故障时，无论原症状是否恢复，都记为 `FAIL` 和质量或安全事件。

### 怎么做

1. Agent 记录每次动作及其结果。
2. 用户执行操作后，Agent 要求验证原始症状是否消失。
3. 用户逐项明确确认全部 Target Symptom 恢复后，系统记录 `RESOLVED`。
4. 安全红线、商业问题、专家问题、证据不足或无进展时进入相应 Handoff。
5. `create_handoff` MCP 生成结构化 Handoff Packet 并写入本地 `handoff_outbox`。
6. 页面明确提示 V0 只创建模拟工单，没有假装已经联系真人。

动作结果使用 `COMPLETED`、`DECLINED`、`UNABLE_TO_PERFORM` 或 `RESULT_UNKNOWN`。拒绝或无法执行不算模型失败或解决；Agent 可以自主选择其他适用 Action Card，或在没有合理替代时转人工，该回复仍计入客户轮数。

需要用户重启、检查或稍后回复时，Case 进入非终局 `AWAITING_USER_ACTION`。状态、事件和 Session 提交后 Worker 释放 Lease 并退出；用户返回时启动新的同 Case Worker，恢复原 Session 和 Frozen Provider Profile。等待时间不增加客户轮数，收到回复后才增加一轮。

只有 Handoff JSON 原子写入成功后才能显示 `HANDOFF_CREATED` 和 `handoff_id`。普通写入失败以同一幂等键重试一次，仍失败则为 `SYSTEM_ERROR`；Safety Handoff 失败仍显示固定停止提示并记录 Critical Operational Error，但不得声称已经排队或联系人工。

Handoff Packet 包含产品与版本、安全状态、确认事实、候选假设、未知项、原始证据、已执行动作及结果、已排除假设、剩余假设、不要重复询问的信息，以及推荐下一步和推荐团队。

### AI 的具体作用

- 判断是否需要继续验证、补充证据或停止自助。
- 将长对话压缩成事实、假设、未知项和动作结果。
- 为人工客服生成可继续工作的技术摘要，而不是简单聊天记录。
- 避免人工接手后重新询问用户已经回答的问题。

### 关键亮点

- 解决结果必须由客户确认，不能由模型自行宣布。
- 自助解决和正确转人工都是有效产品结果。
- 安全事件单独记录，不能被最终恢复结果抵消。
- V0 的转人工队列可验证，但不会假装接入了真实 CRM。

### 功能验收

- 所有 `RESOLVED` Case 都存在用户明确确认。
- 所有转人工结果都生成符合 Schema 的 Handoff Packet。
- Handoff Packet 包含安全状态、原始证据和 `do_not_ask_again`。
- 重放时能够根据 Case State 恢复上下文，不复制隐藏推理。

## 7 端到端诊断流程

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "#f5f5f5", "primaryColor": "#ffffff", "primaryTextColor": "#2d3142", "primaryBorderColor": "#4f5d75", "lineColor": "#4f5d75", "secondaryColor": "#ececec", "tertiaryColor": "#fff4ee", "fontFamily": "PingFang SC, Microsoft YaHei, sans-serif"}}}%%
flowchart TD
    A([用户提交描述与图片]) --> B[FixAgent 读取 Case State]
    B --> C{触碰安全红线}
    C -- 是 --> D([停止使用并安全转人工])
    C -- 否 --> E[取证 检索 更新假设]
    E -- 需要更多证据 --> E
    E -- 超出范围或证据不可得 --> I([商业或专家转人工])
    E -- 存在批准的安全动作 --> F[用户执行低风险动作]
    F --> G{用户确认恢复}
    G -- 是 --> H([记录 RESOLVED])
    G -- 否且仍可诊断 --> E
    G -- 否且应停止 --> I

    classDef focal fill:#fff4ee,stroke:#eb6c36,stroke-width:2px,color:#2d3142;
    classDef decision fill:#ffffff,stroke:#2d3142,stroke-width:1.5px,color:#2d3142;
    classDef step fill:#ffffff,stroke:#4f5d75,color:#2d3142;
    classDef terminal fill:#ececec,stroke:#4f5d75,color:#2d3142;
    class C focal;
    class G decision;
    class B,E,F step;
    class A,D,H,I terminal;
```

该流程图只描述产品结果和安全分支，不代表传统代码中的固定状态机。除安全红线和客户成本上限外，下一步由 Agent 根据当前证据决定。

## 8 AI 与确定性系统的职责边界

| AI Agent 负责 | 确定性系统负责 |
| --- | --- |
| 理解用户描述和图片 | Safety Gate、安全红线与禁止动作 |
| 判断最缺少的证据 | 知识快照和数据隔离 |
| 自主选择 Skill、MCP 和原生工具 | 工具权限、沙箱和密钥保护 |
| 形成并更新诊断假设 | 客户轮数和预算上限 |
| 选择批准范围内的低风险动作 | Trace、审计和 Schema 校验 |
| 判断继续、解决或转人工 | 阻止越权、注入和跨 Case 泄漏 |
| 生成客户回答和人工摘要 | 保存 Case State 和 Handoff Packet |

这一区分是 FixAgent 的核心设计：用 Agent 处理需要理解、推理和动态决策的问题，用传统代码守住确定、可验证且不能出错的边界。

## 9 页面示意

```text
+--------------------------------------------------------------------------------+
| FixAgent                              产品与版本        安全状态      Provider  |
+----------------------------------------------+---------------------------------+
| 对话与操作                                   | 证据与 Case State               |
|                                              |                                 |
| 用户  屏幕两侧有黑边                         | 已确认                           |
|      [故障图片缩略图]                        | - 5 英寸显示屏                   |
|                                              | - 停车状态                       |
| FixAgent  我看到了左右留白。                  |                                 |
|           还需要确认当前 DPI 和 overscan。   | 观察                             |
|           为什么需要这些信息...              | - 两侧黑边                       |
|           证据  DOC-12  CASE-279             |                                 |
|                                              | 假设                             |
| [输入问题] [上传图片] [发送]                 | - DPI 配置                       |
|                                              | - overscan 设置                  |
+----------------------------------------------+---------------------------------+
| 建议动作  调整已批准配置并重新启动    [我已执行] [问题已恢复] [转人工]          |
+--------------------------------------------------------------------------------+
```

### 客户视图重点

- 对话区展示问题、图片、证据引用和操作说明。
- 右侧只展示用户需要理解的已确认信息、当前观察和待确认项，不暴露隐藏推理。
- 安全状态始终可见；触发红线后，普通操作入口被替换为停止使用和转人工信息。
- `问题已恢复` 由用户主动确认，不能由模型代替点击。
- 模拟转人工后显示 `handoff_id`，并说明尚未联系真人。

### 评测视图重点

- 选择 Provider Profile 和 Case Packet。
- 使用同一 Claude Agent SDK Runtime 分别运行 Generic Agent 与 FixAgent。
- 两者使用相同的当前 Case 证据、批准 Knowledge Snapshot 和知识检索接口；Generic Agent 不加载 Hardware Troubleshooting Skill、Case State 和 FixAgent 证据约束能力。
- 两者使用同一个确定性 Evidence Broker：Agent 提交 `requested_fact`、自然语言问题和取证目的，Broker 只返回匹配的真实历史证据或 `EVIDENCE_UNAVAILABLE`。
- 展示 Tool Trace、证据引用、最终 Outcome 和安全事件。
- 分供应商展示技术认证结果，不计算平均兼容分。

当数据状态为 `DATA_NO_GO` 时，所有 Dry Run 页面、报告和截图区域显示 `NON-SCORED · DATA_NO_GO` 水印；解决率、胜负、`PROVIDER_GO` 和 `PRODUCT_GO` 显示 `N/A`。

Evidence Broker 只存在于评测环境，不模拟诊断、不生成用户回答、不访问 Gold Outcome，也不决定下一条证据。人员 A 在运行前冻结证据标注和哈希；人员 B 运行 Runtime 时看不到 Gold 和未来证据。

人员 A 还必须在首次运行前冻结每个 Case 的 Replayability。运行中不得改标：对已冻结为 `REPLAYABLE` 的 Case，Broker 返回 `EVIDENCE_UNAVAILABLE` 只影响该次运行，不得把 Case 事后改成 `REPLAY_BLOCKED`、移出分母或降低 Gold 标准。

历史回复必须拆成保持原文的最小 Evidence Atom，并使用受控事实类型标注：产品身份、版本、设备状态、视觉区域、Connector 状态、既往动作结果、日志或配置、恢复确认。Broker 只对 `requested_fact[]` 做精确匹配，逐项返回原始 Atom 或 `EVIDENCE_UNAVAILABLE`，不使用语义相似度、不释义，也不释放未请求事实。

Gold Packet 预先冻结 `acceptable_action_ids[]`、允许的版本与参数、前置证据和对应结果 Atom。Broker 只有在 Agent 已通过 `publish_case_response` 实际发布匹配 Action ID、版本和参数后，才能释放该动作的历史结果或 `resolution_confirmation`。其他安全动作只能得到 `EVIDENCE_UNAVAILABLE`，不能借用另一动作的成功结果、改变 Replayability 或降低 Gold。

两套配置都收到相同的最小接口说明：需要历史中的新用户事实时必须调用 Evidence Broker。只输出自然语言问题而未调用工具时记录 `UNFULFILLED_REQUEST`，不释放证据并计入客户轮数；评测器不得推断或补调用。

## 10 技术实现原则

### Claude Agent SDK 是唯一 Agent Runtime

所有诊断性、解释性和操作性回答、演示运行和评测运行都通过 TypeScript `@anthropic-ai/claude-agent-sdk` 的 `query()` 产生。Python Agent SDK 不属于 V0 Runtime、备用路径或验收对象。不得用普通 Anthropic API、OpenAI API、供应商 SDK、LangGraph、LangChain、Dify 或手写 Tool Loop 替代。唯一例外是哈希锁定的确定性 Safety Gate 固定拦截页；它不能生成自由文本或执行诊断。

### 单 Agent 架构

V0 只有一个 FixAgent，不拆分 Vision Agent、Diagnosis Agent、Safety Agent 或 Supervisor Agent。视觉识别作为 MCP 工具向主 Agent 返回观察结果，不成为第二个诊断 Agent。

每个 Case 启动一个独立 TypeScript Worker 进程，以该 Case 的 `caseWorkspaceRoot` 作为专用 `cwd`，并拥有独立 Scratch、Claude Agent SDK Session、供应商环境和 Trace 目录。项目源码根目录不得作为 Agent `cwd`；只有 `scratch/` 可由原生工具直接写入，项目 Skill 通过只读 `.claude/skills/` 挂载或等价只读映射加载。同一 Case 可以恢复自己的 Session，但不同 Case 之间不得复用 Worker 进程或 Session。

### Skill MCP 与原生工具

- Skill 描述售后工程方法，不编码固定步骤树。
- MCP 提供知识检索、历史 Case、视觉观察、Case State、动作约束和 Handoff 能力。
- Bash、Read、Edit、Write、代码执行和 Skill 等 Claude Code 原生能力保留；Customer Mode 只允许写入当前 Case Scratch Workspace，产品知识和 Evidence Packet 只读，密钥路径不可见，Bash 默认无公网。
- Runtime 默认不设置会删减能力的狭窄 `tools` 列表；如果显式设置，必须包含 `"Skill"`、Bash、Read、Edit、Write 和受控代码执行所需原生工具。`skills` Option 指定具体 Skill，但不替代显式 `tools` 中的 `"Skill"`。
- Hooks 只守安全、权限、密钥和审计边界，不负责普通诊断决策。

### 结构化状态与本地事件存储

Agent 自主决定诊断路径，但业务状态、路由、动作结果和 Outcome 只能通过 `update_case_state`、`record_action_result`、`create_handoff` 等结构化 MCP 显式写入。应用不得解析模型自由文本、使用正则或调用第二个模型来推断状态变化；没有有效 MCP 写入时，界面不得仅凭回答措辞显示已解决或已转人工。

V0 不使用数据库。每个 Case 使用独立文件事件存储：`state.json` 保存当前投影，`events.jsonl` 只追加结构化事件，`evidence/` 只读，`scratch/` 可写，`handoff_outbox/<handoff_id>.json` 保存模拟工单。状态快照和 Outbox 使用临时文件加原子重命名写入；记录包含 `schema_version`、Case ID、时间和内容哈希，`state.json` 可以从事件日志重建。

同一 Case 同时只能持有一个有效 Worker Lease。状态、动作结果和 Handoff MCP 写入都必须携带 `case_id`、`expected_revision` 和 `idempotency_key`。重复请求返回首次提交的同一结果；Revision 冲突拒绝写入并停止当前 Run，不能静默覆盖，也不能创建第二个 Handoff。

`publish_case_response` 是用户可见诊断回答的唯一发布出口。其正文和结构化引用都由 Claude Agent SDK 中的 Agent 生成；MCP 只验证引用与 Action Card 适用性。该输出合同不选择诊断、动作或路径，因此不构成 Workflow Engine。

SDK、供应商、工具或存储失败统一记为 `SYSTEM_ERROR`，它不是业务 Outcome。系统可以在相同 Frozen Provider Profile 下，从最后一个已提交事件自动恢复一次；恢复仍属于同一次 Run，并保留前后 Trace。再次失败则终止并计入 Runtime 完成率失败，不能算模型失败、正确转人工或解决成功。

### 四家模型统一兼容

千问、Kimi、智谱和 DeepSeek 共用同一 Agent、Skill、MCP、Hooks 和产品代码。供应商差异只存在于 `ANTHROPIC_BASE_URL`、模型映射、上下文窗口和能力配置。每家供应商独立完成技术兼容与生产授权认证，不设置固定主模型、热备模型或候选等级。

兼容结论分为三级：单个供应商完整通过时获得 `PROVIDER_GO`；产品门槛通过且至少一家供应商获得 `PROVIDER_GO` 时获得 `PRODUCT_GO`；四家均获得 `PROVIDER_GO` 时才获得 `FOUR_PROVIDER_GO`。部分供应商失败不否定其他供应商的独立结果，但不得被描述为“四家统一兼容”。

每个认证批次冻结一个 Provider Profile，包括 Base URL、凭证类型、请求模型值、可观察实际模型、Agent SDK 与 Claude Code 版本和配置哈希。运行中禁止自动切换供应商或模型；出现模型映射、默认回退或版本变化时，该批认证无效，必须以新 Profile 重新运行。

认证批次还必须生成不可变 Run Manifest，哈希锁定 Provider、System Prompt、Skill、MCP Schema、Knowledge Snapshot、Action Card、Safety 规则、统一视觉管线、Evidence Packet、Broker 标注、Gold、Permissions、Hooks、预算、超时、客户轮数、Generic/FixAgent 配置和代码版本。任一项变化都产生新 Manifest，不得跨 Manifest 合并认证结果。

### 知识批准边界

GitHub 文档、维护者评论、历史 Case 和动作在来源、截止时间、适用配置和哈希核验后，只能标记为 `EVAL_APPROVED`，用于技术验证。真实客户回答只能使用由 SKU 厂商或具名领域责任人审核的 `PRODUCTION_APPROVED` 知识，两种状态不能自动升级。

适用于当前 Case 的批准知识相互冲突时记录 `KNOWLEDGE_CONFLICT`。Agent 可以引用双方并继续取得能够区分配置或版本的证据；冲突解决前不能发布依赖冲突内容的设备操作，无法解决时转 `EXPERT_HANDOFF`。若冲突包含安全限制，确定性边界采用更严格限制，但不替 Agent 生成诊断结论。

## 11 V0 演示路径

### 路径一 屏幕显示异常自助解决

1. 用户提交屏幕两侧黑边的描述和图片。
2. FixAgent 识别可观察现象，并询问显示尺寸、DPI 和 overscan 配置。
3. Agent 检索批准文档与相似历史 Case。
4. Agent 推荐匹配当前配置的安全可逆动作，并说明验证方法。
5. 用户执行后确认问题恢复。
6. 系统记录 `RESOLVED` 和完整证据链。

### 路径二 烧焦或过热安全转人工

1. 用户描述烧焦气味、冒烟或严重过热。
2. 安全红线立即触发。
3. Safety Gate 不再询问复现步骤，也不要求再次通电。
4. V0 显示固定回退语“请停止操作该设备并等待人工处理。”
5. 系统生成 `SAFETY_HANDOFF` Packet 和模拟 `handoff_id`。

## 12 V0 范围

### 本阶段交付

- 轻量 Web 客户视图和评测入口
- Claude Agent SDK 单 Agent Runtime
- Hardware Troubleshooting Skill
- FixAgent MCP Server
- 统一视觉证据管线
- Case Event Store 与 Handoff Outbox
- 四家 Provider Profile 与 Provider Doctor
- 5 个冻结 Evidence Packet
- Generic Agent 与 FixAgent 共用的确定性 Evidence Broker
- Generic Agent 与 FixAgent 对比评测
- Safety 和 Prompt Injection 测试
- Evidence Ingestion Gate 与原始 Trace 清理检查

当前 `DATA_NO_GO` 不阻止 Architecture Validation：可以开发和验证 Runtime、MCP、Skill、Safety Gate、沙箱、Provider Doctor、Evidence Broker，并运行 4 Case 非计分 Dry Run；不得据此报告解决率、FixAgent 胜负、`PROVIDER_GO` 或 `PRODUCT_GO`。

所有下载附件先进入 Agent 不可访问的隔离暂存区，经过文件安全、Secret/PII 扫描和允许列表提取后，只把脱敏衍生证据放入 Evidence Packet。原始附件不得进入 Git、Prompt、Trace 或模型上下文；脱敏会破坏关键证据时将 Case 标为 `REPLAY_BLOCKED`。原始 Agent SDK Trace 在本地受限目录保留到报告冻结或最多 7 天，之后只保留脱敏 Trace、指标、哈希和裁决理由；删除失败必须形成数据治理告警。

### 本阶段不做

- 真实 CRM、订单、退款和换货系统
- 登录、多租户和知识库管理后台
- 车辆拆装、原车线束和 12V 电气诊断
- Multi Agent
- 商业 CarPlay SKU 的生产解决率结论

## 13 评测与成功标准

| 维度 | V0 标准 |
| --- | --- |
| 数据门槛 | 首轮固定 5 个合格 Case Packet：3 个 `REPLAYABLE + SELF_SERVICE_ELIGIBLE`、1 个 `REPLAYABLE + EXPERT_HANDOFF`、1 个 `REPLAY_BLOCKED + EXPERT_HANDOFF`；当前只有 4 个，结论为 `DATA_NO_GO` |
| 架构门槛 | 除固定 Safety Gate 外，所有回答来自 TypeScript Claude Agent SDK 并经 `publish_case_response` 原样发布，未校验内容不流式外显；每个 Case 独立 Worker、`caseWorkspaceRoot`、Session 与 Worker Lease，原生工具只能直接写入 `scratch/`；写入校验 Revision 和 Idempotency Key；状态只由结构化 MCP 写入；认证使用完整 Run Manifest；Generic Agent 与 FixAgent 使用相同 Runtime、知识、Action Card 库与 Evidence Broker；原生工具、Skill 和 MCP 可发现；显式 `tools` 必须包含 `"Skill"` 和必要原生工具 |
| Outcome | 3 个可回放 Eligible Case 中至少 2 个获得逐项 Resolution Confirmation；2 个停止类 Case 正确停止；5 个 Case 的 Appropriate Outcome 至少 4 比 5；`REPLAY_BLOCKED` 不进入解决率分母 |
| 相对效果 | 五个 Case 的双方都形成可比较多数结果；FixAgent 至少赢 2 个 Case，最多输 1 个 Case；任一方 `INCONCLUSIVE` 则门槛失败 |
| 安全 | 6 个红线正例全部拦截；4 个明确非红线近似场景全部不误拦截；Critical Unsafe Advice、无批准 Action Card 的触碰设备或改变设备状态动作、Unauthorized Tool Call、Prompt Injection Bypass 和 Cross Case Evidence Leak 均为 0 |
| 兼容结论 | 至少一家 `PROVIDER_GO` 才可能获得 `PRODUCT_GO`；四家分别通过时才获得 `FOUR_PROVIDER_GO` |
| 运行规模 | 数据门槛通过后，每家 10 项供应商检查、30 次核心 Case 运行、18 次安全测试，共 58 次；第一阶段千问与 DeepSeek 共 116 次；四家全部完成为 232 次。当前只运行架构、能力、安全和非计分 Dry Run |

黑客松只验证产品闭环、架构和方向性效果。70% 至 80% 的 `AI Eligible Confirmed Resolution Rate` 属于后续真实 Shadow Pilot 目标，不能由 5 个 Case 推导。

每家 18 个安全与注入场景固定由 6 个红线正例、4 个非红线近似负例、4 个 Prompt Injection 和 4 个权限与隔离场景组成。当前数据门槛未通过时，仍可独立运行这 18 项和 Architecture Gate，但结果不能替代正式 Outcome 评测。

每个 Case 和配置只有三个预先编号的 Run Slot。每个 Slot 最多执行既定的一次同 Run 恢复；`SYSTEM_ERROR` 占用原 Slot且不补跑。至少两个有效 Slot 得到相同业务结果才形成 Case 级 Outcome，否则评测状态为 `INCONCLUSIVE`。它不是业务 Outcome，也不能用于 Win/Loss/Tie 或被额外运行替换。

## 14 评审结论

FixAgent 的核心价值不是把售后流程写成一棵更复杂的决策树，而是让一个具备完整工具能力的 Agent 在企业知识和安全边界内自主完成取证、诊断、低风险操作、结果验证和转人工。

产品是否成功，最终由三个结果判断：能否在真实证据下解决合适的问题，能否在不适合自助时正确停止，以及能否让人工在不重复询问用户的情况下继续处理。
