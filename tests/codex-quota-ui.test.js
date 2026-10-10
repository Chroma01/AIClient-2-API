import { createCodexQuotaBadgeLoader } from '../static/app/codex-quota-badges.js';

describe('Codex quota badge loader', () => {
    const badge = () => ({
        dataset: { providerUuid: 'account-1' },
        isConnected: true,
        textContent: '',
        title: ''
    });
    const container = item => ({ querySelectorAll: () => [item] });

    test('loads and caches a provider quota', async () => {
        const apiClient = { get: jest.fn().mockResolvedValue({ quota: { available: true, planType: 'Plus', windows: [
            { key: '5h', usedPercentage: 32, resetsAt: null }, { key: 'weekly', usedPercentage: 57, resetsAt: null }
        ] } }) };
        const b = badge();
        const load = createCodexQuotaBadgeLoader({ apiClient, translate: key => key, now: () => 0 });
        load(container(b));
        await Promise.resolve(); await Promise.resolve();
        expect(apiClient.get).toHaveBeenCalledTimes(1);
        expect(b.textContent).toContain('32%');
        load(container(b));
        expect(apiClient.get).toHaveBeenCalledTimes(1);
    });

    test('renders unavailable when the request fails', async () => {
        const b = badge();
        const load = createCodexQuotaBadgeLoader({ apiClient: { get: jest.fn().mockRejectedValue(new Error('offline')) }, translate: key => key });
        load(container(b));
        await Promise.resolve(); await Promise.resolve();
        expect(b.textContent).toBe('providers.codexQuota.unavailable');
    });
});
