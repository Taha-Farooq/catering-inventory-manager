import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

/** Lazy-loaded with Price History tab only. */
export default function PriceHistoryChart({ chartData, sellers, itemLabel, fmt$, chartColors }) {
  const colors = chartColors || [];
  if (!chartData || chartData.length <= 1 || !sellers?.length) return null;
  return (
    <div className="card mb-4">
      <h3 style={{ marginBottom: 14, color: 'var(--brown)', fontSize: 15 }}>
        Price Trends — {itemLabel}
      </h3>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#EED9B0" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={(v) => '$' + v} tick={{ fontSize: 11 }} width={55} />
          <Tooltip formatter={(v) => [fmt$(v), 'Price']} />
          <Legend />
          {sellers.map((s, i) => (
            <Line
              key={s}
              type="monotone"
              dataKey={s}
              stroke={colors[i % colors.length]}
              strokeWidth={2.5}
              dot={{ r: 5 }}
              connectNulls
              name={s}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
