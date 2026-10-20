jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(),
    getProxyConfigForProvider: jest.fn(),
    getGoogleAuthProxyConfig: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));
jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity']),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import { CONFIG } from '../src/core/config-manager.js';
import { getServiceAdapter } from '../src/providers/adapter.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { handleGetProviderModels, handleGetProviderTypeModels } from '../src/ui-modules/provider-api.js';
import { ENDPOINT_TYPE, MODEL_PROVIDER, handleModelListRequest } from '../src/utils/common.js';

const providerType = MODEL_PROVIDER.ANTIGRAVITY;
const originalCustomModels = CONFIG.customModels;

function createPool(tierId, { models = ['gemini-3.8-flash-low'], source = 'upstream' } = {}) {
    const pool = Object.create(ProviderPoolManager.prototype);
    pool.globalConfig = CONFIG;
    pool.providerStatus = { [providerType]: [{ uuid: 'custom-model-account', config: {} }] };
    pool.providerPools = { [providerType]: [{ uuid: 'custom-model-account' }] };
    pool._log = jest.fn();
    // A successfully fetched but incomplete upstream catalog, not an offline fallback.
    getServiceAdapter.mockReturnValue({
        antigravityApiService: { tierId, availableModelsSource: source },
        listModels: jest.fn().mockResolvedValue({ models: models.map(model => ({ name: `models/${model}` })) })
    });
    return pool;
}

function response() {
    return {
        writeHead: jest.fn(),
        end: jest.fn(function (body) { this.body = JSON.parse(body); })
    };
}

beforeEach(() => { CONFIG.customModels = []; });
afterEach(() => {
    CONFIG.customModels = originalCustomModels;
    jest.clearAllMocks();
});

describe('Full Antigravity UI catalog with discovery status', () => {
    test('includes missing built-ins with separate status, without changing IDs or default listings', async () => {
        const pool = createPool('Google AI Pro');
        const catalog = await pool.getAllAvailableModels(null, { includeUnavailable: true });
        const byId = Object.fromEntries(catalog.map(model => [model.model, model.availability]));
        expect(byId['gemini-4-argon']).toBe('not_returned');
        expect(byId['gemini-4-argon-high']).toBe('not_returned');
        expect(byId['gemini-3.8-flash-low']).toBe('returned');
        expect(byId['gemini-3.8-flash-medium']).toBe('returned');
        expect(catalog.every(model => model.id === `${providerType}:${model.model}`)).toBe(true);
        const defaults = await pool.getAllAvailableModels();
        expect(defaults.map(model => model.model)).not.toContain('gemini-4-argon');
        expect(defaults.every(model => model.availability === undefined)).toBe(true);
    });

    test('separates tier restrictions from an upstream catalog omission', async () => {
        const catalog = await createPool('free-tier').getAllAvailableModels(null, { includeUnavailable: true });
        const byId = Object.fromEntries(catalog.map(model => [model.model, model.availability]));
        expect(byId['gemini-4-argon']).toBe('tier_restricted');
        expect(byId['gemini-3.8-flash-high']).toBe('not_returned');
        expect(byId['gemini-3.8-flash-low']).toBe('returned');
    });

    test('recognizes actual model aliases for built-ins and custom IDs', async () => {
        CONFIG.customModels = [{
            id: 'my-argon', provider: providerType, actualModel: 'gemini-4-argon-high'
        }];
        const pool = createPool('Google AI Pro', { models: ['gemini-4-argon-medium', 'gemini-4-argon-high'] });
        const catalog = await pool.getAllAvailableModels(null, { includeUnavailable: true });
        const byId = Object.fromEntries(catalog.map(model => [model.model, model.availability]));
        expect(byId['gemini-4-argon']).toBe('returned');
        expect(byId['my-argon']).toBe('returned');
    });

    test('does not label fallback models as having been returned by upstream', async () => {
        const pool = createPool('Google AI Pro', { models: ['gemini-4-argon'], source: 'fallback' });
        const catalog = await pool.getAllAvailableModels(null, { includeUnavailable: true });
        expect(catalog.find(model => model.model === 'gemini-4-argon').availability).toBe('unknown');
    });

    test('keeps a returned model verified when another account fails discovery', async () => {
        const pool = createPool('Google AI Pro');
        pool.providerStatus[providerType] = [
            { uuid: 'failed', config: { uuid: 'failed' } },
            { uuid: 'paid', config: { uuid: 'paid' } }
        ];
        getServiceAdapter.mockImplementation(config => ({
            antigravityApiService: { tierId: 'Google AI Pro', availableModelsSource: 'upstream' },
            listModels: config.uuid === 'failed'
                ? jest.fn().mockRejectedValue(new Error('offline'))
                : jest.fn().mockResolvedValue({ models: [{ name: 'models/gemini-4-argon-high' }] })
        }));
        const catalog = await pool.getAllAvailableModels(null, { includeUnavailable: true });
        expect(catalog.find(model => model.model === 'gemini-4-argon-high').availability).toBe('returned');
        expect(catalog.find(model => model.model === 'gemini-4-argon').availability).toBe('unknown');
    });

    test('returns unknown for a custom model routed to a different provider', async () => {
        CONFIG.customModels = [{
            id: 'external', provider: providerType, actualProvider: MODEL_PROVIDER.OPENAI_CUSTOM
        }];
        const catalog = await createPool('free-tier').getAllAvailableModels(null, { includeUnavailable: true });
        expect(catalog.find(model => model.model === 'external').availability).toBe('unknown');
    });

    test('exposes opt-in UI metadata while preserving the legacy API shape', async () => {
        const pool = createPool('Google AI Pro');
        const req = { url: '/api/provider-models?includeUnavailable=true' };
        const all = response();
        const type = response();
        await handleGetProviderModels(req, all, CONFIG, pool);
        await handleGetProviderTypeModels(req, type, CONFIG, pool, providerType);
        expect(all.body.models[providerType]).toContain('gemini-4-argon');
        expect(all.body.modelStatus[providerType]['gemini-4-argon']).toBe('not_returned');
        expect(type.body.models).toEqual(all.body.models[providerType]);
        expect(type.body.modelStatus).toEqual(all.body.modelStatus[providerType]);
        const legacy = response();
        await handleGetProviderModels({}, legacy, CONFIG, pool);
        expect(legacy.body[providerType]).toBeInstanceOf(Array);
        expect(legacy.body.modelStatus).toBeUndefined();
    });

    test('labels the static catalog unverified when no accounts are configured', async () => {
        const all = response();
        await handleGetProviderModels({ url: '/api/provider-models?includeUnavailable=true' }, all, CONFIG, null);
        expect(all.body.models[providerType]).toContain('gemini-4-argon');
        expect(all.body.modelStatus[providerType]['gemini-4-argon']).toBe('unknown');
    });
});

describe('Explicit Antigravity custom models survive automatic discovery filtering', () => {
    test.each(['Google AI Pro', 'free-tier', undefined])('preserves a manually registered Argon model for tier %s', async tierId => {
        CONFIG.customModels = [{ id: 'gemini-4-argon', provider: providerType }];
        const pool = createPool(tierId);
        const models = await pool.getAllAvailableModels();
        expect(models.map(model => model.model)).toContain('gemini-4-argon');
        // The exemption is per explicit ID: do not expose every built-in paid model.
        if (tierId) expect(models.map(model => model.model)).not.toContain('gemini-4-argon-high');
    });

    test('retains a custom ID whose alias and actual model differ from its list ID', async () => {
        CONFIG.customModels = [{
            id: 'my-argon',
            alias: 'gemini-4-argon',
            provider: providerType,
            actualProvider: providerType,
            actualModel: 'gemini-4-argon-high'
        }];
        const models = await createPool('Google AI Pro').getAllAvailableModels();
        expect(models.map(model => model.model)).toContain('my-argon');
        expect(models.map(model => model.model)).not.toContain('gemini-4-argon');
    });

    test('does not use another provider custom model to override Antigravity filtering', async () => {
        CONFIG.customModels = [{ id: 'gemini-4-argon', provider: MODEL_PROVIDER.OPENAI_CUSTOM }];
        const models = await createPool('free-tier').getAllAvailableModels();
        expect(models.map(model => model.model)).not.toContain('gemini-4-argon');
    });

    test('updates UI and auto-mode lists when custom configuration changes without rediscovery', async () => {
        const pool = createPool('Google AI Pro');
        const listUi = async () => {
            const all = response();
            const type = response();
            await handleGetProviderModels({}, all, CONFIG, pool);
            await handleGetProviderTypeModels({}, type, CONFIG, pool, providerType);
            expect(all.body[providerType]).toEqual(type.body.models);
            return type.body.models;
        };
        expect(await listUi()).not.toContain('gemini-4-argon');

        CONFIG.customModels = [{ id: 'gemini-4-argon', provider: providerType }];
        expect(await listUi()).toContain('gemini-4-argon');
        for (const endpointType of [ENDPOINT_TYPE.OPENAI_MODEL_LIST, ENDPOINT_TYPE.GEMINI_MODEL_LIST]) {
            const res = response();
            await handleModelListRequest({}, res, null, endpointType, {
                MODEL_PROVIDER: MODEL_PROVIDER.AUTO,
                customModels: CONFIG.customModels
            }, pool, null);
            const ids = endpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST
                ? res.body.data.map(model => model.id)
                : res.body.models.map(model => model.name.replace(/^models\//, ''));
            expect(ids).toContain(`${providerType}:gemini-4-argon`);
        }

        CONFIG.customModels = [];
        expect(await listUi()).not.toContain('gemini-4-argon');
    });

    test('listing a custom model does not bypass free-tier request permission checks', () => {
        CONFIG.customModels = [{ id: 'gemini-4-argon', provider: providerType }];
        const service = Object.create(AntigravityApiService.prototype);
        service.tierId = 'free-tier';
        service.availableModels = ['gemini-4-argon'];
        expect(() => service.buildAntigravityPayload('gemini-4-argon', {}))
            .toThrow('unavailable on the free tier');
    });
});
