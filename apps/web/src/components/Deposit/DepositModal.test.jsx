import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui/ToastContext'
import DepositModal from './DepositModal'
import { getStkPushStatus, initiateStkPush } from '../../services/mpesaApi'

vi.mock('../../services/mpesaApi', () => ({
  getStkPushStatus: vi.fn(),
  initiateStkPush: vi.fn(),
}))

describe('DepositModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('submits an STK request and shows pending confirmation without claiming payment success', async () => {
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-test',
      checkout_request_id: 'checkout-test',
      transaction_status: 'PENDING',
      amount: 2500,
    })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '07000000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    await waitFor(() => expect(initiateStkPush).toHaveBeenCalledWith({
      amount: 2500,
      phoneNumber: '07000000004',
    }))
    expect(await screen.findByRole('heading', { name: 'Awaiting PIN entry...' })).toBeInTheDocument()
    expect(screen.getByText(/Enter your M-Pesa PIN/)).toBeInTheDocument()
    expect(screen.queryByText('Deposit Successful!')).not.toBeInTheDocument()
    expect(getStkPushStatus).not.toHaveBeenCalled()
  })
})
