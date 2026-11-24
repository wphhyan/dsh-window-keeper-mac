window.__ModuleLoader__.load({
  id: 'dsh-window-keeper-mac',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Profile entry id of this plugin, the settings namespace. */
    const NS = 'window-keeper-mac'

    /** Page text per locale; unknown locales fall back to Chinese. */
    const STRINGS = {
      zh: {
        title: '窗口记忆',
        status: '状态',
        reapply: '重新启用',
        revert: '还原官方包',
        refresh: '刷新',
        hint: '打补丁或还原后需要 ⌘Q 重启才生效。',
        raw: '命名空间原始值',
        empty: '（暂无状态，点「刷新」重试）',
      },
      en: {
        title: 'Window memory',
        status: 'Status',
        reapply: 'Re-enable',
        revert: 'Restore official bundle',
        refresh: 'Refresh',
        hint: 'Restart with ⌘Q after applying or restoring.',
        raw: 'Raw namespace values',
        empty: '(No status yet — press Refresh.)',
      },
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px', maxWidth: '760px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      label: { fontSize: '12px', letterSpacing: '0.02em', color: 'var(--dsw-alias-label-secondary)' },
      status: { fontSize: '14px', lineHeight: 1.55, color: 'var(--dsw-alias-label-primary)' },
      detail: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' },
      button: {
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: '13px',
      },
      danger: {
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        cursor: 'pointer',
        fontSize: '13px',
      },
      busy: { opacity: 0.55, cursor: 'default' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
      pre: {
        margin: 0,
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: '11px',
        lineHeight: 1.45,
        overflowX: 'auto',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /**
     * Read this plugin's settings namespace through the client settings channel.
     * @param {() => object | undefined} remote - resolves `ctx.remote` lazily.
     * @param {(view: object) => void} onView - receives the namespace view.
     * @param {(message: string) => void} onError - receives a readable failure.
     */
    function createLoader(remote, onView, onError) {
      return async () => {
        let settings
        try {
          settings = remote()?.settings
        } catch (error) {
          onError(`读取设置通道失败：${error?.message ?? error}`)
          return
        }
        if (settings === undefined || typeof settings.describe !== 'function') {
          onError('客户端拿不到 ctx.remote.settings，页面无法读取状态；请把这条信息反馈给插件作者。')
          return
        }
        try {
          const described = await settings.describe()
          const view = (described?.namespaces ?? []).find(entry => entry?.ns === NS)
          if (view === undefined) {
            onError(`设置里没有 ${NS} 命名空间。`)
            return
          }
          onView(view)
        } catch (error) {
          onError(`读取状态失败：${error?.message ?? error}`)
        }
      }
    }

    /**
     * Window memory page inside Settings → Plugins.
     * @param {object} props - slot props plus the lazy remote resolver.
     */
    function PageView({ remote, t }) {
      const [view, setView] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(
        createLoader(remote, next => { setView(next); setError(null) }, message => setError(message)),
        [remote],
      )

      useEffect(() => {
        void load()
      }, [load])

      const write = async patch => {
        let settings
        try {
          settings = remote()?.settings
        } catch (caught) {
          setError(String(caught?.message ?? caught))
          return
        }
        if (settings === undefined || typeof settings.update !== 'function') {
          setError('客户端拿不到 ctx.remote.settings，无法执行操作。')
          return
        }
        setBusy(true)
        try {
          await settings.update(NS, patch)
          await new Promise(resolve => setTimeout(resolve, 1200))
          await load()
        } catch (caught) {
          setError(`操作失败：${caught?.message ?? caught}`)
        } finally {
          setBusy(false)
        }
      }

      const values = view?.value ?? {}
      const status = typeof values.status === 'string' ? values.status : ''
      const details = typeof values.details === 'string' ? values.details : ''
      const styleFor = base => (busy ? { ...base, ...styles.busy } : base)

      return h('div', { style: styles.wrap },
        h('div', { style: styles.card },
          h('div', { style: styles.label }, t('status')),
          h('div', { style: styles.status }, status === '' ? t('empty') : status),
          details === '' ? null : h('div', { style: styles.detail }, details),
        ),
        h('div', { style: styles.row },
          h('button', {
            style: styleFor(styles.button),
            disabled: busy,
            onClick: () => void write({ reapplyNow: true }),
          }, t('reapply')),
          h('button', {
            style: styleFor(styles.danger),
            disabled: busy,
            onClick: () => void write({ revertNow: true }),
          }, t('revert')),
          h('button', {
            style: styleFor(styles.button),
            disabled: busy,
            onClick: () => void load(),
          }, t('refresh')),
          h('span', { style: styles.hint }, t('hint')),
        ),
        error === null ? null : h('div', { style: styles.error }, error),
        view === null ? null : h('details', {},
          h('summary', { style: styles.hint }, t('raw')),
          h('pre', { style: styles.pre }, JSON.stringify(values, undefined, 2)),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const remote = () => {
          if (ctx.remote !== undefined) return ctx.remote
          if (typeof ctx.get === 'function') return ctx.get('remote')
          return undefined
        }

        // The tab label and page text follow the host locale when the locale
        // service is available; otherwise Chinese is used.
        let t = key => STRINGS.zh[key] ?? key
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
            locale.register(NS, { zh: STRINGS.zh, en: STRINGS.en })
            const bound = locale.bind(NS)
            t = key => bound(key)
          }
        } catch {}

        const Page = () => h(PageView, { remote, t })
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'window-keeper-mac',
          order: 55,
          label: () => t('title'),
        }, Page))
      },
    }
  },
})