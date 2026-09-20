import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, tryLoadConfig } from './config.js';

const FULL = {
  VITE_API_BASE_URL: 'https://d5vqb4s6s3.execute-api.ap-south-1.amazonaws.com',
  VITE_COGNITO_USER_POOL_ID: 'ap-south-1_abc123',
  VITE_COGNITO_CLIENT_ID: 'clientid123',
};

describe('loadConfig', () => {
  it('reads a complete environment', () => {
    const config = loadConfig(FULL);
    expect(config.apiBaseUrl).toBe(FULL.VITE_API_BASE_URL);
    expect(config.cognito.userPoolId).toBe('ap-south-1_abc123');
    expect(config.cognito.userPoolClientId).toBe('clientid123');
  });

  it('derives the region from the user pool id', () => {
    expect(loadConfig(FULL).cognito.region).toBe('ap-south-1');
  });

  it('prefers an explicit region override', () => {
    expect(loadConfig({ ...FULL, VITE_AWS_REGION: 'eu-west-1' }).cognito.region).toBe('eu-west-1');
  });

  it('strips a trailing slash so paths do not double up', () => {
    expect(loadConfig({ ...FULL, VITE_API_BASE_URL: 'https://api.example.com//' }).apiBaseUrl).toBe(
      'https://api.example.com',
    );
  });

  it('trims surrounding whitespace, which a copied .env line carries', () => {
    expect(loadConfig({ ...FULL, VITE_COGNITO_CLIENT_ID: '  clientid123  ' }).cognito.userPoolClientId).toBe(
      'clientid123',
    );
  });

  it('refuses to start rather than defaulting the base URL to the origin', () => {
    expect(() => loadConfig({ ...FULL, VITE_API_BASE_URL: '' })).toThrow(ConfigError);
  });

  it('names every missing key at once, not just the first', () => {
    try {
      loadConfig({});
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).missing).toEqual([
        'VITE_API_BASE_URL',
        'VITE_COGNITO_USER_POOL_ID',
        'VITE_COGNITO_CLIENT_ID',
      ]);
    }
  });

  it('carries no secret-shaped field — a public SPA cannot hold a client secret', () => {
    const config = loadConfig(FULL);
    const keys = JSON.stringify(config).toLowerCase();
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('accesskey');
  });
});

describe('tryLoadConfig', () => {
  it('reports failure instead of throwing, so a screen can explain it', () => {
    const result = tryLoadConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.missing).toHaveLength(3);
  });

  it('returns the config when it is complete', () => {
    const result = tryLoadConfig(FULL);
    expect(result.ok).toBe(true);
  });
});
