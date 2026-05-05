import React from 'react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

/** Lazy-loaded with Analytics tab only. */
export default function AnalyticsCharts({ monthRevenue, supplierData, statusData, fmt$, chartColors }) {
  const colors = chartColors || [];
  return (
    <>
      {monthRevenue.length > 1 && (
        <div className="card mb-4">
          <h3 style={{ marginBottom: 14, color: 'var(--brown)', fontSize: 15 }}>Monthly Revenue</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={monthRevenue}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EED9B0" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => '$' + v.toLocaleString()} tick={{ fontSize: 11 }} width={70} />
              <Tooltip formatter={(v) => [fmt$(v), 'Revenue']} />
              <Line type="monotone" dataKey="total" stroke="#8B4513" strokeWidth={2.5} dot={{ r: 4 }} name="Revenue" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16, marginBottom: 16 }}>
        {supplierData.length > 0 && (
          <div className="card">
            <h3 style={{ marginBottom: 14, color: 'var(--brown)', fontSize: 15 }}>Spending by Supplier</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={supplierData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EED9B0" />
                <XAxis type="number" tickFormatter={(v) => '$' + v} tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={90} />
                <Tooltip formatter={(v) => [fmt$(v), 'Spending']} />
                <Bar dataKey="total" fill="#D2691E" name="Spending" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {statusData.length > 0 && (
          <div className="card">
            <h3 style={{ marginBottom: 14, color: 'var(--brown)', fontSize: 15 }}>Invoice Status</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={statusData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {statusData.map((_, i) => (
                    <Cell key={i} fill={colors[i % colors.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </>
  );
}
