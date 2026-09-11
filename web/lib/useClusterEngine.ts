/**
 * 聚类引擎状态 Hook。
 *
 * 负责三件事：
 * 1. 拉取健康检查，判断「Python 聚类服务是否启动 / 本地向量模型是否就绪」；
 * 2. 拉取 profile 与算法清单，供页面下拉框选择；
 * 3. 提供 `refresh()` 强制重新校验（首次冷启动时模型校验需要时间）。

 * 这个 Hook 只读元信息、不触发聚类计算，因此「展示」与「测试」两个页面可以共用，
 * 各自独立持有自己的执行状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClusteringAlgorithmInfo,
  ClusteringHealthData,
  ClusteringProfileInfo,
} from '../../shared/clustering';
import { fetchClusteringAlgorithms, fetchClusteringHealth, fetchClusteringProfiles } from '../api/clustering';

export interface ClusterEngineState {
  health: ClusteringHealthData | null;
  profiles: ClusteringProfileInfo[];
  algorithms: ClusteringAlgorithmInfo[];
  loading: boolean;
  /** 元信息拉取失败的原因（通常是服务未启动）。 */
  error: string;
  /** 强制重新校验模型与 profile。 */
  refresh: () => Promise<void>;
  /** 引擎是否就绪（服务已启动 + 模型可用）。 */
  ready: boolean;
}

export function useClusterEngine(): ClusterEngineState {
  const [health, setHealth] = useState<ClusteringHealthData | null>(null);
  const [profiles, setProfiles] = useState<ClusteringProfileInfo[]>([]);
  const [algorithms, setAlgorithms] = useState<ClusteringAlgorithmInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const locked = useRef(false);

  const load = useCallback(async (force: boolean) => {
    if (locked.current) return;
    locked.current = true;
    setLoading(true);
    setError('');
    try {
      const [nextHealth, nextProfiles, nextAlgorithms] = await Promise.all([
        fetchClusteringHealth(force),
        fetchClusteringProfiles(force),
        fetchClusteringAlgorithms(),
      ]);
      setHealth(nextHealth);
      setProfiles(nextProfiles);
      setAlgorithms(nextAlgorithms);
    } catch (cause) {
      setHealth(null);
      setProfiles([]);
      setAlgorithms([]);
      setError((cause as Error).message);
    } finally {
      locked.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  const ready = useMemo(
    () => Boolean(health && health.engine.loaded && !health.engine.message),
    [health],
  );

  return { health, profiles, algorithms, loading, error, refresh, ready };
}
