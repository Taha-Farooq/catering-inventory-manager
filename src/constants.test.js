import { describe, it, expect } from 'vitest';
import {
  BUSINESSES,
  DEFAULT_USER_PERMS,
  TABS_ADMIN,
  LOGO_OVERRIDES_KEY,
} from './constants.js';

describe('constants', () => {
  it('BUSINESSES has three locations', () => {
    expect(Object.keys(BUSINESSES)).toEqual(['degrill', 'parathas', 'dera']);
  });
  it('default perms are non-empty', () => {
    expect(DEFAULT_USER_PERMS.length).toBeGreaterThan(0);
  });
  it('admin help tab present', () => {
    expect(TABS_ADMIN.some((t) => t.id === 'help')).toBe(true);
  });
  it('logo overrides storage key is stable for backups', () => {
    expect(LOGO_OVERRIDES_KEY).toBe('_logoOverrides');
  });
});
