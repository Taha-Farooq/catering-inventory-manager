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

/** Lazy-loaded with Daily Income & Expense tab — keeps Recharts out of the main bundle. */
export default function DailyFinanceCharts({ monthly, fmt$ }) {
  if (!monthly || monthly.length <= 1) return null;
  return (
    <div className="card mb-3">
      <h3 style={{ marginBottom: 12, color: 'var(--brown)', fontSize: 15 }}>Monthly Income vs Expense vs Net</h3>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={monthly}>
          <CartesianGrid strokeDasharray="3 3" stroke="#EED9B0" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={(v) => '$' + Number(v).toLocaleString()} tick={{ fontSize: 11 }} width={70} />
          <Tooltip formatter={(v) => fmt$(v)} />
          <Legend />
          <Line type="monotone" dataKey="income" stroke="#16a34a" strokeWidth={2.3} dot={{ r: 3 }} name="Income" />
          <Line type="monotone" dataKey="expense" stroke="#dc2626" strokeWidth={2.3} dot={{ r: 3 }} name="Expense" />
          <Line type="monotone" dataKey="net" stroke="#8B4513" strokeWidth={2.6} dot={{ r: 3 }} name="Net" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
