import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Link, Loader2, Lock, LogIn, Save, Settings } from '@/lib/icons'
import { notify, notifyError } from '@/store/notifications'

import { SettingsCategoryHeading } from './env-credentials'
import { ListRow, Pill } from './primitives'

interface ServiceXForm {
  clientId: string
  issuerUrl: string
  port: string
  scopes: string
  upstreamBaseUrl: string
}

type ServiceXStatus = Awaited<ReturnType<Window['hermesDesktop']['serviceX']['status']>>

const DEFAULT_FORM: ServiceXForm = {
  clientId: '',
  issuerUrl: '',
  port: '47831',
  scopes: 'openid profile offline_access',
  upstreamBaseUrl: ''
}

function formFromStatus(status: ServiceXStatus | null): ServiceXForm {
  const config = status?.config

  return config
    ? {
        clientId: config.clientId,
        issuerUrl: config.issuerUrl,
        port: String(config.port),
        scopes: config.scopes,
        upstreamBaseUrl: config.upstreamBaseUrl
      }
    : DEFAULT_FORM
}

export function ServiceXAccount() {
  const { t } = useI18n()
  const copy = t.settings.providers.serviceX
  const bridge = window.hermesDesktop?.serviceX
  const [status, setStatus] = useState<ServiceXStatus | null>(null)
  const [loading, setLoading] = useState(Boolean(bridge))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'install' | 'login' | 'logout' | 'save' | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [form, setForm] = useState<ServiceXForm>(DEFAULT_FORM)

  useEffect(() => {
    let cancelled = false

    if (!bridge) {
      setLoading(false)

      return
    }

    void bridge
      .status()
      .then(next => {
        if (!cancelled) {
          setLoadError(null)
          setStatus(next)
          setForm(formFromStatus(next))
        }
      })
      .catch(error => {
        if (!cancelled) {
          setLoadError(copy.statusFailed)
          notifyError(error, copy.statusFailed)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [bridge, copy.statusFailed])

  if (!bridge) {
    return null
  }

  const statusLabel = loading
    ? copy.loading
    : loadError || status?.error
      ? copy.unavailable
      : !status?.configured
        ? copy.notConfigured
        : status.signedIn
          ? status.displayName || copy.signedIn
          : copy.signedOut

  async function save() {
    setBusy('save')

    try {
      const next = await bridge.saveConfig(form)

      setStatus(next)
      setForm(formFromStatus(next))
      setConfigOpen(false)
      notify({ kind: 'success', message: copy.saved })
    } catch (error) {
      notifyError(error, copy.saveFailed)
    } finally {
      setBusy(null)
    }
  }

  async function login() {
    setBusy('login')

    try {
      const next = await bridge.login()

      setStatus(next)
      notify({ kind: 'success', message: copy.loginComplete })
    } catch (error) {
      notifyError(error, copy.loginFailed)
    } finally {
      setBusy(null)
    }
  }

  async function logout() {
    setBusy('logout')

    try {
      const next = await bridge.logout()

      setStatus(next)
    } catch (error) {
      notifyError(error, copy.logoutFailed)
    } finally {
      setBusy(null)
    }
  }

  async function install() {
    setBusy('install')

    try {
      await bridge.install()
      notify({ kind: 'success', message: copy.installed })
    } catch (error) {
      notifyError(error, copy.installFailed)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mb-6">
      <SettingsCategoryHeading icon={Lock} title={copy.sectionTitle} />
      <ListRow
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={status?.signedIn ? 'primary' : loadError || status?.error ? 'warn' : 'muted'}>
              {statusLabel}
            </Pill>
            <Button
              disabled={Boolean(busy)}
              onClick={() => {
                setForm(formFromStatus(status))
                setConfigOpen(true)
              }}
              size="sm"
              variant="secondary"
            >
              <Settings />
              {copy.configure}
            </Button>
            {status?.signedIn ? (
              <>
                <Button disabled={Boolean(busy) || !status.serviceReady} onClick={() => void install()} size="sm">
                  {busy === 'install' ? <Loader2 className="animate-spin" /> : <Link />}
                  {copy.useWithHermes}
                </Button>
                <Button disabled={Boolean(busy)} onClick={() => void logout()} size="sm" variant="text">
                  {busy === 'logout' ? <Loader2 className="animate-spin" /> : null}
                  {copy.signOut}
                </Button>
              </>
            ) : (
              <Button
                disabled={Boolean(busy) || !status?.configured || !status.serviceReady}
                onClick={() => void login()}
                size="sm"
              >
                {busy === 'login' ? <Loader2 className="animate-spin" /> : <LogIn />}
                {copy.signIn}
              </Button>
            )}
          </div>
        }
        description={loadError || status?.error || copy.description}
        hint={status?.baseUrl}
        title={copy.title}
        wide
      />

      <Dialog onOpenChange={open => !busy && setConfigOpen(open)} open={configOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle icon={Lock}>{copy.dialogTitle}</DialogTitle>
            <DialogDescription>{copy.dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1.5 text-xs text-(--ui-text-tertiary)">
              {copy.issuerLabel}
              <Input
                onChange={event => setForm(current => ({ ...current, issuerUrl: event.target.value }))}
                placeholder="https://id.example.com/realms/hermes"
                value={form.issuerUrl}
              />
            </label>
            <label className="grid gap-1.5 text-xs text-(--ui-text-tertiary)">
              {copy.clientIdLabel}
              <Input
                onChange={event => setForm(current => ({ ...current, clientId: event.target.value }))}
                placeholder="hermes-desktop"
                value={form.clientId}
              />
            </label>
            <label className="grid gap-1.5 text-xs text-(--ui-text-tertiary)">
              {copy.scopesLabel}
              <Input
                onChange={event => setForm(current => ({ ...current, scopes: event.target.value }))}
                value={form.scopes}
              />
            </label>
            <label className="grid gap-1.5 text-xs text-(--ui-text-tertiary)">
              {copy.upstreamLabel}
              <Input
                onChange={event => setForm(current => ({ ...current, upstreamBaseUrl: event.target.value }))}
                placeholder="https://llm.example.com/v1"
                value={form.upstreamBaseUrl}
              />
            </label>
            <label className="grid max-w-36 gap-1.5 text-xs text-(--ui-text-tertiary)">
              {copy.portLabel}
              <Input
                inputMode="numeric"
                onChange={event => setForm(current => ({ ...current, port: event.target.value }))}
                value={form.port}
              />
            </label>
          </div>
          <DialogFooter>
            <Button disabled={Boolean(busy)} onClick={() => setConfigOpen(false)} variant="secondary">
              {copy.cancel}
            </Button>
            <Button disabled={Boolean(busy)} onClick={() => void save()}>
              {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />}
              {copy.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
