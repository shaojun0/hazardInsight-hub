/** Compact evidence record, not a free-form reasoning transcript. IDs refer to input quotes. */
export interface RiskAssessment {
  facts: Array<{ id: string; text: string }>;
  scenarios: Array<{
    accident: string;
    severityScore: number;
    probabilityScore: number;
    severityBasis: string[];
    probabilityBasis: string[];
    exposure: 'none' | 'possible' | 'present' | 'multiple' | 'unknown' | 'not_applicable';
    exposureBasis: string[];
    barrier: 'intact' | 'degraded' | 'failed' | 'unknown' | 'not_applicable';
    barrierBasis: string[];
    immediateDanger: boolean | null;
    immediateBasis: string[];
  }>;
  ruleChecks: Array<{
    ruleId: string;
    conditions: Array<{ id: string; status: 'met' | 'not_met' | 'unknown'; factIds: string[] }>;
  }>;
  informationGaps: string[];
}

export interface GradingTrace {
  policyVersion: string;
  assessment?: RiskAssessment;
  candidateLevel: 'A' | 'B' | 'C' | 'D';
  finalLevel: 'A' | 'B' | 'C' | 'D';
  status: 'supported' | 'provisional';
  matchedRules: string[];
  conflictingRules: string[];
  reviewReasons: string[];
}
