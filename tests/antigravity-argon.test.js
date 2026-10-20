jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(),
    getProxyConfigForProvider: jest.fn(),
    getGoogleAuthProxyConfig: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { AntigravityApiService, isAntigravityModelRetired } from '../src/providers/gemini/antigravity-core.js';
import { PROVIDER_MODELS } from '../src/providers/provider-models.js';

const variants = [
    ['gemini-4-argon', 'gemini-4-argon-medium', 'medium'],
    ['gemini-4-argon-high', 'gemini-4-argon-high', 'high']
];
const legacyUserAgent = 'antigravity/2.8.1 darwin/arm64';
const upstreamResponse = { response: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };

function createService(tierId = 'Google AI Pro') {
    const service = Object.create(AntigravityApiService.prototype);
    service.isInitialized = true;
    service.tierId = tierId;
    service.config = { MODEL_FALLBACK_ENABLED: false };
    service.availableModels = [];
    service.projectId = 'argon-test-project';
    service.userAgent = legacyUserAgent;
    service.baseURLs = ['https://antigravity.test'];
    service.authClient = {
        credentials: { expiry_date: Date.now() + 3600000 },
        request: jest.fn()
    };
    service._applySidecar = jest.fn();
    service.prepareRequestMetadata = jest.fn();
    return service;
}

describe('Antigravity Gemini 4 Argon support', () => {
    test('registers both requested client IDs only for Antigravity', () => {
        for (const [model] of variants) {
            expect(PROVIDER_MODELS['gemini-antigravity']).toContain(model);
            expect(PROVIDER_MODELS['gemini-cli-oauth']).not.toContain(model);
        }
    });

    test('discovers the Medium upstream ID as the base alias and preserves High', async () => {
        const service = createService();
        service.authClient.request.mockResolvedValue({ data: { models: {
            'gemini-4-argon-medium': {},
            'gemini-4-argon-high': {}
        } } });

        await service.fetchAvailableModels();

        expect(service.authClient.request).toHaveBeenCalledWith(expect.objectContaining({
            headers: expect.objectContaining({ 'User-Agent': expect.stringMatching(/^antigravity\/cli\//) })
        }));
        expect(service.availableModels).toEqual(variants.map(([model]) => model));
        const response = await service.listModels();
        expect(response.models.map(model => model.name)).toEqual(variants.map(([model]) => `models/${model}`));
        expect(response.models.every(model => model.thinking.levels.includes('high'))).toBe(true);
    });

    test('keeps both models in the fallback catalog if discovery fails', async () => {
        const service = createService();
        service.authClient.request.mockRejectedValue(new Error('offline'));
        await service.fetchAvailableModels();
        for (const [model] of variants) expect(service.availableModels).toContain(model);
    });

    test.each(variants)('builds %s without falling back and preserves the thinking level', (model, upstream, level) => {
        const service = createService();
        const { payload, actualModelName } = service.buildAntigravityPayload(`models/${model}`, {
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            generationConfig: { thinkingConfig: { thinkingBudget: 8192, include_thoughts: true } }
        });
        expect(actualModelName).toBe(upstream);
        expect(payload.model).toBe(upstream);
        expect(payload.request.generationConfig.thinkingConfig).toEqual({
            thinkingLevel: level,
            includeThoughts: true
        });
    });

    test.each(variants)('sends %s through unary and streaming transports with CLI headers', async (model, upstream, level) => {
        const service = createService();
        service.authClient.request.mockImplementation(async options => options.responseType === 'stream'
            ? { status: 200, data: {} }
            : { data: upstreamResponse });
        service.parseSSEStream = jest.fn(async function* () { yield upstreamResponse; });
        const body = () => ({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });

        await expect(service.generateContent(model, body())).resolves.toEqual(upstreamResponse.response);
        const chunks = [];
        for await (const chunk of service.generateContentStream(model, body())) chunks.push(chunk);
        expect(chunks).toEqual([upstreamResponse.response]);
        expect(service.authClient.request).toHaveBeenCalledTimes(2);
        for (const [options] of service.authClient.request.mock.calls) {
            expect(options.headers['User-Agent']).toMatch(/^antigravity\/cli\//);
            const payload = JSON.parse(options.body);
            expect(payload.model).toBe(upstream);
            expect(payload.request.generationConfig.thinkingConfig.thinkingLevel).toBe(level);
        }
        expect(service.userAgent).toBe(legacyUserAgent);
    });

    test.each(variants)('keeps %s unavailable on free accounts', async (model, upstream) => {
        const service = createService('free-tier');
        service.availableModels = variants.map(([id]) => id);
        expect(isAntigravityModelRetired(model, Date.now(), 'free-tier')).toBe(true);
        expect(isAntigravityModelRetired(upstream, Date.now(), 'free-tier')).toBe(true);
        for (const tier of ['Google AI Pro', 'Google AI Ultra', undefined]) {
            expect(isAntigravityModelRetired(model, Date.now(), tier)).toBe(false);
        }
        await expect(service.listModels()).resolves.toEqual({ models: [] });
        expect(() => service.buildAntigravityPayload(model, {})).toThrow('unavailable on the free tier');
        expect(service.authClient.request).not.toHaveBeenCalled();
    });

    test('does not change transport headers for existing models or metadata calls', async () => {
        const service = createService();
        service.authClient.request.mockResolvedValue({ data: {} });
        await service.callApi('loadCodeAssist', {});
        await service.callApi('generateContent', { model: 'gemini-3.8-flash-low' });
        for (const [options] of service.authClient.request.mock.calls) {
            expect(options.headers['User-Agent']).toBe(legacyUserAgent);
        }
    });
});
