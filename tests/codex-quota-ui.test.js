jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import { normalizeCodexQuota } from '../src/ui-modules/provider-api.js';
import {
    createCodexQuotaBadgeLoader,
    createCodexQuotaUsageLoader
} from '../static/app/codex-quota-badges.js';

describe('Codex quota summary and badges', () => {
    const translations = {
        'providers.codexQuota.fiveHour': '5h',
        'providers.codexQuota.weekly': 'weekly',
        'providers.codexQuota.monthly': 'monthly',
        'providers.codexQuota.other': 'other',
        'providers.codexQuota.unknownReset': 'reset unknown',
        'providers.codexQuota.unknownPlan': 'Unknown plan',
        'providers.codexQuota.unavailable': 'Codex quota unavailable',
        'providers.codexQuota.loading': 'Loading Codex quota...'
    };

    const translate = (key, params = {}) => {
        if (key === 'providers.codexQuota.windowUsed') return `${params.window} ${params.percent}% used`;
        if (key === 'providers.codexQuota.details') return `${params.plan} plan · ${params.windows}`;
        return translations[key] || key;
    };

    const createBadge = uuid => ({
        dataset: { providerUuid: uuid },
        isConnected: true,
        textContent: '',
        title: ''
    });
    const createContainer = badges => ({ querySelectorAll: () => badges });
    const quotaResponse = (windows, planType = 'plus') => ({
        quota: { available: true, planType, windows }
    });

    test('normalizes Unix-second resets and renders quota details using real i18n', async () => {
        global.localStorage = { getItem: () => 'en-US', setItem: jest.fn() };
        const { t } = await import('../static/app/i18n.js');
        const quota = normalizeCodexQuota({
            plan_type: 'plus',
            rate_limit: {
                primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_at: 1800003600 },
                secondary_window: { used_percent: 57, limit_window_seconds: 604800, reset_at: 1800604800 }
            }
        });
        const apiClient = { get: jest.fn().mockResolvedValue({ quota }) };
        const badge = createBadge('account-1');
        const loadBadge = createCodexQuotaBadgeLoader({ apiClient, translate: t });

        await loadBadge(createContainer([badge]));

        expect(quota.windows.map(window => window.key)).toEqual(['5h', 'weekly']);
        expect(quota.windows.map(window => window.resetsAt)).toEqual([1800003600000, 1800604800000]);
        expect(badge.textContent).toBe('5h 32% used · weekly 57% used');
        expect(badge.title).toContain('plus plan');
        expect(badge.title).toContain('32%');
        expect(badge.title).toContain(new Date(1800003600000).toLocaleString());
        expect(badge.title).toContain(new Date(1800604800000).toLocaleString());
        expect(badge.title).not.toContain(new Date(1800003600).toLocaleString());
    });

    test.each([null, '', true, 'not-a-number'])('rejects malformed used_percent %p', usedPercent => {
        const quota = normalizeCodexQuota({ rate_limit: { primary_window: { used_percent: usedPercent } } });
        expect(quota).toMatchObject({ available: false, windows: [] });
    });

    test('shares cached account quotas between summaries and badges until the TTL expires', async () => {
        let now = 0;
        const apiClient = { get: jest.fn().mockResolvedValue(quotaResponse([
            { key: '5h', usedPercentage: 32, resetsAt: null },
            { key: 'weekly', usedPercentage: 57, resetsAt: null }
        ])) };
        const providers = [{ uuid: 'codex-a', isHealthy: true }];
        const badge = createBadge('codex-a');
        const loadSummary = createCodexQuotaUsageLoader({ apiClient, now: () => now });
        const loadBadge = createCodexQuotaBadgeLoader({ apiClient, translate, now: () => now });

        await expect(loadSummary(providers)).resolves.toEqual({ available: true, usedPercent: 57, totalPercent: 100 });
        await loadBadge(createContainer([badge]));
        expect(apiClient.get).toHaveBeenCalledTimes(1);
        expect(badge.textContent).toContain('weekly 57% used');

        now = 60_001;
        await loadSummary(providers);
        expect(apiClient.get).toHaveBeenCalledTimes(2);
    });

    test('deduplicates a summary and badge request for the same in-flight account', async () => {
        let resolveRequest;
        const apiClient = {
            get: jest.fn(() => new Promise(resolve => { resolveRequest = resolve; }))
        };
        const provider = { uuid: 'codex-a', isHealthy: true };
        const badge = createBadge(provider.uuid);
        const loadSummary = createCodexQuotaUsageLoader({ apiClient });
        const loadBadge = createCodexQuotaBadgeLoader({ apiClient, translate });

        const summaryPromise = loadSummary([provider]);
        const badgePromise = loadBadge(createContainer([badge]));
        await new Promise(resolve => setImmediate(resolve));
        expect(apiClient.get).toHaveBeenCalledTimes(1);
        resolveRequest(quotaResponse([{ key: 'weekly', usedPercentage: 61, resetsAt: null }]));
        await Promise.all([summaryPromise, badgePromise]);
        expect(badge.textContent).toContain('61%');
    });

    test('bounds concurrent account requests', async () => {
        let activeRequests = 0;
        let maxActiveRequests = 0;
        const apiClient = {
            get: jest.fn(async () => {
                activeRequests += 1;
                maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
                await new Promise(resolve => setImmediate(resolve));
                activeRequests -= 1;
                return quotaResponse([{ key: 'weekly', usedPercentage: 10, resetsAt: null }]);
            })
        };
        const providers = Array.from({ length: 12 }, (_, index) => ({ uuid: `codex-${index}`, isHealthy: true }));

        await createCodexQuotaUsageLoader({ apiClient })(providers);

        expect(maxActiveRequests).toBeLessThanOrEqual(4);
        expect(apiClient.get).toHaveBeenCalledTimes(providers.length);
    });

    test('sums each healthy enabled account highest window and excludes other accounts', async () => {
        const providers = [
            { uuid: 'codex-a', isHealthy: true },
            { uuid: 'codex-b', isHealthy: true, isDisabled: false },
            { uuid: 'codex-c', isHealthy: false },
            { uuid: 'codex-d', isHealthy: true, isDisabled: true }
        ];
        const apiClient = {
            get: jest.fn(async url => url.endsWith('/codex-a/quota')
                ? quotaResponse([{ key: '5h', usedPercentage: 32 }, { key: 'weekly', usedPercentage: 57 }])
                : quotaResponse([{ key: 'weekly', usedPercentage: 81.4 }]))
        };

        await expect(createCodexQuotaUsageLoader({ apiClient })(providers))
            .resolves.toEqual({ available: true, usedPercent: 138, totalPercent: 200 });
        expect(apiClient.get).toHaveBeenCalledTimes(2);
    });

    test('marks the aggregate unavailable if an eligible account quota fails', async () => {
        const apiClient = { get: jest.fn().mockRejectedValue(new Error('offline')) };
        await expect(createCodexQuotaUsageLoader({ apiClient })([
            { uuid: 'codex-a', isHealthy: true }
        ])).resolves.toEqual({ available: false, usedPercent: null, totalPercent: 100 });
    });

    test('returns zero usage without requests when there are no eligible accounts', async () => {
        const apiClient = { get: jest.fn() };
        await expect(createCodexQuotaUsageLoader({ apiClient })([
            { uuid: 'codex-a', isHealthy: false }
        ])).resolves.toEqual({ available: true, usedPercent: 0, totalPercent: 0 });
        expect(apiClient.get).not.toHaveBeenCalled();
    });

    test('renders unavailable when a badge request fails', async () => {
        const apiClient = { get: jest.fn().mockRejectedValue(new Error('offline')) };
        const badge = createBadge('codex-a');
        await createCodexQuotaBadgeLoader({ apiClient, translate })(createContainer([badge]));
        expect(badge.textContent).toBe('Codex quota unavailable');
    });
});
