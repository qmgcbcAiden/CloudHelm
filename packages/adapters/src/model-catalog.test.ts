import { describe, expect, it } from 'vitest';
import { createModelCatalog, listModelProviders } from './model-catalog.js';

describe('Pi model catalog settings', () => {
  it('provides a prefilled URL and uses a provider-specific override for model requests', () => {
    const provider = listModelProviders().find((item) => item.id === 'deepseek');
    expect(provider?.defaultBaseUrl).toBe('https://api.deepseek.com');
    const modelId = provider?.models[0]?.id;
    expect(modelId).toBeTruthy();
    const configured = createModelCatalog({ provider: 'deepseek', modelId: modelId!, baseUrl: 'https://proxy.example/v1' });
    expect(configured.getModel('deepseek', modelId!)?.baseUrl).toBe('https://proxy.example/v1');
    expect(createModelCatalog({ provider: 'deepseek', modelId: modelId! }).getModel('deepseek', modelId!)?.baseUrl)
      .toBe('https://api.deepseek.com');
  });
});
