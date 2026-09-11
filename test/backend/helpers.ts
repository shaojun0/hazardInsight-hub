/**
 * 测试用确定性多模态 Provider（Mock 演示模式已从生产移除，测试通过本 Provider 注入固定结果）。
 * desk：3 个候选隐患（B/C/D）；clean：无隐患；其他场景默认按 desk 处理。
 */
import type { ImagePayload, ModelCallOptions, ModelCallResult, MultimodalModelProvider, StreamingModelCallOptions } from '../../server/providers/types.js';

export interface TestCandidate {
  index: number;
  category: string;
  title: string;
  description: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
  evidence: string[];
  possibleConsequence: string;
}

const DESK_CANDIDATES: TestCandidate[] = [
  {
    index: 0,
    category: '高处作业',
    title: '高处作业防护不足',
    description: '脚手架作业人员未系安全带。',
    confidence: 0.86,
    bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
    evidence: ['作业人员未系挂安全带'],
    possibleConsequence: '高处坠落',
  },
  {
    index: 1,
    category: '临时用电',
    title: '配电箱接线不规范',
    description: '配电箱内线缆裸露、无警示标识。',
    confidence: 0.78,
    bbox: { x: 0.4, y: 0.4, width: 0.25, height: 0.25 },
    evidence: ['线缆裸露', '无警示标识'],
    possibleConsequence: '触电或短路',
  },
  {
    index: 2,
    category: '消防管理',
    title: '消防通道被占用',
    description: '消防通道堆放杂物。',
    confidence: 0.72,
    bbox: { x: 0.6, y: 0.2, width: 0.3, height: 0.25 },
    evidence: ['通道堆放杂物'],
    possibleConsequence: '火灾时疏散受阻',
  },
];

interface ReasoningHazard {
  ref: string;
  grade: 'A' | 'B' | 'C' | 'D';
  gradeReason: string;
  severityScore: number;
  probabilityScore: number;
  standardRefs: Array<{ key: string; reason: string }>;
  caseRefs: Array<{ key: string; reason: string }>;
  ruleRefs: Array<{ key: string; reason: string }>;
  rectification: Array<{ kind: 'immediate' | 'corrective' | 'preventive'; text: string }>;
  manualReviewRequired: boolean;
}

const DESK_HAZARDS: ReasoningHazard[] = [
  {
    ref: 'H0',
    grade: 'B',
    gradeReason: '高处作业防护缺失，存在坠落风险。',
    severityScore: 4,
    probabilityScore: 3,
    standardRefs: [],
    caseRefs: [],
    ruleRefs: [],
    rectification: [
      { kind: 'immediate', text: '立即停止该区域作业并隔离。' },
      { kind: 'corrective', text: '补挂安全带并复核防护措施。' },
    ],
    manualReviewRequired: false,
  },
  {
    ref: 'H1',
    grade: 'C',
    gradeReason: '临时用电管理不规范。',
    severityScore: 3,
    probabilityScore: 2,
    standardRefs: [],
    caseRefs: [],
    ruleRefs: [],
    rectification: [
      { kind: 'immediate', text: '切断电源并设置警示。' },
      { kind: 'corrective', text: '整改配电箱接线。' },
    ],
    manualReviewRequired: false,
  },
  {
    ref: 'H2',
    grade: 'D',
    gradeReason: '消防通道局部占用。',
    severityScore: 2,
    probabilityScore: 1,
    standardRefs: [],
    caseRefs: [],
    ruleRefs: [],
    rectification: [
      { kind: 'immediate', text: '清理通道杂物。' },
      { kind: 'corrective', text: '加强日常巡查。' },
    ],
    manualReviewRequired: false,
  },
];

function testUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cachedTokens: 0,
    totalTokens: inputTokens + outputTokens,
    cachedTokensAvailable: true,
    cachedTokensAreInputSubset: true as const,
    source: 'provider' as const,
  };
}

export class TestProvider implements MultimodalModelProvider {
  readonly providerId = 'test-provider';
  readonly name = 'test-vision-model';

  constructor(private readonly scenario: string) {}

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async vision(_text: string, _image: ImagePayload, _options?: ModelCallOptions): Promise<ModelCallResult> {
    const candidates = this.scenario === 'clean' ? [] : DESK_CANDIDATES;
    const text = JSON.stringify({ imageSummary: `${this.scenario} 场景`, candidates, lowEvidence: false });
    return { text, attempts: 1, usage: testUsage(0, Math.ceil(text.length / 3)), finishReason: 'test' };
  }

  async visionStream(text: string, image: ImagePayload, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    const result = await this.vision(text, image, options);
    for (let offset = 0; offset < result.text.length; offset += 48) {
      if (options.signal?.aborted) throw new Error('模型请求已取消');
      options.onTextDelta(result.text.slice(offset, offset + 48));
    }
    return result;
  }

  async chat(): Promise<ModelCallResult> {
    return this.reasoning();
  }

  async chatStream(system: string, _user: string, options: StreamingModelCallOptions): Promise<ModelCallResult> {
    if (system.includes('只输出严格 JSON')) {
      const result = await this.reasoning();
      options.onTextDelta(result.text);
      return result;
    }
    const text = '已完成工程现场图像、规则与知识依据的综合核验。';
    options.onTextDelta(text);
    return { text, attempts: 1, usage: testUsage(0, 1), finishReason: 'stop' };
  }

  private reasoning(): ModelCallResult {
    const hazards = this.scenario === 'clean' ? [] : DESK_HAZARDS;
    const text = JSON.stringify({ needManualReview: false, hazards });
    return { text, attempts: 1, usage: testUsage(0, Math.ceil(text.length / 3)), finishReason: 'stop' };
  }
}
