import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchClusteringHealth,
  fetchClusteringProfiles,
  runClustering,
  uploadClusteringDataset,
} from '../../web/api/clustering.js';
import { NOISE_COLOR, clusterColor, clusterTint } from '../../web/lib/clusterColor.js';

/**
 * 替换全局 fetch，记录调用参数并返回预置响应。
 *
 * 支持传工厂函数：`Response` 的 body 只能读一次，同一个实例无法服务两次请求，
 * 因此需要多次调用的用例必须每次生成新的 Response。
 */
function stubFetch(responder: Response | Error | (() => Response | Error)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = typeof responder === 'function' ? responder() : responder;
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('successful envelope is unwrapped to data', async () => {
  const stub = stubFetch(
    jsonResponse({ success: true, data: { status: 'ok', engine: { loaded: true } }, error: null }),
  );
  try {
    const health = await fetchClusteringHealth(true);
    assert.equal(health.status, 'ok');
    assert.equal(health.engine.loaded, true);
  } finally {
    stub.restore();
  }
});

test('requests are same-origin and never hardcode the python host', async () => {
  const stub = stubFetch(() => jsonResponse({ success: true, data: { status: 'ok', engine: {} }, error: null }));
  try {
    await fetchClusteringHealth(true);
    await fetchClusteringProfiles();

    assert.equal(stub.calls[0].url, '/api/clustering/health?refresh=true');
    assert.equal(stub.calls[1].url, '/api/clustering/profiles');
    for (const call of stub.calls) {
      assert.ok(!/^https?:\/\//.test(call.url), `不应硬编码绝对地址：${call.url}`);
    }
  } finally {
    stub.restore();
  }
});

test('error envelope surfaces backend code and message', async () => {
  const stub = stubFetch(
    jsonResponse(
      {
        success: false,
        data: null,
        error: { code: 'PROFILE_UNAVAILABLE', message: '算法「hdbscan」当前没有可用的 profile。', requestId: 'r-1' },
      },
      409,
    ),
  );
  try {
    await assert.rejects(fetchClusteringProfiles(), (error: Error & { code?: string; status?: number }) => {
      assert.equal(error.code, 'PROFILE_UNAVAILABLE');
      assert.equal(error.status, 409);
      assert.match(error.message, /没有可用的 profile/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('non-json gateway error is turned into a readable message', async () => {
  const stub = stubFetch(new Response('<html>Bad Gateway</html>', { status: 502 }));
  try {
    await assert.rejects(fetchClusteringProfiles(), (error: Error & { code?: string; status?: number }) => {
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.status, 502);
      assert.match(error.message, /暂时不可用/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('network failure is reported instead of failing silently', async () => {
  const stub = stubFetch(new Error('connect ECONNREFUSED'));
  try {
    await assert.rejects(fetchClusteringHealth(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.match(error.message, /npm run dev:py/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('run posts camelCase options in the body', async () => {
  const stub = stubFetch(jsonResponse({ success: true, data: { summary: {}, clusters: [], items: [], visualization: [] }, error: null }));
  try {
    await runClustering(
      [
        { id: 'a', text: '未设置警戒围栏', metadata: {} },
        { id: 'b', text: '缺少连墙件', metadata: {} },
      ],
      { algorithm: 'dbscan', profileId: 'p-1', visualize: false, reduceMethod: 'none' },
    );

    const call = stub.calls[0];
    assert.equal(call.url, '/api/clustering/run');
    assert.equal(call.init?.method, 'POST');
    assert.equal((call.init?.headers as Record<string, string>)['Content-Type'], 'application/json');

    const body = JSON.parse(String(call.init?.body));
    assert.deepEqual(body.options, {
      algorithm: 'dbscan',
      profileId: 'p-1',
      visualize: false,
      reduceMethod: 'none',
    });
    assert.equal(body.items[0].text, '未设置警戒围栏');
  } finally {
    stub.restore();
  }
});

test('upload sends the file as multipart form data', async () => {
  const stub = stubFetch(jsonResponse({ success: true, data: { sourceName: 'a.csv', total: 2, warnings: [], items: [] }, error: null }));
  try {
    await uploadClusteringDataset(new File(['隐患描述'], 'a.csv', { type: 'text/csv' }));

    const call = stub.calls[0];
    assert.equal(call.url, '/api/clustering/datasets');
    assert.equal(call.init?.method, 'POST');
    assert.ok(call.init?.body instanceof FormData);
    assert.ok((call.init?.body as FormData).get('file'));
  } finally {
    stub.restore();
  }
});

test('cluster colours are stable per cluster id and distinct across clusters', () => {
  assert.equal(clusterColor(0), clusterColor(0));
  assert.notEqual(clusterColor(0), clusterColor(1));
  assert.notEqual(clusterColor(0), clusterColor(2));
});

test('noise keeps its own neutral colour', () => {
  assert.equal(clusterColor(-1), NOISE_COLOR);
  assert.notEqual(clusterColor(-1), clusterColor(0));
});

test('cluster tint derives an rgba value from the cluster colour', () => {
  assert.equal(clusterTint(0, 0.5), 'rgba(0, 113, 227, 0.5)');
  assert.match(clusterTint(-1), /^rgba\(161, 161, 166/);
});
