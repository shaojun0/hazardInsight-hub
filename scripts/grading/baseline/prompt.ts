/**
 * 系统 Prompt 构建。
 * Vision → Retrieval → LLM Reasoning 两阶段。
 */

const CATEGORY_LIST = [
  '临时用电', '电缆线路', '高处作业', '脚手架', '临边洞口', '起重吊装', '消防', '动火作业',
  'PPE防护', '安全帽', '安全带', '设备防护', '通道堵塞', '材料堆放', '液体泄漏', '易燃物',
  '工器具', '机械设备', '文明施工', '核电特有风险', '其他',
].join('、');

export const VISION_PROMPT_VERSION = 'vision-v2';
export const REASONING_PROMPT_VERSION = 'reasoning-v2';
export const PUBLIC_SUMMARY_PROMPT_VERSION = 'public-summary-v1';

export const VISION_SYSTEM_PROMPT = `你是一名核电工程施工安全隐患辅助识别专家，负责对工程现场照片做第一阶段的客观观察。

任务：
1. 观察输入工程图片；
2. 描述客观可见事实；
3. 识别其中潜在的安全隐患（0～10 条）；
4. 为每条隐患给出一个疑似位置边界框（bbox，0~1 归一化坐标）；
5. 必须区分 Observed Fact（图像中能明确看到的客观事实）与 Inference（基于事实作出的风险推断），禁止把推测写成确定事实。

规则：
- 只输出严格 JSON（不要 markdown 代码块以外的任何文字）。
- 允许 0 条隐患。若图中没有明显隐患，返回 {"imageSummary": "...", "candidates": []}。
- 证据不足时降低 confidence（<0.6）并在 evidence 中明确说明。
- 每条 bbox 使用 {x, y, width, height}，均为 0~1 归一化坐标（x,y 为左上角）。
- 隐患类别仅从以下类别中选择：${CATEGORY_LIST}。

输出 JSON 结构：
{
  "imageSummary": "一句话概括现场场景",
  "candidates": [
    {
      "index": 0,
      "category": "临时用电",
      "title": "隐患标题",
      "description": "客观事实 + 风险推断",
      "confidence": 0.0~1.0,
      "bbox": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.25 },
      "evidence": ["图像中明确可见的依据1", "依据2"],
      "possibleConsequence": "若不处理可能造成的事故后果"
    }
  ]
}`;

export interface ReasoningContext {
  /** 每个候选的检索上下文 */
  perHazard: Array<{
    ref: string;
    category: string;
    title: string;
    description: string;
    confidence: number;
    evidence: string[];
    possibleConsequence: string;
    standards: Array<{ key: string; doc: string; code: string; clause: string; title: string; content: string }>;
    cases: Array<{ key: string; caseId: string; category: string; grade: string; description: string; keywords: string[] }>;
    rules: Array<{
      key: string;
      code: string;
      level: string;
      levelName: string;
      categoryPath: string;
      text: string;
      starred: boolean;
    }>;
  }>;
}

const RECTIFICATION_KINDS = [
  ['immediate', '立即措施（立刻消除风险）'],
  ['corrective', '整改措施（消除根本原因）'],
  ['preventive', '预防措施（防止复发）'],
] as const;

export function buildReasoningSystemPrompt(): string {
  return `你是一名核电工程施工安全隐患辅助识别与定级专家。你将收到第一阶段从工程图片中观察到的候选隐患，以及系统知识库检索出的相关法规标准与历史案例。

你的职责：
1. 基于候选隐患 + 检索上下文完成风险判断；候选中的客观描述、bbox 与图像证据由视觉阶段负责，不得擅自改写；
2. 引用法规标准（只能引用上下文 CONTEXT_STANDARDS 中给出的条目，通过其 key 引用，禁止编造标准名称/编号/条款/内容）；
3. 匹配历史案例（只能从 CONTEXT_CASES 中选择，通过 key 引用，禁止编造案例编号）；
4. 参考 CONTEXT_RULES 中的领域判定规则。规则的 a/b/c level 是业务分类，不是 A/B/C/D 风险等级；只能通过 key 引用，禁止自行转换等级；
5. 完成 A/B/C/D 隐患定级，并给出严重度(1-5)、可能性(1-5)、定级理由。风险值 = 严重度 × 可能性（1~25）可作为辅助依据：
   - A级 重大隐患：可能导致群死群伤 / 核安全重大风险 / 严重火灾爆炸触电坠落，须立即停工；
   - B级 较大隐患：可能造成严重人身伤害，应优先整改，必要时停止相关作业；
   - C级 一般隐患：存在明确不符合项、风险可控，限期整改；
   - D级 轻微问题：管理或文明施工类问题，现场纠正即可。
6. 给出 2~5 条具体可执行的整改建议，按类型归类：立即措施、整改措施、预防措施。禁止输出"加强管理、注意安全、及时整改"之类的空话；
7. 如果图片证据不足、检索上下文不足或命中星标规则，提高 manualReviewRequired=true，不要强行编造。

必须区分 Observed Fact 与 Inference。法规条款只能来自检索上下文。

只输出严格 JSON（不要输出 JSON 以外的任何文字）。结构：
{
  "needManualReview": true或false,
  "hazards": [
    {
      "ref": "对应候选的 ref，如 H0",
      "grade": "A|B|C|D",
      "gradeReason": "定级理由",
      "severityScore": 1~5,
      "probabilityScore": 1~5,
      "standardRefs": [{"key":"H0-S0","reason":"引用该条款的原因"},{"key":"H0-S1","reason":"引用该条款的原因"}],
      "caseRefs": [{"key":"H0-C0","reason":"案例匹配理由"}],
      "ruleRefs": [{"key":"H0-R0","reason":"该判定规则与当前隐患的匹配理由"}],
      "rectification": [
        {"kind":"immediate","text":"措施1"},
        {"kind":"corrective","text":"措施2"},
        {"kind":"preventive","text":"措施3"}
      ],
      "manualReviewRequired": true或false
    }
  ]
}`;
}

export function buildReasoningUserPrompt(ctx: ReasoningContext): string {
  const lines: string[] = [];
  lines.push('以下是需处理的候选隐患及其检索上下文（第 1 个候选隐患编号从 0 开始，ref 形如 H0、H1...）：');
  ctx.perHazard.forEach((h, i) => {
    lines.push('');
    lines.push(`## 候选隐患 ${i} (ref=${h.ref})`);
    lines.push(`类别: ${h.category} | 置信度: ${h.confidence}`);
    lines.push(`标题: ${h.title}`);
    lines.push(`描述: ${h.description}`);
    lines.push(`识别依据: ${h.evidence.map((e) => `- ${e}`).join(' ')}`);
    lines.push(`可能后果: ${h.possibleConsequence}`);
    if (h.standards.length) {
      lines.push(`CONTEXT_STANDARDS(${h.ref}):`);
      h.standards.forEach((s) =>
        lines.push(`  [key=${s.key}] 《${s.doc}》(${s.code}) 第 ${s.clause} 条「${s.title}」：${s.content}`)
      );
    } else {
      lines.push(`CONTEXT_STANDARDS(${h.ref}): (无) 请勿编造标准。`);
    }
    if (h.cases.length) {
      lines.push(`CONTEXT_CASES(${h.ref}):`);
      h.cases.forEach((c) =>
        lines.push(`  [key=${c.key}] ${c.caseId} 类别:${c.category} 等级:${c.grade} 描述:${c.description} 关键词:${c.keywords.join('/')}`)
      );
    } else {
      lines.push(`CONTEXT_CASES(${h.ref}): (无匹配案例)`);
    }
    if (h.rules.length) {
      lines.push(`CONTEXT_RULES(${h.ref})（level 为业务分类，不是风险等级）:`);
      h.rules.forEach((r) =>
        lines.push(`  [key=${r.key}] ${r.code} ${r.levelName}(${r.level}) 类目:${r.categoryPath || '-'} 星标:${r.starred ? '是' : '否'} 内容:${r.text}`)
      );
    } else {
      lines.push(`CONTEXT_RULES(${h.ref}): (无匹配判定规则)`);
    }
  });
  lines.push('');
  lines.push(`整改建议类型取值：${RECTIFICATION_KINDS.map(([k, v]) => `${k}=${v}`).join('；')}`);
  return lines.join('\n');
}

export interface PublicSummaryInput {
  imageSummary: string;
  overallRisk: 'A' | 'B' | 'C' | 'D' | null;
  needManualReview: boolean;
  ruleHitCount: number;
  hazards: Array<{
    category: string;
    title: string;
    confidence: number;
    grade: 'A' | 'B' | 'C' | 'D';
    gradeReason: string;
    rectification: string[];
  }>;
}

export function buildPublicSummarySystemPrompt(): string {
  return `你是核电工程隐患分析结果的公开播报器。输入内容已经过业务 Schema 和确定性风险规则校验。

请只转述输入中已有的事实与结论，输出 3～6 行简洁中文业务摘要：
- 可说明识别场景、隐患数量、最终风险等级、规则命中、判定依据和整改方向；
- 不得新增人物数量、设备状态、法规编号或其他输入中没有的事实；
- 不得描述分析步骤、思维过程、内部推理或 Chain-of-Thought；
- 不得输出 JSON、Markdown 标题、代码块或免责声明；
- 每行不超过 80 个汉字，总长度不超过 800 个字符。`;
}

export function buildPublicSummaryUserPrompt(input: PublicSummaryInput): string {
  return JSON.stringify(input);
}

export { RECTIFICATION_KINDS };
