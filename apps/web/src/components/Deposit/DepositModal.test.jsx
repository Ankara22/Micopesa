import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui/ToastContext'
import DepositModal from './DepositModal'
import {
  confirmSimulatedPayment,
  getPaymentProvider,
  getStkPushStatus,
  getStkPushStatusByIdempotencyKey,
  initiateStkPush,
} from '../../services/mpesaApi'
import { getMyBalance, getMyContributions } from '../../services/accountService'
import i18n from '../../i18n'

vi.mock('../../services/mpesaApi', () => ({
  confirmSimulatedPayment: vi.fn(),
  getPaymentProvider: vi.fn(),
  getStkPushStatus: vi.fn(),
  getStkPushStatusByIdempotencyKey: vi.fn(),
  initiateStkPush: vi.fn(),
}))

vi.mock('../../services/accountService', () => ({
  getMyBalance: vi.fn(),
  getMyContributions: vi.fn(),
}))

describe('DepositModal', () => {
  afterEach(async () => {
    cleanup()
    window.sessionStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await i18n.changeLanguage('en')
  })

  beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    if (typeof window.crypto.randomUUID !== 'function') {
      Object.defineProperty(window.crypto, 'randomUUID', {
        configurable: true,
        value: () => 'worker-attempt-key-001',
      })
    } else {
      vi.spyOn(window.crypto, 'randomUUID').mockReturnValue('worker-attempt-key-001')
    }
    getMyBalance.mockResolvedValue({ current_balance: 0 })
    getMyContributions.mockResolvedValue([])
    getPaymentProvider.mockResolvedValue({ provider: 'DARAJA', simulator_enabled: false })
    confirmSimulatedPayment.mockResolvedValue({
      payment_provider: 'SIMULATED',
      simulated: true,
      payment_outcome: 'PENDING',
    })
  })

  async function submitAmbiguousDeposit() {
    initiateStkPush.mockRejectedValue(Object.assign(new Error('request timeout'), {
      code: 'ECONNRESET',
    }))
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))
    return screen.findByRole('heading', { name: 'Payment confirmation unknown' })
  }

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
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    await waitFor(() => expect(initiateStkPush).toHaveBeenCalledWith({
      amount: 2500,
      phoneNumber: '0700000004',
      idempotencyKey: 'worker-attempt-key-001',
      contributionId: undefined,
    }))
    expect(window.sessionStorage.getItem('micopesa.mpesa.paymentIdempotencyKey'))
      .toBe('worker-attempt-key-001')
    expect(await screen.findByRole('heading', { name: 'Awaiting provider confirmation...' })).toBeInTheDocument()
    expect(screen.getByText(/no balance has been credited/i)).toBeInTheDocument()
    expect(screen.queryByText('Deposit Successful!')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeInTheDocument()
    expect(getStkPushStatus).not.toHaveBeenCalled()
  })

  it('rejects malformed Kenyan phone numbers in the browser form without starting a payment', async () => {
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    const phone = screen.getByLabelText('M-Pesa phone number')
    expect(phone).toHaveAttribute('pattern')
    expect(phone).toHaveAttribute('title', 'Enter a valid Kenyan M-Pesa number, such as 0712345678 or +254712345678.')

    fireEvent.change(phone, { target: { value: '123' } })
    expect(phone.validity.patternMismatch).toBe(true)
    expect(initiateStkPush).not.toHaveBeenCalled()

    fireEvent.change(phone, { target: { value: '0712345678' } })
    expect(phone.validity.valid).toBe(true)
    expect(initiateStkPush).not.toHaveBeenCalled()
  })

  it('clearly labels a simulated payment and does not present it as real M-Pesa', async () => {
    getPaymentProvider.mockResolvedValue({ provider: 'SIMULATOR', simulator_enabled: true })
    initiateStkPush.mockResolvedValue({
      attempt_id: 'attempt-simulated',
      contribution_id: 'contribution-simulated',
      transaction_id: 'transaction-simulated',
      checkout_request_id: 'SIMAAAAAAAAAAAAAAAAAAAAAA',
      payment_status: 'PROMPT_ACCEPTED',
      attempt_status: 'PROMPT_ACCEPTED',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      payment_provider: 'SIMULATED',
      simulated: true,
      payment_outcome: 'PENDING',
      amount: 100,
    })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    expect(await screen.findByText('SIMULATED')).toBeInTheDocument()
    expect(screen.getByText(/does not contact Safaricom or transfer money/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulated payment' }))

    await waitFor(() => expect(initiateStkPush).toHaveBeenCalledWith({
      amount: 100,
      phoneNumber: '0700000004',
      idempotencyKey: 'worker-attempt-key-001',
      contributionId: undefined,
      provider: 'SIMULATOR',
    }))
    expect(await screen.findByText(/No real money was transferred/i)).toBeInTheDocument()
    expect(screen.getByText(/SIMAAAAAAAAAAAAAAAAAAAAAA/)).toBeInTheDocument()
  })

  it('restores a timed-out request by its persisted idempotency key after remount', async () => {
    initiateStkPush.mockRejectedValue(Object.assign(new Error('request timeout'), {
      code: 'ECONNRESET',
    }))
    const firstRender = render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    expect(await screen.findByRole('heading', { name: 'Payment confirmation unknown' }))
      .toBeInTheDocument()
    const key = window.sessionStorage.getItem('micopesa.mpesa.paymentIdempotencyKey')
    expect(key).toBe('worker-attempt-key-001')
    firstRender.unmount()

    const restoredPayment = {
      attempt_id: 'attempt-restored',
      contribution_id: 'contribution-restored',
      transaction_id: 'transaction-restored',
      amount: '2500.00',
      attempt_status: 'OUTCOME_UNKNOWN',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      receipt_reference: null,
      settled_at: null,
    }
    getStkPushStatusByIdempotencyKey.mockResolvedValue(restoredPayment)
    getStkPushStatus.mockResolvedValue(restoredPayment)
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    await waitFor(() => expect(getStkPushStatusByIdempotencyKey).toHaveBeenCalledWith(key))
    expect(await screen.findByRole('heading', { name: 'Payment confirmation unknown' }))
      .toBeInTheDocument()
    expect(getStkPushStatus).toHaveBeenCalledWith('attempt-restored')
    expect(initiateStkPush).toHaveBeenCalledTimes(1)
  })

  it('recovers an ambiguous submission by idempotency key without submitting again', async () => {
    initiateStkPush.mockRejectedValue(Object.assign(new Error('request timeout'), {
      code: 'ECONNRESET',
    }))
    const recoveredPayment = {
      attempt_id: 'attempt-recovered',
      contribution_id: 'contribution-recovered',
      transaction_id: 'transaction-recovered',
      amount: '2500.00',
      attempt_status: 'OUTCOME_UNKNOWN',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      payment_provider: 'SIMULATED',
      receipt_reference: null,
      settled_at: null,
    }
    const settledPayment = {
      ...recoveredPayment,
      attempt_status: 'OUTCOME_UNKNOWN',
      transaction_status: 'COMPLETED',
      contribution_status: 'COMPLETED',
      settlement_confirmed: true,
      settled_at: '2026-11-04T08:00:00.000Z',
    }
    getStkPushStatusByIdempotencyKey.mockResolvedValue(recoveredPayment)
    getStkPushStatus.mockResolvedValue(settledPayment)
    getMyBalance.mockResolvedValue({ current_balance: 2500 })
    getMyContributions.mockResolvedValue([{ transaction_id: 'transaction-recovered' }])
    const onCompleted = vi.fn()
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} onCompleted={onCompleted} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    expect(await screen.findByRole('heading', { name: 'Payment confirmation unknown' }))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status' }))

    await waitFor(() => expect(getStkPushStatusByIdempotencyKey)
      .toHaveBeenCalledWith('worker-attempt-key-001'))
    expect(initiateStkPush).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'worker-attempt-key-001',
    }))
    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce())
    expect(getStkPushStatus).toHaveBeenCalledWith('attempt-recovered')
    expect(confirmSimulatedPayment).toHaveBeenCalledWith('attempt-recovered')
    expect(initiateStkPush).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Deposit Successful!' })).toBeInTheDocument()
  })

  it('shows loading immediately and displays the recovered simulated pending state', async () => {
    let resolveLookup
    const recoveredPayment = {
      attempt_id: 'attempt-pending',
      contribution_id: 'contribution-pending',
      transaction_id: 'transaction-pending',
      amount: '2500.00',
      attempt_status: 'OUTCOME_UNKNOWN',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      payment_provider: 'SIMULATED',
      payment_outcome: 'PENDING',
      receipt_reference: null,
      settled_at: null,
    }
    getStkPushStatusByIdempotencyKey.mockImplementation(() => new Promise((resolve) => {
      resolveLookup = resolve
    }))
    getStkPushStatus.mockResolvedValue(recoveredPayment)

    await submitAmbiguousDeposit()
    const checkButton = screen.getByRole('button', { name: 'Check payment status' })
    fireEvent.click(checkButton)

    await waitFor(() => expect(getStkPushStatusByIdempotencyKey)
      .toHaveBeenCalledWith('worker-attempt-key-001'))
    expect(checkButton).toHaveAttribute('aria-busy', 'true')
    await act(async () => resolveLookup(recoveredPayment))

    expect(await screen.findByRole('heading', { name: 'Simulated payment pending' }))
      .toBeInTheDocument()
    expect(screen.getByText(/No real money was transferred/i)).toBeInTheDocument()
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Retry simulated confirmation' }),
    ).not.toHaveAttribute('aria-busy', 'true'))
    expect(initiateStkPush).toHaveBeenCalledOnce()
  })

  it('shows a clear failed state for a recovered terminal attempt without reconfirming it', async () => {
    const failedPayment = {
      attempt_id: 'attempt-failed',
      contribution_id: 'contribution-failed',
      transaction_id: 'transaction-failed',
      amount: '2500.00',
      attempt_status: 'FAILED',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      payment_provider: 'SIMULATED',
      receipt_reference: null,
      settled_at: null,
    }
    getStkPushStatusByIdempotencyKey.mockResolvedValue(failedPayment)
    getStkPushStatus.mockResolvedValue(failedPayment)

    await submitAmbiguousDeposit()
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status' }))

    expect(await screen.findByRole('heading', { name: 'Payment Not Completed' }))
      .toBeInTheDocument()
    expect(screen.getByText(/No funds were added/i)).toBeInTheDocument()
    expect(confirmSimulatedPayment).not.toHaveBeenCalled()
    expect(initiateStkPush).toHaveBeenCalledOnce()
  })

  it('explains when no attempt exists for the saved idempotency key and resets loading', async () => {
    getStkPushStatusByIdempotencyKey.mockRejectedValue({ status: 404 })
    await submitAmbiguousDeposit()
    const checkButton = screen.getByRole('button', { name: 'Check payment status' })
    fireEvent.click(checkButton)

    expect(await screen.findByText(/could not be found for your account/i)).toBeInTheDocument()
    await waitFor(() => expect(checkButton).not.toHaveAttribute('aria-busy', 'true'))
    expect(screen.getByText(/clearing the key does not cancel any payment/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved key and return to deposit form' }))

    expect(screen.getByLabelText('Amount (KES)')).toBeInTheDocument()
    expect(screen.getByLabelText('M-Pesa phone number')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('micopesa.mpesa.paymentIdempotencyKey')).toBeNull()
    expect(window.sessionStorage.getItem('micopesa.mpesa.lastPaymentAttempt')).toBeNull()
    expect(initiateStkPush).toHaveBeenCalledOnce()
  })

  it('restores a missing saved key as not found and permits an explicit reset without submitting', async () => {
    window.sessionStorage.setItem('micopesa.mpesa.paymentIdempotencyKey', 'missing-key-001')
    getStkPushStatusByIdempotencyKey.mockRejectedValue({ status: 404 })

    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    expect(await screen.findByText(/could not be found for your account/i)).toBeInTheDocument()
    expect(screen.getByText(/clearing the key does not cancel any payment/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved key and return to deposit form' }))

    expect(screen.getByLabelText('Amount (KES)')).toBeInTheDocument()
    expect(window.sessionStorage.getItem('micopesa.mpesa.paymentIdempotencyKey')).toBeNull()
    expect(getStkPushStatusByIdempotencyKey).toHaveBeenCalledWith('missing-key-001')
    expect(initiateStkPush).not.toHaveBeenCalled()
  })

  it('shows status lookup server errors and allows another status check', async () => {
    getStkPushStatusByIdempotencyKey.mockRejectedValue({ status: 500 })
    await submitAmbiguousDeposit()
    const checkButton = screen.getByRole('button', { name: 'Check payment status' })
    fireEvent.click(checkButton)

    expect(await screen.findByText(/Unable to check payment status/i)).toBeInTheDocument()
    await waitFor(() => expect(checkButton).not.toHaveAttribute('aria-busy', 'true'))
    fireEvent.click(checkButton)
    await waitFor(() => expect(getStkPushStatusByIdempotencyKey).toHaveBeenCalledTimes(2))
    expect(initiateStkPush).toHaveBeenCalledOnce()
  })

  it('handles an expired session without exposing API details', async () => {
    initiateStkPush.mockRejectedValue({
      status: 401,
      message: 'database connection failed',
    })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/session has expired/i)
    expect(screen.queryByText(/database connection failed/i)).not.toBeInTheDocument()
  })

  it('stops automatic status polling when the session expires', async () => {
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-session-expired',
      checkout_request_id: 'checkout-session-expired',
      transaction_status: 'PENDING',
    })
    getStkPushStatus.mockRejectedValue({ status: 401 })
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
      fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.getByText(/session has expired/i)).toBeInTheDocument()
    expect(getStkPushStatus).toHaveBeenCalledOnce()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })
    expect(getStkPushStatus).toHaveBeenCalledOnce()
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
      attempt_status: 'PROMPT_ACCEPTED',
      transaction_id: 'transaction-verified',
      checkout_request_id: 'checkout-verified',
      transaction_status: 'COMPLETED',
      contribution_status: 'COMPLETED',
      settlement_confirmed: true,
      amount: 2500,
      account_balance: 3500,
      receipt_reference: 'QBC123XYZ',
      settled_at: '2026-11-04T08:00:00.000Z',
    })
    getMyBalance.mockResolvedValue({ current_balance: 3500 })
    getMyContributions.mockResolvedValue([{ transaction_id: 'transaction-verified' }])
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} onCompleted={onCompleted} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
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
    }), {
      balance: { current_balance: 3500 },
      contributions: [{ transaction_id: 'transaction-verified' }],
    })
    expect(getMyBalance).toHaveBeenCalledOnce()
    expect(getMyContributions).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Deposit Successful!' })).toBeInTheDocument()
    expect(screen.getByText(/QBC123XYZ/)).toBeInTheDocument()
    expect(screen.getByText(/Settled:/)).toBeInTheDocument()
  })

  it('does not show success when only the transaction is completed', async () => {
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-inconsistent',
      checkout_request_id: 'checkout-inconsistent',
      transaction_status: 'PENDING',
      payment_status: 'PROMPT_ACCEPTED',
      amount: 2500,
    })
    getStkPushStatus.mockResolvedValue({
      attempt_status: 'PROMPT_ACCEPTED',
      transaction_id: 'transaction-inconsistent',
      checkout_request_id: 'checkout-inconsistent',
      transaction_status: 'COMPLETED',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      amount: 2500,
    })
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
      fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(screen.getByRole('heading', { name: 'Payment request accepted' })).toBeInTheDocument()
    expect(screen.getByText(/records do not yet agree/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Deposit Successful!' })).not.toBeInTheDocument()
    expect(getMyBalance).not.toHaveBeenCalled()
    expect(getMyContributions).not.toHaveBeenCalled()
  })

  it('shows provider acceptance without implying payment success', async () => {
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-accepted',
      checkout_request_id: 'checkout-accepted',
      transaction_status: 'PENDING',
      payment_status: 'PROMPT_ACCEPTED',
      amount: 2500,
    })
    getStkPushStatus.mockResolvedValue({
      attempt_status: 'PROMPT_ACCEPTED',
      transaction_id: 'transaction-accepted',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      amount: 2500,
    })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    expect(await screen.findByRole('heading', { name: 'Payment request accepted' })).toBeInTheDocument()
    expect(screen.getByText(/does not mean the payment succeeded/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Deposit Successful!' })).not.toBeInTheDocument()
  })

  it('renders a verified failed attempt as terminal without refreshing credited data', async () => {
    initiateStkPush.mockResolvedValue({
      attempt_id: 'attempt-verified-failure',
      transaction_id: 'transaction-verified-failure',
      checkout_request_id: 'checkout-verified-failure',
      transaction_status: 'PENDING',
      payment_status: 'PROMPT_ACCEPTED',
      amount: 2500,
    })
    getStkPushStatus.mockResolvedValue({
      attempt_id: 'attempt-verified-failure',
      transaction_id: 'transaction-verified-failure',
      attempt_status: 'FAILED',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      receipt_reference: null,
      settled_at: null,
      amount: 2500,
    })
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
      fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(getStkPushStatus).toHaveBeenCalledWith('attempt-verified-failure')
    expect(screen.getByRole('heading', { name: 'Payment Not Completed' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Deposit Successful!' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check payment status' })).not.toBeInTheDocument()
    expect(getMyBalance).not.toHaveBeenCalled()
    expect(getMyContributions).not.toHaveBeenCalled()
  })

  it('prevents a second initiation while the first request is in progress', async () => {
    let resolveInitiation
    initiateStkPush.mockReturnValue(new Promise((resolve) => {
      resolveInitiation = resolve
    }))
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    const submitButton = screen.getByRole('button', { name: 'Send STK Push' })
    fireEvent.click(submitButton)
    fireEvent.click(submitButton)
    await waitFor(() => expect(initiateStkPush).toHaveBeenCalledOnce())

    await act(async () => {
      resolveInitiation({
        transaction_id: 'transaction-in-progress',
        transaction_status: 'PENDING',
      })
    })
    expect(await screen.findByRole('heading', { name: 'Awaiting provider confirmation...' })).toBeInTheDocument()
  })

  it('keeps outcome-unknown attempts in status checking and does not offer a new push', async () => {
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-unknown',
      checkout_request_id: 'checkout-unknown',
      transaction_status: 'PENDING',
      payment_status: 'OUTCOME_UNKNOWN',
      outcome_unknown: true,
      amount: 2500,
    })
    getStkPushStatus.mockResolvedValue({
      attempt_status: 'OUTCOME_UNKNOWN',
      transaction_id: 'transaction-unknown',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      amount: 2500,
    })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    expect(await screen.findByRole('heading', { name: 'Payment confirmation unknown' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check payment status' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send STK Push' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check payment status' }))
    await waitFor(() => expect(getStkPushStatus).toHaveBeenCalledWith('checkout-unknown'))
    expect(initiateStkPush).toHaveBeenCalledOnce()
  })

  it('shows a definitive initiation-gate error without creating a pending payment or clearing the form', async () => {
    initiateStkPush.mockRejectedValue({ status: 503 })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i)
    expect(screen.getByLabelText('Amount (KES)')).toHaveValue(2500)
    expect(screen.getByLabelText('M-Pesa phone number')).toHaveValue('0700000004')
    expect(screen.queryByRole('heading', { name: 'Awaiting provider confirmation...' })).not.toBeInTheDocument()
    expect(getStkPushStatus).not.toHaveBeenCalled()
  })

  it('blocks resubmission when the initiation response is ambiguous', async () => {
    initiateStkPush.mockRejectedValue({ status: null })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    expect(await screen.findByRole('heading', { name: 'Payment confirmation unknown' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send STK Push' })).not.toBeInTheDocument()
    expect(initiateStkPush).toHaveBeenCalledOnce()
    expect(getStkPushStatus).not.toHaveBeenCalled()
  })

  it('shows a definitive failed attempt without crediting or polling it', async () => {
    initiateStkPush.mockResolvedValue({
      transaction_id: 'transaction-failed',
      payment_status: 'FAILED',
      transaction_status: 'PENDING',
      amount: 2500,
    })
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send STK Push' }))

    expect(await screen.findByRole('heading', { name: 'Payment Not Completed' })).toBeInTheDocument()
    expect(screen.getByText(/No funds were added/i)).toBeInTheDocument()
    expect(getStkPushStatus).not.toHaveBeenCalled()
    expect(getMyBalance).not.toHaveBeenCalled()
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
      attempt_status: 'TIMED_OUT',
      transaction_id: 'transaction-timeout',
      checkout_request_id: 'checkout-timeout',
      transaction_status: 'TIMED_OUT',
      contribution_status: 'TIMED_OUT',
      settlement_confirmed: false,
      amount: 2500,
      receipt_reference: null,
      settled_at: null,
    })
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} onCompleted={onCompleted} />
      </ToastProvider>,
    )

    fireEvent.change(screen.getByLabelText('Amount (KES)'), { target: { value: '2500' } })
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
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
    fireEvent.change(screen.getByLabelText('M-Pesa phone number'), { target: { value: '0700000004' } })
    await act(async () => {
      await i18n.changeLanguage('sw')
    })

    expect(screen.getByRole('heading', { name: 'Ongeza kwenye akaunti yako ya pensheni' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Funga' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Uhamisho wa benki / Paybill' }))
    expect(screen.getByRole('heading', { name: 'Kuweka pesa kupitia benki bado hakupatikani' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'M-Pesa STK Push' }))
    expect(screen.getByLabelText('Kiasi (KES)')).toHaveValue(2500)
    expect(screen.getByLabelText('Nambari ya simu ya M-Pesa')).toHaveValue('0700000004')

    fireEvent.click(screen.getByRole('button', { name: 'Tuma ombi la STK Push' }))
    await waitFor(() => expect(initiateStkPush).toHaveBeenCalledWith({
      amount: 2500,
      phoneNumber: '0700000004',
      idempotencyKey: 'worker-attempt-key-001',
      contributionId: undefined,
    }))
    expect(await screen.findByRole('heading', { name: 'Inasubiri uthibitisho wa mtoa huduma...' })).toBeInTheDocument()
    expect(screen.getByText(/hakuna pesa iliyoongezwa kwenye salio/i)).toBeInTheDocument()
    expect(getStkPushStatus).not.toHaveBeenCalled()
  })

  it('restores and checks the saved attempt reference when reopened after a reload', async () => {
    window.sessionStorage.setItem('micopesa.mpesa.lastPaymentAttempt', 'attempt-reload-unknown')
    getStkPushStatus.mockResolvedValue({
      attempt_id: 'attempt-reload-unknown',
      transaction_id: 'transaction-reload-unknown',
      attempt_status: 'OUTCOME_UNKNOWN',
      transaction_status: 'PENDING',
      contribution_status: 'PENDING',
      settlement_confirmed: false,
      receipt_reference: null,
      settled_at: null,
      amount: 2500,
    })

    render(
      <ToastProvider>
        <DepositModal open onClose={vi.fn()} />
      </ToastProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'Payment confirmation unknown' })).toBeInTheDocument()
    expect(getStkPushStatus).toHaveBeenCalledWith('attempt-reload-unknown')
    expect(screen.queryByRole('button', { name: 'Send STK Push' })).not.toBeInTheDocument()
    expect(initiateStkPush).not.toHaveBeenCalled()
  })
})
