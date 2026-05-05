import { describe, it, expect } from 'vitest';
import {
  classifyFetchException,
  classifyHttpStatus,
  mergeApiFailure,
  userMessageForCode,
} from './apiErrors.js';

describe('classifyHttpStatus', () => {
  it('401 on login path is DMG-E020', () => {
    const r = classifyHttpStatus(401, '/api/auth/login');
    expect(r.code).toBe('DMG-E020');
  });
  it('401 elsewhere is DMG-E022', () => {
    expect(classifyHttpStatus(401, '/api/foo').code).toBe('DMG-E022');
  });
  it('403 is DMG-E031', () => {
    expect(classifyHttpStatus(403).code).toBe('DMG-E031');
  });
  it('500 is DMG-E021', () => {
    expect(classifyHttpStatus(502).code).toBe('DMG-E021');
  });
});

describe('classifyFetchException', () => {
  it('TypeError Failed to fetch -> DMG-E021', () => {
    const e = new TypeError('Failed to fetch');
    expect(classifyFetchException(e).code).toBe('DMG-E021');
  });
  it('Timeout string -> DMG-E021', () => {
    expect(classifyFetchException(new Error('Timeout')).code).toBe('DMG-E021');
  });
});

describe('mergeApiFailure', () => {
  it('prefers HTTP classification when response present', () => {
    const m = mergeApiFailure({
      response: { status: 403 },
      path: '/api/x',
    });
    expect(m.code).toBe('DMG-E031');
  });
  it('uses exception when no response', () => {
    const m = mergeApiFailure({
      exception: new TypeError('Failed to fetch'),
      path: '/api/y',
    });
    expect(m.code).toBe('DMG-E021');
  });
});

describe('userMessageForCode', () => {
  it('includes code for E020', () => {
    expect(userMessageForCode('DMG-E020')).toContain('DMG-E020');
  });
});
