/**
 * 簇配色：为聚类结果分配稳定、可区分的颜色。
 *
 * 同一个 `cluster_id` 在散点图、图例、簇卡片、结果表格里必须始终同色，
 * 因此配色只依赖 `cluster_id` 本身，不依赖数组下标或排序结果。
 * `-1` 是噪声点（不属于任何簇），固定用中性灰。
 */

/** 12 色循环调色板：在浅色与深色主题下都有足够对比度。 */
const PALETTE = [
  '#0071e3',
  '#f2720c',
  '#0d9b8a',
  '#7c3aed',
  '#e0342f',
  '#0e7a56',
  '#c026d3',
  '#2f6f9f',
  '#d9a406',
  '#0891b2',
  '#65a30d',
  '#b45309',
];

/** 噪声点颜色（与 `NOISE_CLUSTER_ID = -1` 对应）。 */
export const NOISE_COLOR = '#a1a1a6';

/** 取簇颜色。负值（噪声）返回中性灰。 */
export function clusterColor(clusterId: number): string {
  if (clusterId < 0) return NOISE_COLOR;
  return PALETTE[clusterId % PALETTE.length];
}

/** 取簇颜色的半透明版本，用于卡片底色、标签底色等。 */
export function clusterTint(clusterId: number, alpha = 0.1): string {
  const hex = clusterColor(clusterId);
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
