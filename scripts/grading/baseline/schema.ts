/**
 * 大模型输出 Schema 校验与容错（Zod）。
 * 所有模型 JSON 必须先解析、后校验，无效数据不得直接进入前端。
 */
import { z } from 'zod';

const bboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * 阶段一：视觉识别候选隐患（vision stage）。
 * 只要求客观可见事实 + 保守推断。
 */
export const visionCandidateSchema = z.object({
  index: z.number().int().min(0).max(9),
  category: z.string().min(1).max(20),
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(1200),
  confidence: z.number().min(0).max(1),
  bbox: bboxSchema,
  evidence: z.array(z.string().min(1).max(300)).min(1).max(12),
  possibleConsequence: z.string().min(1).max(500),
});

export const visionResultSchema = z.object({
  imageSummary: z.string().min(1).max(500).default('工程现场图片'),
  candidates: z.array(visionCandidateSchema).max(10).default([]),
  lowEvidence: z.boolean().optional(),
});

/** 阶段二：推理定级输出（reasoning stage）。法规/案例以引用键引用上下文，服务端解析为真实数据。 */
export const modelRectificationSchema = z.object({
  kind: z.enum(['immediate', 'corrective', 'preventive']),
  text: z.string().min(2).max(200),
});

export const modelHazardSchema = z.object({
  ref: z.string().min(1).max(64),
  grade: z.enum(['A', 'B', 'C', 'D']),
  gradeReason: z.string().min(1).max(1000),
  severityScore: z.number().int().min(1).max(5),
  probabilityScore: z.number().int().min(1).max(5),
  standardRefs: z
    .array(
      z.object({
        key: z.string().min(1),
        reason: z.string().min(1).default('该条款与本隐患的识别依据相吻合。'),
      })
    )
    .max(6)
    .default([]),
  caseRefs: z
    .array(
      z.object({
        key: z.string().min(1),
        reason: z.string().min(1).default('历史案例特征与该隐患相似。'),
      })
    )
    .max(3)
    .default([]),
  ruleRefs: z
    .array(
      z.object({
        key: z.string().min(1),
        reason: z.string().min(1).default('该判定规则与当前隐患特征相匹配。'),
      })
    )
    .max(5)
    .default([]),
  rectification: z.array(modelRectificationSchema).min(2).max(6),
  manualReviewRequired: z.boolean().default(false),
});

export const reasoningResultSchema = z.object({
  needManualReview: z.boolean().default(false),
  hazards: z.array(modelHazardSchema).max(10).default([]),
});

export type VisionCandidate = z.infer<typeof visionCandidateSchema>;
export type ModelHazard = z.infer<typeof modelHazardSchema>;
export type ReasoningResult = z.infer<typeof reasoningResultSchema>;

/** 安全解析模型 JSON，异常返回 null（由调用方走容错/人工复核）。 */
export function safeParseModelJson<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const candidate = text.slice(start, end + 1);
    const json = JSON.parse(candidate);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      console.warn('[hazard] 模型 JSON 校验失败:', parsed.error.issues.map((i) => i.path.join('.')).join(','));
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn('[hazard] 模型 JSON 解析失败:', (err as Error).message);
    return null;
  }
}

/** 将 bbox 修正到 0~1 合法范围。 */
export function clampBBox(b: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let { x, y, width, height } = b;
  if (!Number.isFinite(x) || !Number.isFinite(width)) {
    x = 0;
    width = 0.1;
  }
  if (!Number.isFinite(y) || !Number.isFinite(height)) {
    y = 0;
    height = 0.1;
  }
  width = Math.max(0.02, clamp01(width));
  height = Math.max(0.02, clamp01(height));
  x = Math.min(clamp01(x), 1 - width);
  y = Math.min(clamp01(y), 1 - height);
  return { x, y, width, height };
}
