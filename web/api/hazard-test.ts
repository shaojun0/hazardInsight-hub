import type { HazardTestDataset, HazardTestJob, HazardTestOptions } from '../../shared/hazard-test';
import { parseRes } from './client';

const base = '/api/hazard-tests';
async function get<T>(path: string, init?: RequestInit): Promise<T> {
  return (await parseRes<{ data: T }>(await fetch(`${base}${path}`, init))).data;
}
export const fetchDefaultTestDataset = () => get<HazardTestDataset>('/datasets/default');
export const fetchLatestTestJob = () => get<HazardTestJob | null>('/jobs/latest');
export const fetchTestJob = (id: string) => get<HazardTestJob>(`/jobs/${encodeURIComponent(id)}`);
export function uploadTestDataset(file: File) {
  const body = new FormData();
  body.append('file', file);
  return get<HazardTestDataset>('/datasets', { method: 'POST', body });
}
export const startTestJob = (datasetId: string, options: HazardTestOptions) => get<HazardTestJob>('/jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datasetId, ...options }),
});
export const stopTestJob = (id: string) => get<HazardTestJob>(`/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST' });
export async function downloadTestErrors(id: string) {
  const response = await fetch(`${base}/jobs/${encodeURIComponent(id)}/errors.csv`);
  if (!response.ok) await parseRes(response);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `hazard-test-${id}-errors.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
