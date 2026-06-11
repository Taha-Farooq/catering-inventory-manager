import { describe, it, expect } from 'vitest';
import { esc, docMoney, docSection, buildProfessionalDoc } from './professionalDoc.js';

describe('esc', () => {
  it('escapes HTML metacharacters', () => {
    expect(esc('<script>"x"&\'y\'</script>'))
      .toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
  });
  it('renders null/undefined as empty', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('docMoney', () => {
  it('formats positive amounts with thousands separators', () => {
    expect(docMoney(1234.5)).toBe('$1,234.50');
    expect(docMoney(0)).toBe('$0.00');
  });
  it('wraps negatives in accounting-style parentheses', () => {
    expect(docMoney(-89.9)).toBe('($89.90)');
  });
  it('coerces junk to $0.00', () => {
    expect(docMoney('abc')).toBe('$0.00');
    expect(docMoney(null)).toBe('$0.00');
  });
});

describe('docSection', () => {
  it('renders heading, rows, and a total', () => {
    const html = docSection({
      heading: 'Revenue',
      rows: [
        { label: 'Catering', value: '$1,000.00' },
        { label: 'Other', value: '$50.00', indent: true },
      ],
      total: { label: 'Total Revenue', value: '$1,050.00' },
    });
    expect(html).toContain('Revenue');
    expect(html).toContain('Catering');
    expect(html).toContain('$1,050.00');
    expect(html).toContain('Total Revenue');
  });
  it('escapes row labels and values', () => {
    const html = docSection({ rows: [{ label: '<b>hi</b>', value: '<i>$5</i>' }] });
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).not.toContain('<b>hi</b>');
  });
  it('works with no rows and no total', () => {
    expect(typeof docSection({ heading: 'Empty' })).toBe('string');
  });
});

describe('buildProfessionalDoc', () => {
  const branding = { name: 'DeGrill Inc', address: 'Spring Valley, NY', phone: '(845) 555-0100', email: 'info@degrill.com', logo: 'assets/logos/degrill.jpg' };

  it('includes branding letterhead and document type', () => {
    const html = buildProfessionalDoc({ branding, docType: 'PROFIT & LOSS STATEMENT', bodyHtml: '<p>body</p>' });
    expect(html).toContain('DeGrill Inc');
    expect(html).toContain('Spring Valley, NY');
    expect(html).toContain('PROFIT &amp; LOSS STATEMENT');
    expect(html).toContain('<p>body</p>');
  });

  it('renders the recipient block when provided', () => {
    const html = buildProfessionalDoc({
      branding, docType: 'PAY STUB',
      recipient: { title: 'Paid To', lines: ['Sally Smith', 'Server'] },
      bodyHtml: '',
    });
    expect(html).toContain('Paid To');
    expect(html).toContain('Sally Smith');
  });

  it('renders the period label and doc number', () => {
    const html = buildProfessionalDoc({ branding, docType: 'X', docNumber: 'PL-2026-10', periodLabel: 'October 2026', bodyHtml: '' });
    expect(html).toContain('PL-2026-10');
    expect(html).toContain('October 2026');
  });

  it('stamps a confidential note when requested', () => {
    const html = buildProfessionalDoc({ branding, docType: 'X', bodyHtml: '', confidential: true });
    expect(html).toContain('CONFIDENTIAL');
  });

  it('escapes branding values (no injection via business name)', () => {
    const html = buildProfessionalDoc({ branding: { name: '<script>alert(1)</script>' }, docType: 'X', bodyHtml: '' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('always includes a generated-on footer', () => {
    const html = buildProfessionalDoc({ branding, docType: 'X', bodyHtml: '' });
    expect(html).toContain('Generated');
  });
});
