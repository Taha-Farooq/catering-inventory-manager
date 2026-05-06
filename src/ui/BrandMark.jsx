import React, { useState, useMemo } from 'react';
import { resolveAssetUrl } from '../formatters.js';
import { documentBaseHref } from '../utils/print.js';

export function BrandMark({ brand }) {
  const [failed, setFailed] = useState(false);
  const logoSrc = useMemo(
    () => (brand?.logo ? resolveAssetUrl(brand.logo, documentBaseHref()) : ''),
    [brand?.logo]
  );
  return (
    <div className="invoice-mark">
      {!failed && logoSrc
        ? <img src={logoSrc} alt={`${brand?.name} logo`} onError={() => setFailed(true)} />
        : <span>{brand?.mark}</span>}
    </div>
  );
}
