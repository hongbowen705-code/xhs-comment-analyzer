# 小红书评论分析工具（阶段二开发版 V0.6）

Windows/Chrome 开发者版本：用户主动触发后，在专用可见标签页中低频、只读地读取单篇笔记评论，生成一个可交给网页版 GPT 的 `gpt_upload.json`，再导入一个 `gpt_result.json`。确定性统计和 HTML 报告始终由本地程序完成。

## 安全边界

- 不要求或保存账号密码、Cookie、请求头、昵称、完整网络响应。
- 不包含点赞、收藏、关注、评论、私信或发布操作。
- 一次只允许一个任务；验证码、登录异常、关闭标签页或用户停止会终止采集。
- 仅对高回复、高互动的少量一级评论尝试展开可见楼中楼，不自动展开全部讨论。
- 被动响应观察器只克隆页面自身已经发起的评论响应，不主动请求任何接口。
- 页面结构变化时宁可标记字段缺失或暂停，也不补造数据。

## 环境

- Windows 10/11
- Google Chrome
- Node.js 25.5 或更高版本（当前开发机为 Node 26）
- npm；PowerShell 中统一使用 `npm.cmd`，不需要修改执行策略

## 构建

```powershell
npm.cmd install
npm.cmd run test
npm.cmd run typecheck
npm.cmd run build
```

构建产物：

- Chrome 解压扩展：`apps\extension\dist`
- Native Host：`apps\native-host\dist\xhs-comment-native-host.exe`
- Electron 桌面端：`apps\desktop\dist`

## 注册与启动

1. 注册当前用户级 Native Messaging Host：

   ```powershell
   npm.cmd run register:native-host
   npm.cmd run diagnose:native-host
   ```

2. 打开 `chrome://extensions`，启用“开发者模式”，选择“加载已解压的扩展程序”，目录为：

   ```text
   <仓库>\apps\extension\dist
   ```

   固定开发扩展 ID 应为 `fghibfonhbgiolhahjhagnngpcglgmje`。

3. 启动桌面端：

   直接双击仓库根目录中的：

   ```text
   启动小红书评论分析工具.cmd
   ```

   或在 PowerShell 中运行：

   ```powershell
   npm.cmd run start:desktop
   ```

4. 在已登录的小红书 Chrome 标签页中打开一篇视频或图文笔记，点击扩展中的“分析当前目标”。

扩展中的采集规模会持久保存。开始后，扩展状态和桌面端“采集模式”都应明确显示本次上限为 50、100、500、1000、2000 或 3000；任务结束后可在 `manifest.json` 的 `capture.requested_limit` 再次核对。深度模式仍保持单任务、可见、低频和只读，遇到验证或访问限制立即暂停。

默认数据目录为 `D:\XHSCommentAnalyzer\prototype`。如果目录不可写，在桌面窗口选择其他明确目录后再创建任务。

## 输出

```text
task_<task_id>\
├─ manifest.json
├─ note.json
├─ comments.jsonl
├─ threads.jsonl
├─ duplicate_clusters.json
├─ analysis-package.json
├─ gpt_upload.json
├─ prompt.md
├─ README.txt
├─ audit.jsonl
├─ sampling.json
├─ checkpoint.json
├─ diagnostics.json
├─ batch-index.json
├─ batches\
│  └─ batch_001.jsonl
└─ ai_results\
```

`audit.jsonl` 不记录评论正文或身份信息；`platform_write_count` 必须始终为 `0`。

`sampling.json` 基于当前顺序候选集生成本地“互动优先/时间优先”代理分层，不声称是平台热门或最新排序。`checkpoint.json` 保存已确认批次和校验值，但软件重启后仍须由用户主动触发恢复。

分析批次按字符量切分并优先保持完整讨论线程，但普通的 50/100 条任务无需手动操作这些批次。
每个批次同时生成可直接上传的 `batches\gpt_batch_001.json` 等文件。500—3000 条任务若一次性输出不稳定，可逐批让 ChatGPT 只返回 `classifications`，再在桌面端多选导入这些 JSON/JSONL 文件。

## GPT 分析闭环

1. 采集结束后，在桌面端点击“找到 GPT 上传文件”。
2. 将 `gpt_upload.json` 上传到网页版 ChatGPT。
3. ChatGPT 必须返回一个完整 JSON 对象；保存为 `gpt_result.json`。
4. 在桌面端点击“导入 GPT 结果 JSON”。
5. 校验通过后点击“打开总结报告”。

大任务的分步流程：

1. 依次上传 `batches\gpt_batch_*.json`，保存各批返回的 JSON。
2. 点击“导入分批分类 JSONL”并一次多选全部返回文件；程序会检查全量覆盖并合并。
3. 分类全部通过后，程序生成 `gpt_analysis_upload.json`。
4. 上传该文件生成总体语义分析，再点击“导入总体分析 JSON”。
5. 本地程序校验证据 ID、重算统计并生成报告。

导入会拒绝不存在或遗漏的评论 ID、重复结果、非法固定类别、越界评分、无效语境引用，以及观点/争议中不存在的证据 ID。全部通过后生成：

```text
ai_results\
├─ classification-merged.jsonl
├─ classification-index.json
├─ classification-validation.json
├─ analysis-stats.json
├─ review-queue.json
├─ analysis_result.json
└─ gpt-import-validation.json

report_private\
├─ index.html
├─ report-data.json
└─ integrity.json
```

`analysis-stats.json` 中的类别比例、态度比例、点赞对数加权比例和综合信息价值均由本地固定公式计算。
`review-queue.json` 按低置信度、语境不足、反讽、高互动低置信度等规则生成，并保存原始 AI 结果供后续人工修订。

`report_private/index.html` 汇总 GPT 的语义结论与本地计算的态度、类别比例，并把观点、争议、共识和待核验声明追溯到具体评论 ID。

待外部核验声明只进行类型识别，不联网查询，也不判断真假。固定类型包括产品或服务效果、价格或交易信息、健康或安全、政策/规则/平台机制、身份或资质、事件或时间线、数据或规模、因果关系及其他可核验声明。所有声明的 `verification_status` 固定为 `unverified`；旧版结果缺少类型时会兼容归入“其他可核验声明”。

## 人工复核与报告

- 桌面端会按优先级逐条显示待复核评论。
- 复核队列使用本地高风险精简规则：普通任务最多取评论总数的 5%，小任务至少保留 10 个候选名额，大任务最多 80 条；GPT 的主动复核标记不会单独决定入队。
- 已有任务可点击“应用精简审核规则”重新筛选；已完成复核会保留，旧队列先备份到 `ai_results/review-queue-history`。
- 可修改主要类别、态度和次要标签，修改原因必填。
- 每次修改写入 `ai_results/manual-revisions.jsonl`，保留原始 AI 结果、修改前后结果、字段、时间和原因。
- 保存后自动重新计算统计，并重新生成完整版与分享版报告。
- 完整版采用仪表盘布局，提供概览数字卡、态度环形图、类别与属地条形图、时间趋势、主题标签云和类别×态度热力图。
- 主要观点、争议、共识、待核验声明和高价值评论均为逐项折叠卡片，并支持区块内全部展开或全部收起。
- 全部评论仅作为审计明细默认折叠；展开后仍支持评论内容/ID搜索、态度筛选、类别筛选和证据跳转。
- `report_share.html` 仅保留代表性证据评论，不包含单条IP属地、本地路径或身份字段。
- `privacy-scan.json` 记录分享版隐私扫描结果；未通过时不会生成分享版。

## V0.6 日常使用能力

- 首页显示最近任务列表、采集数量、分析/报告/分享状态及待复核数量，可直接切换任务。
- 人工复核支持选择任意待复核评论、上一条、下一条、稍后处理和“一键确认AI判断”。
- 楼中楼复核显示根评论、父评论和同线程回复上下文。
- GPT结果只有少量评论失败时生成 `gpt_repair_request.json`，只补交失败评论；修复结果会与原结果合并。
- 运行诊断显示扩展连接数、平台写入计数、数据目录占用、磁盘可用空间和6GB限制状态。
- 报告保存采集、分析、报告、评分公式和人工修订版本信息。
- 暂停或失败的任务可在桌面端由用户主动恢复；扩展重新打开专用标签页并跳过已有评论，不会自动恢复访问。
- SQLite 元数据库位于数据根目录的 `database\metadata.sqlite`，旧任务在任务列表扫描或报告生成时自动迁移。
- 报告增加评论时间分布与公开 IP 属地聚合；少于 3 条的属地统一合并为“其他（小样本）”。
- 存储页提供清理预览；自动执行范围仅限缓存和超过 30 天的日志，绝不自动删除评论原文或报告。

## 一键安装或更新开发版

双击根目录中的 `安装或更新开发版.cmd`。它会依次执行测试、构建、当前用户级 Native Host 注册、连接诊断并创建桌面快捷方式，不要求修改 PowerShell 执行策略。完成后仍需在 `chrome://extensions` 中加载或刷新 `apps\extension\dist`。

## Windows 安装包

正式的当前用户级安装包生成命令：

```powershell
npm.cmd run package:win
```

产物位于 `release\XHS-Comment-Analyzer-Setup-0.6.0.exe`。安装不要求管理员权限，桌面端首次启动会注册随安装包提供的 Native Host；卸载会移除该注册项，但默认保留用户任务数据。扩展文件随安装包放在安装资源的 `chrome-extension` 目录，仍需由用户在 Chrome 扩展管理页确认加载。

当前安装包未使用商业代码签名证书，Windows 可能显示未知发布者提示。生产发布前应购买并配置代码签名证书。

## 诊断与注销

```powershell
npm.cmd run diagnose:native-host
npm.cmd run unregister:native-host
```

注销脚本只移除当前用户的 Native Messaging 注册项，不删除构建产物或任务数据。

## 手工验收

- 分别测试一篇视频笔记和图文笔记。
- 确认新建专用标签页、滚动过程可见。
- 在桌面端点击停止，并确认一个采集周期内终止。
- 关闭专用标签页，确认任务变为暂停。
- 检查 `comments.jsonl` 每行均可解析、ID 不重复、缺失字段为 `null`。
- 检查 `manifest.json` 的文件校验值与字段完整率。
- 检查所有审计记录的 `platform_write_count` 均为 `0`。
