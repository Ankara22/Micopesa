import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkerDashboard from './Dashboard'

const serviceMocks = vi.hoisted(() => ({
  getMyBalance: vi.fn(),
  getMyContributions: vi.fn(),
  getRetirementPlan: vi.fn(),
  updateRetirementPlan: vi.fn(),
  getMyClaims: vi.fn(),
  useAuth: vi.fn(),
}))

vi.mock('../../services/accountService', () => ({
  getMyBalance: serviceMocks.getMyBalance,
  getMyContributions: serviceMocks.getMyContributions,
}))
vi.mock('../../services/retirementApi', () => ({
  getRetirementPlan: serviceMocks.getRetirementPlan,
  updateRetirementPlan: serviceMocks.updateRetirementPlan,
}))
vi.mock('../../services/withdrawalService', () => ({
  getMyClaims: serviceMocks.getMyClaims,
}))
vi.mock('../../context/AuthContext', () => ({
  useAuth: serviceMocks.useAuth,
}))
vi.mock('../../components/Retirement/PlanForm', () => ({
  default: () => <div>Retirement plan form</div>,
}))
vi.mock('../../components/Retirement/ProjectionSummary', () => ({
  default: () => <div>Retirement projection summary</div>,
}))
vi.mock('../../components/Deposit/DepositModal', () => ({
  default: ({ open, onCompleted }) => open ? (
    <div role="dialog">
      <span>Deposit flow</span>
      <button onClick={() => onCompleted({ transaction_status: 'PENDING' })}>Pending payment update</button>
      <button onClick={() => onCompleted({ transaction_status: 'COMPLETED' })}>Verified payment update</button>
    </div>
  ) : null,
}))

function renderDashboard() {
  return render(
    <MemoryRouter>
      <WorkerDashboard />
    </MemoryRouter>,
  )
}

describe('WorkerDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serviceMocks.useAuth.mockReturnValue({ user: { full_name: 'Amina Worker' } })
    serviceMocks.getMyBalance.mockResolvedValue({ current_balance: '14850.00', account_status: 'ACTIVE' })
    serviceMocks.getMyContributions.mockResolvedValue([
      {
        contribution_id: 'contribution-1',
        amount: '2500.00',
        channel: 'MPESA',
        contribution_status: 'COMPLETED',
        created_at: '2026-10-20T09:00:00.000Z',
      },
    ])
    serviceMocks.getRetirementPlan.mockResolvedValue({
      plan: { plan_id: 'plan-1', target_amount: '500000.00', target_age: 60, plan_status: 'ACTIVE' },
      projection: { projected_amount: '420000.00', projection_years: 20, assumed_contribution: '2000.00' },
    })
    serviceMocks.getMyClaims.mockResolvedValue([
      { claim_id: 'claim-1', amount_requested: '1200.00', claim_status: 'PENDING' },
    ])
  })

  it('shows the authenticated worker name and API-backed account, plan, claim, and contribution data', async () => {
    renderDashboard()

    expect(await screen.findByRole('heading', { name: /Amina/ })).toBeInTheDocument()
    expect(screen.getByText('KSh 14,850.00')).toBeInTheDocument()
    expect(screen.getByText('KSh 500,000.00')).toBeInTheDocument()
    expect(screen.getByText('KSh 420,000.00')).toBeInTheDocument()
    expect(screen.getByText('KSh 1,200.00')).toBeInTheDocument()
    expect(screen.getByText('KSh 2,500.00')).toBeInTheDocument()
    expect(screen.getByText('COMPLETED')).toBeInTheDocument()
    expect(screen.getByText('Retirement projection summary')).toBeInTheDocument()
  })

  it('shows empty states when the worker has no plan, pending claims, or contributions', async () => {
    serviceMocks.getRetirementPlan.mockRejectedValue({ status: 404, message: 'No plan yet' })
    serviceMocks.getMyClaims.mockResolvedValue([])
    serviceMocks.getMyContributions.mockResolvedValue([])
    renderDashboard()

    expect(await screen.findByText('Create your retirement plan')).toBeInTheDocument()
    expect(screen.getByText('You have no withdrawal requests awaiting review.')).toBeInTheDocument()
    expect(screen.getByText(/No contributions yet/)).toBeInTheDocument()
  })

  it('surfaces withdrawal and contribution service errors instead of presenting empty data', async () => {
    serviceMocks.getMyClaims.mockRejectedValue(new Error('Could not load withdrawal requests'))
    serviceMocks.getMyContributions.mockRejectedValue(new Error('Could not load contributions'))
    renderDashboard()

    await waitFor(() => {
      expect(screen.getByText('Could not load withdrawal requests')).toBeInTheDocument()
      expect(screen.getByText('Could not load contributions')).toBeInTheDocument()
    })
  })

  it('refreshes balance and contribution history only after a completed payment update', async () => {
    renderDashboard()

    fireEvent.click(screen.getAllByRole('button', { name: 'Make a contribution' })[0])
    expect(serviceMocks.getMyBalance).toHaveBeenCalledTimes(1)
    expect(serviceMocks.getMyContributions).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Pending payment update' }))
    expect(serviceMocks.getMyBalance).toHaveBeenCalledTimes(1)
    expect(serviceMocks.getMyContributions).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Verified payment update' }))
    await waitFor(() => {
      expect(serviceMocks.getMyBalance).toHaveBeenCalledTimes(2)
      expect(serviceMocks.getMyContributions).toHaveBeenCalledTimes(2)
    })
  })
})
