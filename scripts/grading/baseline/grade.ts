/** Frozen numerical guard from commit 604b13da10d7eda0699c61a7648e8fd69d521e55.
 * Benchmark fixture only. Never imported by production.
 */
import type { Grade } from '../../../shared/types.js';
export function baselineGuard(input: {grade: Grade; severityScore: number; probabilityScore: number}) {
  const clamp=(n:number)=>Number.isFinite(n)?Math.min(5,Math.max(1,Math.round(n))):3;
  const sev=clamp(input.severityScore),prob=clamp(input.probabilityScore),score=sev*prob;
  const grade:Grade=sev>=5 || score>=15?'A':score>=9 || sev>=4?'B':score>=4 || sev>=3?'C':'D';
  return {grade,severityScore:sev,probabilityScore:prob,riskScore:score,adjusted:grade!==input.grade};
}
