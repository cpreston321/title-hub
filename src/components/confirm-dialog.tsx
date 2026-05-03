'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ConfirmOptions = {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  /**
   * When true the confirm button is rendered with the destructive button
   * variant (red) and the alert tone is implied. Use for delete / remove
   * type actions.
   */
  destructive?: boolean
}

export type AlertOptions = {
  title: string
  description?: string
  confirmText?: string
}

type ConfirmRequest = ConfirmOptions & {
  resolve: (ok: boolean) => void
}

type AlertRequest = AlertOptions & {
  resolve: () => void
}

type ConfirmContextValue = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  alert: (opts: AlertOptions) => Promise<void>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function ConfirmDialogProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const [alertReq, setAlertReq] = useState<AlertRequest | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmReq({ ...opts, resolve })
    })
  }, [])

  const alert = useCallback((opts: AlertOptions) => {
    return new Promise<void>((resolve) => {
      setAlertReq({ ...opts, resolve })
    })
  }, [])

  const value = useMemo<ConfirmContextValue>(
    () => ({ confirm, alert }),
    [confirm, alert]
  )

  const closeConfirm = (ok: boolean) => {
    if (!confirmReq) return
    confirmReq.resolve(ok)
    setConfirmReq(null)
  }

  const closeAlert = () => {
    if (!alertReq) return
    alertReq.resolve()
    setAlertReq(null)
  }

  return (
    <ConfirmContext.Provider value={value}>
      {children}

      <AlertDialog
        open={!!confirmReq}
        onOpenChange={(open) => {
          if (!open) closeConfirm(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmReq?.title ?? ''}</AlertDialogTitle>
            {confirmReq?.description && (
              <AlertDialogDescription className="whitespace-pre-line">
                {confirmReq.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => closeConfirm(false)}>
              {confirmReq?.cancelText ?? 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => closeConfirm(true)}
              className={cn(
                confirmReq?.destructive &&
                  buttonVariants({ variant: 'destructive' })
              )}
            >
              {confirmReq?.confirmText ?? 'Continue'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!alertReq}
        onOpenChange={(open) => {
          if (!open) closeAlert()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{alertReq?.title ?? ''}</AlertDialogTitle>
            {alertReq?.description && (
              <AlertDialogDescription className="whitespace-pre-line">
                {alertReq.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={closeAlert}>
              {alertReq?.confirmText ?? 'Got it'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useConfirm must be used inside <ConfirmDialogProvider />')
  }
  return ctx.confirm
}

export function useAlert() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useAlert must be used inside <ConfirmDialogProvider />')
  }
  return ctx.alert
}
