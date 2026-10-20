jest.mock('../static/app/utils.js', () => ({
    getProviderConfigs: jest.fn(() => []),
    markOnce: jest.fn()
}));
jest.mock('../static/app/auth.js', () => ({
    apiClient: { get: jest.fn() },
    getAuthHeaders: jest.fn(() => ({}))
}));

import { apiClient } from '../static/app/auth.js';

const originalGlobals = Object.fromEntries(
    ['window', 'document', 'localStorage', 'fetch'].map(name => [name, global[name]])
);
const fullCatalog = {
    models: { 'gemini-antigravity': ['gemini-4-argon', 'gemini-4-argon-high', 'gemini-3.8-flash-low'] },
    modelStatus: { 'gemini-antigravity': {
        'gemini-4-argon': 'not_returned',
        'gemini-4-argon-high': 'tier_restricted',
        'gemini-3.8-flash-low': 'returned'
    } }
};
let refreshModels;
let loadPlaygroundData;

beforeAll(async () => {
    global.window = { addEventListener: jest.fn() };
    global.localStorage = { getItem: () => 'en-US' };
    ({ refreshModels } = await import('../static/app/models-manager.js'));
    ({ loadPlaygroundData } = await import('../static/app/playground-manager.js'));
});

afterAll(() => {
    for (const [name, value] of Object.entries(originalGlobals)) {
        if (value === undefined) delete global[name];
        else global[name] = value;
    }
});

describe('Model status is display-only', () => {
    test.each([
        ['zh-CN', '（上游未返回）', '（当前套餐不可用）', '（上游未确认）'],
        ['en-US', '(not returned by upstream)', '(unavailable on current tiers)', '(upstream unverified)']
    ])('uses real %s translations for suffixes', async (language, missing, restricted, unknown) => {
        global.localStorage = { getItem: () => language };
        await jest.isolateModulesAsync(async () => {
            const { formatModelLabel } = await import('../static/app/model-labels.js');
            expect(formatModelLabel('gemini-4-argon', 'not_returned')).toBe(`gemini-4-argon ${missing}`);
            expect(formatModelLabel('gemini-4-argon', 'tier_restricted')).toBe(`gemini-4-argon ${restricted}`);
            expect(formatModelLabel('gemini-4-argon', 'unknown')).toBe(`gemini-4-argon ${unknown}`);
            expect(formatModelLabel('gemini-4-argon', 'returned')).toBe('gemini-4-argon');
            expect(formatModelLabel('gemini-4-argon')).toBe('gemini-4-argon');
        });
    });

    test('dashboard labels have suffixes but copied model IDs do not', async () => {
        const container = { innerHTML: '' };
        global.document = {
            getElementById: id => id === 'modelsList' ? container : null,
            createElement: () => ({
                textContent: '',
                get innerHTML() {
                    return this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
                }
            })
        };
        apiClient.get.mockResolvedValue(fullCatalog);

        await refreshModels();

        expect(apiClient.get).toHaveBeenLastCalledWith('/provider-models?includeUnavailable=true');
        expect(container.innerHTML).toContain('gemini-4-argon (not returned by upstream)');
        expect(container.innerHTML).toContain('gemini-4-argon-high (unavailable on current tiers)');
        expect(container.innerHTML).toContain("copyModelName('gemini-4-argon', this)");
        expect(container.innerHTML).not.toContain("copyModelName('gemini-4-argon (not returned by upstream)'");
    });

    test('Playground options retain exact model IDs when labels have suffixes', async () => {
        const providerSelect = { value: '' };
        const options = [];
        const modelSelect = { value: '', appendChild: option => options.push(option) };
        global.document = {
            getElementById: id => id === 'pg-provider-select' ? providerSelect : id === 'pg-model-select' ? modelSelect : null,
            createElement: () => ({})
        };
        global.localStorage = { getItem: key => ({
            pg_selected_provider: 'gemini-antigravity',
            pg_selected_model: 'gemini-4-argon'
        })[key] || null };
        global.fetch = jest.fn(async url => url.startsWith('/api/provider-models')
            ? { ok: true, json: async () => fullCatalog }
            : { ok: false });

        await loadPlaygroundData();

        expect(fetch).toHaveBeenCalledWith('/api/provider-models?includeUnavailable=true', expect.any(Object));
        expect(options[0]).toMatchObject({ value: 'gemini-4-argon', textContent: 'gemini-4-argon (not returned by upstream)' });
        expect(options[1]).toMatchObject({ value: 'gemini-4-argon-high', textContent: 'gemini-4-argon-high (unavailable on current tiers)' });
        expect(options[2]).toMatchObject({ value: 'gemini-3.8-flash-low', textContent: 'gemini-3.8-flash-low' });
        expect(modelSelect.value).toBe('gemini-4-argon');
    });
});
