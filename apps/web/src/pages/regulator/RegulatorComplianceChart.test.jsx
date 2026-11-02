import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import RegulatorComplianceChart from './RegulatorComplianceChart'

vi.mock('recharts', () => ({
  Bar: () => null,
  BarChart: ({ data }) => <output data-testid="chart-data">{JSON.stringify(data)}</output>,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

describe('RegulatorComplianceChart', () => {
  it('passes the supplied report status series to the chart', () => {
    const series = [
      { status: 'SUBMITTED', reports: 3 },
      { status: 'ACCEPTED', reports: 2 },
    ]
    render(<RegulatorComplianceChart reportStatusData={series} />)
    expect(screen.getByTestId('chart-data')).toHaveTextContent(JSON.stringify(series))
  })
})
