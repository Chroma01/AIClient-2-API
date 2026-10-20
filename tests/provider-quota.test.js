jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import { normalizeCodexQuota } from '../src/ui-modules/provider-api.js';

describe('Codex provider quota normalization', () => {
    test('normalizes camelCase windows without multiplying millisecond resets again', () => {
        expect(normalizeCodexQuota({ planType: 'Pro', rateLimit: {
            primaryWindow: { usedPercent: '12.5', durationMinutes: 300, resetAt: 1800003600000 },
            secondaryWindow: { usedPercent: 70, durationMinutes: 43200, resetAt: '1800604800000' }
        } })).toEqual({
            available: true,
            planType: 'Pro',
            windows: [
                { key: '5h', usedPercentage: 12.5, durationMinutes: 300, resetsAt: 1800003600000 },
                { key: 'monthly', usedPercentage: 70, durationMinutes: 43200, resetsAt: 1800604800000 }
            ]
        });
    });

    test('normalizes rate limit windows and durations', () => {
        expect(normalizeCodexQuota({ plan_type: 'Plus', rate_limit: {
            primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_at: 123 },
            secondary_window: { used_percent: 57, limit_window_seconds: 604800, reset_at: 456 }
        } })).toEqual({
            available: true,
            planType: 'Plus',
            windows: [
                { key: '5h', usedPercentage: 32, durationMinutes: 300, resetsAt: 123000 },
                { key: 'weekly', usedPercentage: 57, durationMinutes: 10080, resetsAt: 456000 }
            ]
        });
    });
});
