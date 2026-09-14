/**
 * 异步聚类作业的提交 / 轮询 / 取消。
 *
 * 为什么不用 `useEffect` 里裸写定时器：轮询有几个必须处理对的状态，
 * 散在页面里很容易漏掉其中一条——
 *
 * * **终态即停**：`succeeded / failed / cancelled` 之后必须停表，否则会一直打后端；
 * * **切走即停**：组件卸载或换成另一个作业后，旧请求回来不能覆盖新状态；
 * * **取消后不当成功**：取消是调用方意图，不是失败；轮询到 cancelled 要如实呈现；
 * * **网络抖动不当作失败**：轮询失败退避重试，而不是把作业判死
 *   （作业还在后端跑着，一次查询失败不代表任务失败）。
 *
 * 取明细**不在这里**：明细分页是用户的翻页动作，由页面按需调用
 * `fetchClusteringJobItems`，避免"每轮轮询都顺带拉一页数据"。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClusteringDatasetItem,
  ClusteringJobInfo,
  ClusteringJobResultData,
  ClusteringJobSubmitOptions,
} from '../../shared/clustering';
import {
  cancelClusteringJob,
  fetchClusteringJob,
  fetchClusteringJobResult,
  submitClusteringJob,
} from '../api/clustering';

/** 轮询间隔（毫秒）。作业通常要跑几十秒到几十分钟，2 秒足够且不打扰后端。 */
export const POLL_INTERVAL_MS = 2000;

/** 连续轮询失败的上限；超过即停表并把错误交给页面展示。 */
export const MAX_POLL_FAILURES = 5;

export interface ClusteringJobApi {
  job: ClusteringJobInfo | null;
  /** 作业成功后的摘要 / 簇 / 抽样坐标（不含明细）。 */
  result: ClusteringJobResultData | null;
  /** 提交或读取结果时的错误（轮询的瞬时失败不写在这里）。 */
  error: string;
  busy: boolean;
  submit: (
    items: ClusteringDatasetItem[],
    options?: ClusteringJobSubmitOptions,
  ) => Promise<ClusteringJobInfo | null>;
  cancel: () => Promise<void>;
  reset: () => void;
}

export function useClusteringJob(): ClusteringJobApi {
  const [job, setJob] = useState<ClusteringJobInfo | null>(null);
  const [result, setResult] = useState<ClusteringJobResultData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /** 当前关注的作业 ID，防止旧作业的响应覆盖新作业的状态。 */
  const activeId = useRef<string | null>(null);
  /** 定时器与连续失败计数放在 ref 里：改它们不该触发重渲染。 */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  const mounted = useRef(true);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  /** 拉取成功作业的摘要；不含明细，因此对 10 万条也是小响应。 */
  const loadResult = useCallback(async (jobId: string) => {
    try {
      const data = await fetchClusteringJobResult(jobId);
      if (mounted.current && activeId.current === jobId) setResult(data);
    } catch (cause) {
      if (mounted.current && activeId.current === jobId) setError((cause as Error).message);
    }
  }, []);

  /** 单次轮询：更新状态，并在进入终态时停表。 */
  const poll = useCallback(
    async (jobId: string) => {
      try {
        const snapshot = await fetchClusteringJob(jobId);
        if (!mounted.current || activeId.current !== jobId) return;
        failures.current = 0;
        setJob(snapshot);
        if (snapshot.terminal) {
          clearTimer();
          if (snapshot.status === 'succeeded') await loadResult(jobId);
          // failed / cancelled 的具体原因由 snapshot.error 呈现，页面直接读 job 即可
          return;
        }
      } catch (cause) {
        if (!mounted.current || activeId.current !== jobId) return;
        failures.current += 1;
        // 作业仍在后端跑着，一次查询失败不代表任务失败：退避重试，
        // 只有连续失败到上限才把错误交给页面（并停表，避免无限打后端）。
        if (failures.current >= MAX_POLL_FAILURES) {
          clearTimer();
          setError((cause as Error).message);
          return;
        }
      }
      if (mounted.current && activeId.current === jobId) {
        timer.current = setTimeout(() => void poll(jobId), POLL_INTERVAL_MS);
      }
    },
    [clearTimer, loadResult],
  );

  const submit = useCallback(
    async (items: ClusteringDatasetItem[], options: ClusteringJobSubmitOptions = {}) => {
      clearTimer();
      setBusy(true);
      setError('');
      setResult(null);
      setJob(null);
      try {
        const snapshot = await submitClusteringJob(items, options);
        activeId.current = snapshot.jobId;
        failures.current = 0;
        setJob(snapshot);
        if (!snapshot.terminal) {
          timer.current = setTimeout(() => void poll(snapshot.jobId), POLL_INTERVAL_MS);
        } else if (snapshot.status === 'succeeded') {
          await loadResult(snapshot.jobId);
        }
        return snapshot;
      } catch (cause) {
        setError((cause as Error).message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [clearTimer, loadResult, poll],
  );

  const cancel = useCallback(async () => {
    const jobId = activeId.current;
    if (!jobId) return;
    try {
      const snapshot = await cancelClusteringJob(jobId);
      if (mounted.current && activeId.current === jobId) {
        setJob(snapshot);
        if (snapshot.terminal) clearTimer();
      }
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [clearTimer]);

  const reset = useCallback(() => {
    clearTimer();
    activeId.current = null;
    failures.current = 0;
    setJob(null);
    setResult(null);
    setError('');
  }, [clearTimer]);

  return { job, result, error, busy, submit, cancel, reset };
}
