import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui/ToastContext'
import DepositModal from './DepositModal'
import { getStkPushStatus, initiateStkPush } from '../../services/mpesaApi'
import i18n from '../../i18n'

vi.mock('../../services/mpesaApi', () => ({
  getStkPushStatus: vi.fn(),
  initiateStkPush: vi.fn(),
}))

describe('DepositModal', () => {
  afterEach(async () => {
    cleanup()
    vi.useRealTimers()
    await i18n.changeLanguage('en')
  })

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

  it('reports completion to the dashboard only after the status API confirms it', async () => {
    const onCompleted = vi.fn()
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-verified',
      checkout_request_id: 'checkout-verified',
      transaction_status: 'PENDING',
      amount: 2500,
    })
    getStkPushStatus.mockResolvedValue({
      transaction_id: 'transaction-verified',
      checkout_request_id: 'checkout-verified',
      transaction_status: 'COMPLETED',
      amount: 2500,
    })
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} onCompleted={onCompleted} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '07000000004' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))
      await Promise.resolve()
    })

    expect(onCompleted).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(getStkPushStatus).toHaveBeenCalledWith('checkout-verified')
    expect(onCompleted).toHaveBeenCalledOnce()
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      transaction_status: 'COMPLETED',
      transaction_id: 'transaction-verified',
    }))
    expect(screen.getByRole('heading', { name: 'Deposit Successful!' })).toBeInTheDocument()
  })

  it('does not report timeout status as a completed deposit', async () => {
    const onCompleted = vi.fn()
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-timeout',
      checkout_request_id: 'checkout-timeout',
      transaction_status: 'PENDING',
      amount: 2500,
    })
    getStkPushStatus.mockResolvedValue({
      transaction_id: 'transaction-timeout',
      checkout_request_id: 'checkout-timeout',
      transaction_status: 'TIMED_OUT',
      amount: 2500,
      mpesa_result_description: 'No response from user.',
    })
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} onCompleted={onCompleted} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '07000000004' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(onCompleted).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Payment Timed Out' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Deposit Successful!' })).not.toBeInTheDocument()
  })

  it('updates the deposit form and pending status in Kiswahili without losing entered values', async () => {
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-sw',
      checkout_request_id: 'checkout-sw',
      transaction_status: 'PENDING',
      confirmation_pending: true,
      amount: 2500,
    })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '07000000004' } })
    await act(async () => {
      await i18n.changeLanguage('sw')
    })

    expect(screen.getByRole('heading', { name: 'Ongeza kwenye akaunti yako ya pensheni' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Funga' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Uhamisho wa benki / Paybill' }))
    expect(screen.getByRole('heading', { name: 'Kuweka pesa kupitia benki bado hakupatikani' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'M-Pesa STK Push' }))
    expect(screen.getByLabelText('Kiasi (KES)')).toHaveValue(2500)
    expect(screen.getByLabelText('Nambari ya simu ya M-Pesa')).toHaveValue('07000000004')

    fireEvent.click(screen.getByRole('button', { name: 'Tuma ombi la STK Push' }))
    await waitFor(() => expect(initiateStkPush).toHaveBeenCalledWith({
      amount: 2500,
      phoneNumber: '07000000004',
    }))
    expect(await screen.findByRole('heading', { name: 'Inasubiri uthibitisho wa mtoa huduma...' })).toBeInTheDocument()
    expect(screen.getByText(/hakuna pesa iliyoongezwa kwenye salio/i)).toBeInTheDocument()
    expect(getStkPushStatus).not.toHaveBeenCalled()
  })
})
