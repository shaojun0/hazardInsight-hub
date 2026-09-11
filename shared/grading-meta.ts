/**
 * A/B/C/D 分级定义（演示分级标准，服务端与前端共用）。
 */
import type { Grade } from './types';

export interface GradeDefinition {
  label: string;
  rule: string;
  color: string;
}

export const GRADE_DEFINITIONS: Record<Grade, GradeDefinition> = {
  A: {
    label: '重大隐患',
    color: '#b42318',
    rule: '可信严重后果、关键屏障失效、实际暴露及迫近危险同时得到事实支持，立即停止相关作业并隔离。企业风险处置等级，法规重大事故隐患另行核定。',
  },
  B: {
    label: '较大隐患',
    color: '#c2410c',
    rule: '企业较大隐患条款的完整条件成立，或严重后果、关键屏障失效及暴露路径得到证实。优先整改，必要时停止相关作业。',
  },
  C: {
    label: '一般隐患',
    color: '#a16207',
    rule: '明确的物理或功能缺陷形成事故路径，未满足A/B完整条件。限期整改；信息不足时标为暂定并复核。',
  },
  D: {
    label: '轻微问题',
    color: '#1d4ed8',
    rule: '后果轻微、风险局部且未损害关键安全功能的记录、标识或现场秩序问题，现场纠正；信息不足不能作为低风险证据。',
  },
};
