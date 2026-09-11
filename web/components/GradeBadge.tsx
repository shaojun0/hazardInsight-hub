import type { Grade } from '../../shared/types';
import { GRADE_META } from '../lib/constants';

export function GradeBadge({ grade, showLabel = true, size = 'md' }: { grade: Grade; showLabel?: boolean; size?: 'sm' | 'md' }) {
  const meta = GRADE_META[grade];
  return (
    <span
      className={`grade-badge grade-${grade}`}
      style={size === 'sm' ? { height: 20, padding: '0 7px', fontSize: 11 } : undefined}
    >
      <span className="flag" />
      {meta.short}
      {showLabel && ` · ${meta.label}`}
    </span>
  );
}

export function GradeSelect({ value, onChange }: { value: Grade; onChange: (g: Grade) => void }) {
  return (
    <select className="select" style={{ width: 132 }} value={value} onChange={(e) => onChange(e.target.value as Grade)}>
      {(['A', 'B', 'C', 'D'] as Grade[]).map((g) => (
        <option key={g} value={g}>
          {g} 级 · {GRADE_META[g].label}
        </option>
      ))}
    </select>
  );
}
