jest.mock('../static/app/utils.js', () => ({ getProviderConfigs: jest.fn(() => []) }));
jest.mock('../static/app/i18n.js', () => ({ t: key => key }));
jest.mock('../static/app/auth.js', () => ({ apiClient: { get: jest.fn() } }));

import { CustomModelsManager } from '../static/app/custom-models-manager.js';
import { apiClient } from '../static/app/auth.js';

const globals = {
    window: global.window,
    document: global.document,
    confirm: global.confirm,
    alert: global.alert
};
let fetchProviderModels;
let refreshModels;

beforeAll(async () => {
    global.window = { addEventListener: jest.fn() };
    ({ fetchProviderModels, refreshModels } = await import('../static/app/models-manager.js'));
});

beforeEach(async () => {
    global.window = {
        apiClient: {
            post: jest.fn().mockResolvedValue({ success: true }),
            put: jest.fn().mockResolvedValue({ success: true }),
            delete: jest.fn().mockResolvedValue({ success: true })
        },
        refreshModels: jest.fn(refreshModels)
    };
    // No dashboard mounted: refresh must still invalidate the cached response.
    global.document = { getElementById: jest.fn(() => null) };
    global.confirm = jest.fn(() => true);
    global.alert = jest.fn();
    await refreshModels();
    apiClient.get.mockReset();
});

afterAll(() => {
    for (const [name, value] of Object.entries(globals)) {
        if (value === undefined) delete global[name];
        else global[name] = value;
    }
});

describe('Custom model edits invalidate the dashboard model cache', () => {
    test.each(['add', 'update', 'delete'])('%s refreshes provider models after saving', async action => {
        const oldModels = { 'gemini-antigravity': ['gemini-3.8-flash-low'] };
        const newModels = { 'gemini-antigravity': ['gemini-4-argon'] };
        apiClient.get.mockResolvedValueOnce(oldModels).mockResolvedValueOnce(newModels);
        await expect(fetchProviderModels()).resolves.toEqual(oldModels);
        await fetchProviderModels();
        expect(apiClient.get).toHaveBeenCalledTimes(1);

        const fields = {
            customModelForm: { checkValidity: () => true },
            editModelOriginalId: { value: action === 'update' ? 'gemini-4-argon' : '' },
            modelId: { value: 'gemini-4-argon' },
            customModelProvider: { value: 'gemini-antigravity' }
        };
        document.getElementById.mockImplementation(id => fields[id] || null);
        const manager = Object.create(CustomModelsManager.prototype);
        manager.load = jest.fn().mockResolvedValue();
        manager.closeModal = jest.fn();

        if (action === 'delete') await manager.deleteModel('gemini-4-argon');
        else await manager.saveModel();

        expect(window.apiClient[action === 'add' ? 'post' : action === 'update' ? 'put' : 'delete'])
            .toHaveBeenCalledTimes(1);
        expect(window.refreshModels).toHaveBeenCalledTimes(1);
        expect(alert).not.toHaveBeenCalled();
        await expect(fetchProviderModels()).resolves.toEqual(newModels);
        expect(apiClient.get).toHaveBeenCalledTimes(2);
    });

    test('does not refresh lists after a failed save', async () => {
        document.getElementById.mockImplementation(id => id === 'customModelForm'
            ? { checkValidity: () => true }
            : { value: '' });
        window.apiClient.post.mockRejectedValue(new Error('save failed'));
        const manager = Object.create(CustomModelsManager.prototype);
        manager.load = jest.fn();
        await manager.saveModel();
        expect(alert).toHaveBeenCalledWith('save failed');
        expect(window.refreshModels).not.toHaveBeenCalled();
        expect(manager.load).not.toHaveBeenCalled();
    });
});
