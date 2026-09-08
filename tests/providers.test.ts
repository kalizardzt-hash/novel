import { afterEach, expect, it, vi } from 'vitest';
import {
  EXTERNAL_PROVIDERS,
  LOCAL_SERVICES,
  probeServices,
} from '../packages/infrastructure/src/providers.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it('探测发现可达服务及其模型，不可达服务不抛错', async () => {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('1234'))
      return new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, {}] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    throw new TypeError('fetch failed');
  });
  const results = await probeServices([LOCAL_SERVICES[0]!, LOCAL_SERVICES[1]!]);
  expect(results[0]).toMatchObject({ reachable: true, models: ['a', 'b'] });
  expect(results[1]).toMatchObject({ reachable: false, models: [] });
  expect(results[1]!.detail).toBeTruthy();
});

it('非 2xx 响应标记为不可达并记录状态码', async () => {
  globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 }));
  const [result] = await probeServices([{ name: 'X', baseUrl: 'http://127.0.0.1:9/v1' }]);
  expect(result).toMatchObject({ reachable: false, detail: '服务返回 404' });
});

it('响应挂起的服务按超时处理', async () => {
  globalThis.fetch = vi.fn(
    (_url: unknown, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation timed out', 'TimeoutError')),
        );
      }),
  );
  const [result] = await probeServices([{ name: 'X', baseUrl: 'http://127.0.0.1:9/v1' }], 30);
  expect(result).toMatchObject({ reachable: false, detail: '响应超时' });
});

it('本机预设只指向回环地址，外部预设是 https 且带获取 Key 入口', () => {
  for (const service of LOCAL_SERVICES) {
    const host = new URL(service.baseUrl).hostname;
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(host);
  }
  for (const preset of EXTERNAL_PROVIDERS) {
    expect(preset.baseUrl.startsWith('https://')).toBe(true);
    expect(preset.website).toBeTruthy();
  }
});
