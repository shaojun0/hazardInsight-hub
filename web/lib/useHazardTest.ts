import { useEffect, useRef, useState } from 'react';
import type { HazardTestDataset, HazardTestJob } from '../../shared/hazard-test';
import { fetchDefaultTestDataset, fetchLatestTestJob, fetchTestJob, startTestJob, stopTestJob, uploadTestDataset } from '../api/hazard-test';
import { ApiError } from '../api/client';
import { DEFAULT_TEST_OPTIONS, type HazardTestOptions } from '../../shared/hazard-test';

export function useHazardTest() {
  const [dataset, setDataset] = useState<HazardTestDataset | null>(null);
  const [job, setJob] = useState<HazardTestJob | null>(null);
  const [options, setOptions] = useState<HazardTestOptions>({ ...DEFAULT_TEST_OPTIONS });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const locked = useRef(false);
  const active = job?.status === 'running' || job?.status === 'stopping';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const previous = await fetchLatestTestJob();
        const initial = previous?.dataset ?? await fetchDefaultTestDataset();
        if (!cancelled) { setJob(previous); setDataset(initial); setOptions(previous?.options ?? { ...DEFAULT_TEST_OPTIONS }); }
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      finally { if (!cancelled) setBusy(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!active || !job) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await fetchTestJob(job.id);
        if (!cancelled) { setJob(next); setPollError(''); }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setJob(null); setDataset(null); setError('任务缓存已失效（可能因服务重启），请重新加载默认数据或上传 CSV。');
          return;
        }
        setPollError(`进度获取失败，将自动重试：${(e as Error).message}`);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job?.id, active]);

  async function action(run: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setPollError('');
    try { await run(); }
    catch (e) { setError((e as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }
  return { dataset, job, busy, active, error, pollError, options, setOptions,
    loadDefault: () => action(async () => {
      if (active) return;
      const next = await fetchDefaultTestDataset(); setDataset(next); setJob(null);
    }),
    upload: (file: File) => action(async () => {
      if (active) return;
      const next = await uploadTestDataset(file); setDataset(next); setJob(null);
    }),
    start: () => action(async () => {
      if (!dataset || active) return;
      try {
        const next = await startTestJob(dataset.id, options);
        setJob(next); setOptions(next.options);
      }
      catch (e) {
        // 发起请求的响应丢失时找回后端已创建的任务，避免盲目重发。
        const previous = await fetchLatestTestJob().catch(() => null);
        if (previous && (previous.status === 'running' || previous.status === 'stopping')) {
          setJob(previous); setDataset(previous.dataset);
          setOptions(previous.options);
        }
        throw e;
      }
    }),
    stop: () => action(async () => { if (job) setJob(await stopTestJob(job.id)); }),
  };
}
