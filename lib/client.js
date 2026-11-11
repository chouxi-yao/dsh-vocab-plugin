// dsh-vocab-plugin / browser half — 词场 Vocab 第二轮
//
// Two mounts, one shared store:
//   conversation.input.left              → the 📖 capsule（当前词库的到期词数）
//   conversation.session.header.actions  → the centred card overlay (fixed)
//
// The overlay lives in the header slot because that is the only list slot that
// renders once per session; the card itself is a position:fixed layer, so its
// DOM parent does not matter.
//
// Flow: 点胶囊 → GET /queue（到期词**全给**，没有 15 张上限）
//       → 每张卡展示时 POST /seen（计冷却与当日次数）
//       → 1/2/3 自评 POST /grade（忘了的会在本轮队尾立刻重试）
//       → 队列剩不到 3 张时 POST /next 静默续上（到期池见底就补 1-3 个 NEW 词），
//         只要还有词就一直背下去；两个池都空了才显示"今日词库已背完"
window.__ModuleLoader__.load({
  id: 'dsh-vocab-plugin',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useReducer } = React

    const API = '/dsh-vocab-plugin/api'

    // ── store ──────────────────────────────────────────────────────────────
    const listeners = new Set()
    const state = {
      decks: [],
      active: 'cet4',
      queue: [],
      index: 0,
      open: false,
      flipped: false,
      loading: false,
      error: '',
      empty: false,
      emptyReason: '',
      buffering: false,
      exhausted: false,
      settings: false,
      toast: '',
    }
    let booted = false
    // 同一张卡只在"真正第一次露出"时计一次冷却，追加/重试导致的 length 变化不重复计
    let seenMarked = ''
    // 最后一次评分的词：点"明天"时优先把它拨回昨天，保证连对次数是累计在同一个词上
    let lastGraded = null

    const emit = () => {
      for (const listener of listeners) listener()
    }
    const set = (patch) => {
      Object.assign(state, patch)
      emit()
    }
    const useStore = () => {
      const [, bump] = useReducer((n) => n + 1, 0)
      useEffect(() => {
        listeners.add(bump)
        return () => listeners.delete(bump)
      }, [])
      return state
    }

    const deckOf = (id) => state.decks.find((deck) => deck.id === id)
    const activeDeck = () => deckOf(state.active)
    const dueCount = () => {
      const deck = activeDeck()
      return deck ? deck.due : 0
    }

    async function api(path, options) {
      const res = await fetch(`${API}${path}`, {
        headers: { accept: 'application/json', ...(options && options.body ? { 'content-type': 'application/json' } : {}) },
        ...options,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function loadDecks() {
      try {
        const data = await api('/decks')
        set({ decks: Array.isArray(data.decks) ? data.decks : [], active: data.active ?? state.active })
        return data
      } catch (error) {
        set({ error: `无法连接插件：${error && error.message ? error.message : error}` })
        return null
      }
    }

    function ensureBoot() {
      if (booted) return
      booted = true
      void loadDecks()
    }

    async function refreshQueue() {
      set({ loading: true, error: '', toast: '', exhausted: false, buffering: false })
      seenMarked = ''
      try {
        const data = await api(`/queue?deck=${state.active}`)
        set({
          queue: Array.isArray(data.cards) ? data.cards : [],
          index: 0,
          flipped: false,
          loading: false,
          empty: Boolean(data.empty),
          emptyReason: data.reason ?? '',
          exhausted: false,
          decks: Array.isArray(data.decks) && data.decks.length ? data.decks : state.decks,
        })
        return data
      } catch (error) {
        set({
          loading: false,
          error: `取词失败：${error && error.message ? error.message : error}`,
        })
        return null
      }
    }

    // 无限流：队列水位低于 2 张时向宿主追加。宿主先给到期词，到期池见底就补
    // 1-3 个 NEW 词；只有两边都真的空了才会返回 empty。
    async function ensureBuffer() {
      if (state.buffering || !state.open) return null
      const remaining = state.queue.length - state.index
      if (remaining > 2) return null
      set({ buffering: true })
      try {
        const exclude = state.queue.map((item) => item.k)
        const data = await api('/next', {
          method: 'POST',
          body: JSON.stringify({ deck: state.active, exclude, want: Math.max(1, 3 - remaining) }),
        })
        const incoming = Array.isArray(data.cards) ? data.cards : []
        if (incoming.length > 0) {
          set({
            queue: [...state.queue, ...incoming],
            decks: Array.isArray(data.decks) && data.decks.length ? data.decks : state.decks,
            buffering: false,
            exhausted: false,
            empty: false,
            emptyReason: '',
          })
        } else {
          set({
            buffering: false,
            exhausted: true,
            emptyReason: data.reason ?? 'no-due',
            decks: Array.isArray(data.decks) && data.decks.length ? data.decks : state.decks,
          })
        }
        // 追加动作本身会抽走新词（NEW → LEARNING），统计数字必须立刻刷新
        void loadDecks()
        return data
      } catch {
        set({ buffering: false })
        return null
      }
    }

    async function switchDeck(deck) {
      if (deck === state.active) return
      set({ active: deck, queue: [], index: 0, flipped: false, empty: false })
      try {
        const data = await api('/deck', { method: 'POST', body: JSON.stringify({ deck }) })
        set({ decks: data.decks ?? state.decks, active: data.active ?? deck })
      } catch {
        /* 切换失败也先把界面切过去，下一次刷新手感更好 */
      }
      if (state.open) await refreshQueue()
      else void loadDecks()
    }

    function openCard() {
      set({ open: true, flipped: false, toast: '' })
      void refreshQueue()
    }
    function closeCard() {
      set({ open: false, toast: '' })
      void loadDecks()
    }
    function toggleFlip() {
      if (!state.queue[state.index]) return
      set({ flipped: !state.flipped })
    }

    async function submitGrade(value) {
      const card = state.queue[state.index]
      if (!card) return
      set({ index: state.index + 1, flipped: false })
      try {
        const data = await api('/grade', {
          method: 'POST',
          body: JSON.stringify({ key: card.k, grade: value }),
        })
        lastGraded = { key: card.k, word: card.w }
        const patch = { decks: data.decks ?? state.decks }
        if (data.retry) {
          // 按 1（忘了）→ 本轮队尾立刻重试
          patch.queue = [...state.queue, { ...card, requeued: true }]
        }
        if (data.known) {
          // 收服：宿主已标成 KNOWN 并移出复习队列
          patch.toast = `🎉 已收服「${card.w}」`
        }
        set(patch)
        // 左下角「待学 / 已学 / 收服」每次都重新向后端要一次真实统计，
        // 不依赖各接口顺手带回的快照，避免数字落后。
        void loadDecks()
      } catch {
        /* 网络失败不阻塞复习节奏，本次评分会在下次刷新时丢失 */
      }
    }

    function markSeen(card) {
      api('/seen', { method: 'POST', body: JSON.stringify({ key: card.k }) }).catch(() => {})
    }

    async function debugSeed() {
      set({ toast: '正在造到期词…' })
      try {
        await api('/debug/learn', { method: 'POST', body: JSON.stringify({ deck: state.active, count: 5 }) })
        await refreshQueue()
        set({ toast: '已把 5 个新词标成"已学且到期"' })
      } catch {
        set({ toast: '调试接口不可用' })
      }
    }

    // 调试：模拟"过了一天"。优先只拨**刚刚评过的那张卡**（没有就拨当前这张），
    // 然后把它重新排到队首，保证连对次数累计在同一个词上。
    async function debugAge() {
      const current = state.queue[state.index] ?? null
      const target = lastGraded ?? (current ? { key: current.k, word: current.w } : null)
      set({ toast: target ? `正在把「${target.word}」拨到"昨天"…` : '正在把到期时间拨到昨天…' })
      try {
        const data = await api('/debug/age', {
          method: 'POST',
          body: JSON.stringify({
            deck: state.active,
            days: 1,
            count: 200,
            ...(target ? { key: target.key } : {}),
          }),
        })
        await refreshQueue()
        if (data.aged === 0 && data.note === 'already-known') {
          set({ toast: `「${target.word}」已收服，不会再出现 🎉` })
          void loadDecks()
          return
        }
        if (target) {
          const index = state.queue.findIndex((item) => item.k === target.key)
          const card = index >= 0 ? state.queue[index] : null
          if (index >= 0) set({ index, flipped: false })
          set({
            toast: card
              ? `「${card.w}」已拨到昨天 · 连对 ${card.consecutiveCorrect ?? 0}/3，按 3 继续`
              : `「${target.word}」已拨到昨天，按 3 继续`,
          })
        } else {
          set({ toast: `已把 ${data.aged} 个词拨到"昨天"（模拟过了一天）` })
        }
        void loadDecks()
      } catch {
        set({ toast: '调试接口不可用' })
      }
    }

    async function debugReset() {
      set({ toast: '正在重置…' })
      try {
        await api('/debug/reset', { method: 'POST', body: JSON.stringify({ deck: state.active }) })
        const data = await loadDecks()
        // 不自动 refreshQueue：那会立刻抽 1-3 个新词，把"待学"又减掉，
        // 看起来就像没重置干净。重置后停在空状态，等用户重新点胶囊再开始。
        seenMarked = ''
        lastGraded = null
        set({
          queue: [],
          index: 0,
          flipped: false,
          loading: false,
          empty: true,
          emptyReason: 'reset',
          exhausted: false,
          buffering: false,
          decks: data?.decks ?? state.decks,
          toast: '本词库已重置：待学恢复、收服归 0',
        })
      } catch {
        set({ toast: '调试接口不可用' })
      }
    }

    // ── design tokens ──────────────────────────────────────────────────────
    const bg = 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))'
    const bgSoft = 'var(--dsw-alias-bg-layer-2, rgba(120,120,128,.08))'
    const line = 'var(--dsw-alias-border-l1, rgba(120,120,128,.22))'
    const text = 'var(--dsw-alias-label-primary, #16181d)'
    const dim = 'var(--dsw-alias-label-secondary, #6b7280)'
    const brand = 'var(--dsw-alias-brand-primary, #3b82f6)'
    const ok = 'var(--dsw-alias-state-success-primary, #16a34a)'

    const faceBase = {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
      padding: '18px 22px',
      backfaceVisibility: 'hidden',
      WebkitBackfaceVisibility: 'hidden',
      textAlign: 'center',
    }

    const chip = (label, onClick, extra) => {
      const active = extra && extra.active
      return h(
        'button',
        {
          key: label,
          type: 'button',
          onClick,
          style: {
            appearance: 'none',
            padding: '3px 10px',
            borderRadius: '999px',
            border: `1px solid ${active ? brand : line}`,
            background: active ? 'transparent' : 'transparent',
            color: active ? brand : dim,
            fontSize: '11px',
            fontWeight: active ? 650 : 500,
            letterSpacing: '.02em',
            cursor: 'pointer',
            lineHeight: 1.5,
          },
        },
        label,
      )
    }

    // 同一个组件会注册到多个槽位（正常会话 / 新会话英雄区 / 兜底层）。
    // 这里保证任一时刻只有最早挂载的那一份真正渲染，避免出现两个胶囊/两层卡片。
    const slotTokens = new Map()
    const slotListeners = new Set()
    let tokenSeq = 0

    function usePrimaryIn(kind) {
      const tokenRef = React.useRef(0)
      if (tokenRef.current === 0) tokenRef.current = ++tokenSeq
      const [, bump] = useReducer((n) => n + 1, 0)
      useEffect(() => {
        const token = tokenRef.current
        let set = slotTokens.get(kind)
        if (!set) {
          set = new Set()
          slotTokens.set(kind, set)
        }
        set.add(token)
        const listener = () => bump()
        slotListeners.add(listener)
        for (const fn of [...slotListeners]) fn()
        return () => {
          set.delete(token)
          slotListeners.delete(listener)
          for (const fn of [...slotListeners]) fn()
        }
      }, [kind])
      const set = slotTokens.get(kind)
      if (!set || set.size === 0) return false
      return Math.min(...set) === tokenRef.current
    }

    // ── capsule ────────────────────────────────────────────────────────────
    function Capsule() {
      const s = useStore()
      const primary = usePrimaryIn('capsule')
      useEffect(() => {
        ensureBoot()
      }, [])
      if (!primary) return null
      const count = dueCount()
      const deck = activeDeck()
      const label = deck ? deck.label : 'CET4'
      return h(
        'button',
        {
          type: 'button',
          'data-dsh-plugin': 'dsh-vocab-plugin',
          'data-dsh-part': 'capsule',
          onClick: () => {
            if (state.open) closeCard()
            else openCard()
          },
          title: `${label} · 待复习 ${count} 词 · 点击打开词卡`,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            height: '28px',
            padding: '0 11px',
            marginRight: '6px',
            borderRadius: '999px',
            border: `1px solid ${line}`,
            background: s.open ? bgSoft : 'transparent',
            color: text,
            fontSize: '12px',
            cursor: 'pointer',
            lineHeight: 1,
            whiteSpace: 'nowrap',
            transition: 'background .15s ease',
          },
        },
        h('span', { style: { fontSize: '13px' } }, '📖'),
        h('span', { style: { fontWeight: 600, letterSpacing: '.02em' } }, label),
      )
    }

    // ── the card ───────────────────────────────────────────────────────────
    function WordCard() {
      const s = useStore()
      const primary = usePrimaryIn('card')
      const card = s.queue[s.index]
      // 无限流：卡片走完不等于结束——只要宿主还能追加，就继续；追不到才算真的背完。
      const finished = !s.loading && !card && s.exhausted

      useEffect(() => {
        ensureBoot()
      }, [])

      useEffect(() => {
        if (!s.open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (state.settings) set({ settings: false })
            else closeCard()
            return
          }
          if (event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault()
            toggleFlip()
            return
          }
          if (event.key === '1' || event.key === '2' || event.key === '3') {
            if (!state.flipped || !state.queue[state.index]) return
            event.preventDefault()
            void submitGrade(Number(event.key))
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [s.open, s.flipped, s.index, s.queue.length])

      // 每张卡真正出现在屏幕上时才计入冷却 / 当日次数（同 key 不重复计）
      useEffect(() => {
        if (!s.open) return
        const current = state.queue[state.index]
        if (!current) return
        if (seenMarked === current.k) return
        seenMarked = current.k
        markSeen(current)
      }, [s.open, s.index, s.queue.length])

      // 无限流：剩不到 3 张就悄悄续上，用户不会看到"这批走完了"
      useEffect(() => {
        if (!s.open || s.loading || s.exhausted || s.buffering) return
        if (s.queue.length - s.index > 2) return
        void ensureBuffer()
      }, [s.open, s.loading, s.index, s.queue.length, s.exhausted, s.buffering])

      if (!s.open || !primary) return null

      const tabs = s.decks.map((deck) => chip(deck.label, () => void switchDeck(deck.id), { active: deck.id === s.active }))

      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 14px 0',
            fontSize: '12px',
            color: dim,
          },
        },
        ...tabs,
        h(
          'span',
          { style: { flex: 1, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } },
          card ? (s.buffering ? `已背 ${s.index} · 取词中` : `已背 ${s.index}`) : '',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => set({ settings: !s.settings }),
            title: '设置（调试工具）',
            'aria-expanded': s.settings ? 'true' : 'false',
            style: {
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              color: s.settings ? text : dim,
              fontSize: '12px',
              lineHeight: '16px',
              cursor: 'pointer',
              padding: '2px 4px',
            },
          },
          '⚙️',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: closeCard,
            title: '关闭（Esc）',
            style: {
              appearance: 'none',
              border: 'none',
              background: 'transparent',
              color: dim,
              fontSize: '18px',
              lineHeight: '18px',
              cursor: 'pointer',
              padding: '2px 4px',
            },
          },
          '×',
        ),
      )

      const deckInfo = activeDeck()

      // 日常界面只有统计数据；调试动作全部收进 ⚙️ 设置里，避免误触
      const footerStats = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px 14px',
            fontSize: '11px',
            color: dim,
          },
        },
        h(
          'span',
          { style: { flex: 1, opacity: 0.85 } },
          s.toast || (deckInfo ? `待学 ${deckInfo.remaining ?? deckInfo.fresh} · 收服 ${deckInfo.known ?? 0}` : ''),
        ),
      )

      const debugButton = (label, title, action, key) =>
        h(
          'button',
          {
            key: key ?? label,
            type: 'button',
            onClick: action,
            title,
            style: {
              appearance: 'none',
              border: `1px solid ${line}`,
              background: 'transparent',
              color: dim,
              borderRadius: '8px',
              padding: '4px 10px',
              fontSize: '11px',
              cursor: 'pointer',
            },
          },
          label,
        )

      const settingsPanel = s.settings
        ? h(
            'div',
            {
              'data-dsh-part': 'settings',
              style: {
                margin: '8px 12px 0',
                padding: '10px 12px',
                borderRadius: '12px',
                border: `1px solid ${line}`,
                background: bgSoft,
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h('span', { style: { fontSize: '11px', fontWeight: 600, color: text } }, '调试工具'),
              h(
                'span',
                { style: { flex: 1, fontSize: '10.5px', color: dim, opacity: 0.8 } },
                '只用于验收，不影响正常复习',
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => set({ settings: false }),
                  title: '收起设置',
                  style: {
                    appearance: 'none',
                    border: 'none',
                    background: 'transparent',
                    color: dim,
                    fontSize: '14px',
                    cursor: 'pointer',
                    padding: '0 2px',
                  },
                },
                '×',
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
              debugButton('⏩ 拨到明天', '把刚评过的那张卡拨回昨天，用于验证跨天与收服', () => void debugAge(), 'age'),
              debugButton('🐞 造到期词', '把 5 个新词标成已学且立刻到期', () => void debugSeed(), 'seed'),
              debugButton('♻️ 重置本词库', '清空当前词库的复习状态（不可撤销）', () => void debugReset(), 'reset'),
            ),
          )
        : null

      let body
      if (s.loading) {
        body = h(
          'div',
          { style: { padding: '40px 22px', textAlign: 'center', color: dim, fontSize: '13px' } },
          '取词中…',
        )
      } else if (s.error) {
        body = h(
          'div',
          {
            style: {
              padding: '28px 22px',
              color: 'var(--dsw-alias-state-error-primary, #dc2626)',
              fontSize: '14px',
            },
          },
          s.error,
        )
      } else if (s.empty || finished) {
        const reason = s.emptyReason || (s.exhausted ? 'no-due' : '')
        const gone = reason === 'exhausted'
        const cooling = reason === 'cooling'
        const reset = reason === 'reset'
        body = h(
          'div',
          { style: { padding: '34px 22px 22px', textAlign: 'center' } },
          h('div', { style: { fontSize: '26px', marginBottom: '8px' } }, gone ? '🎉' : '🌙'),
          h(
            'div',
            { style: { fontSize: '15px', fontWeight: 600 } },
            reset ? '本词库已重置' : gone ? '今日词库已背完' : cooling ? '到期的词都在冷却中' : '暂时没有到期的词',
          ),
          h(
            'div',
            { style: { marginTop: '6px', fontSize: '12px', color: dim, lineHeight: 1.6 } },
            deckInfo
              ? `本词库待学 ${deckInfo.remaining ?? deckInfo.fresh} 词 · 已收服 ${deckInfo.known ?? 0} 词`
              : '',
          ),
          h(
            'div',
            { style: { marginTop: '4px', fontSize: '11px', color: dim, opacity: 0.85 } },
            reset
              ? '再次点开胶囊就会重新开始'
              : gone
                ? '到期池和新词池都空了，明天再来'
                : cooling
                  ? '同一个词 24 小时内只出现 1 次、每天最多 3 次'
                  : '可以先学别的，晚点再回来',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void refreshQueue(),
              style: {
                marginTop: '18px',
                padding: '9px 20px',
                borderRadius: '10px',
                border: `1px solid ${line}`,
                background: bgSoft,
                color: text,
                fontSize: '13px',
                cursor: 'pointer',
              },
            },
            '再取一次',
          ),
        )
      } else if (!card) {
        // 队列刚好走完、下一张还在路上：先撑住版面，别闪一下空白
        body = h(
          'div',
          { style: { padding: '44px 22px', textAlign: 'center', color: dim, fontSize: '13px' } },
          '取词中…',
        )
      } else if (card) {
        body = h(
          'div',
          { style: { padding: '14px 16px 0' } },
          h(
            'div',
            {
              onClick: toggleFlip,
              title: s.flipped ? '回到正面' : '翻面（空格）',
              style: {
                position: 'relative',
                height: '196px',
                perspective: '1200px',
                cursor: 'pointer',
                userSelect: 'none',
              },
            },
            h(
              'div',
              {
                style: {
                  position: 'relative',
                  width: '100%',
                  height: '100%',
                  transformStyle: 'preserve-3d',
                  transition: 'transform .48s cubic-bezier(.2,.8,.2,1)',
                  transform: s.flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
                },
              },
              // front: word + phonetics
              h(
                'div',
                {
                  style: {
                    ...faceBase,
                    borderRadius: '14px',
                    background: bgSoft,
                    border: `1px solid ${line}`,
                  },
                },
                card.source === 'new'
                  ? h(
                      'span',
                      {
                        style: {
                          position: 'absolute',
                          top: '10px',
                          left: '12px',
                          fontSize: '10px',
                          letterSpacing: '.08em',
                          color: brand,
                          fontWeight: 650,
                        },
                      },
                      'NEW',
                    )
                  : null,
                (card.consecutiveCorrect ?? 0) > 0
                  ? h(
                      'span',
                      {
                        style: {
                          position: 'absolute',
                          top: '10px',
                          right: '12px',
                          fontSize: '10px',
                          letterSpacing: '.06em',
                          color: ok,
                          fontWeight: 650,
                        },
                      },
                      `连对 ${card.consecutiveCorrect}/3`,
                    )
                  : null,
                h(
                  'div',
                  {
                    style: {
                      fontSize: card.w.length > 11 ? '30px' : '36px',
                      fontWeight: 650,
                      letterSpacing: '-.01em',
                      wordBreak: 'break-word',
                    },
                  },
                  card.w,
                ),
                h(
                  'div',
                  {
                    style: {
                      fontSize: '12px',
                      color: dim,
                      letterSpacing: '.04em',
                    },
                  },
                  card.p || '\u00a0',
                ),
                h(
                  'div',
                  { style: { fontSize: '11px', color: dim, opacity: 0.75 } },
                  '点击卡片 / 空格 翻面',
                ),
              ),
              // back: meaning + example
              h(
                'div',
                {
                  style: {
                    ...faceBase,
                    borderRadius: '14px',
                    background: bgSoft,
                    border: `1px solid ${line}`,
                    transform: 'rotateY(180deg)',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    textAlign: 'left',
                    gap: '8px',
                  },
                },
                h(
                  'div',
                  { style: { fontSize: '17px', fontWeight: 600, lineHeight: 1.45 } },
                  card.y,
                ),
                card.ex
                  ? h(
                      'div',
                      { style: { fontSize: '13px', color: dim, lineHeight: 1.5 } },
                      card.ex,
                    )
                  : null,
              ),
            ),
          ),
          // grading row
          h(
            'div',
            {
              style: {
                display: 'flex',
                gap: '8px',
                padding: '14px 2px 4px',
                opacity: s.flipped ? 1 : 0.45,
                pointerEvents: s.flipped ? 'auto' : 'none',
                transition: 'opacity .2s ease',
              },
            },
            [
              ['1', '忘了', 'var(--dsw-alias-state-error-primary, #dc2626)'],
              ['2', '模糊', 'var(--dsw-alias-state-warn-primary, #d97706)'],
              ['3', '会了', ok],
            ].map(([key, label, color]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  onClick: () => void submitGrade(Number(key)),
                  style: {
                    flex: 1,
                    padding: '10px 0',
                    borderRadius: '10px',
                    border: `1px solid ${line}`,
                    background: bgSoft,
                    color,
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  },
                },
                `${label} ${key}`,
              ),
            ),
          ),
          h(
            'div',
            {
              style: {
                textAlign: 'center',
                fontSize: '11px',
                color: dim,
                padding: '2px 0 8px',
                opacity: 0.8,
              },
            },
            s.flipped ? '按 1 / 2 / 3 自评' : '翻面后按 1 / 2 / 3 自评',
          ),
        )
      }

      return h(
        'div',
        {
          'data-dsh-plugin': 'dsh-vocab-plugin',
          'data-dsh-surface': 'vocab-card',
          onClick: (event) => {
            if (event.target === event.currentTarget) closeCard()
          },
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,17,21,.28)',
            backdropFilter: 'blur(3px)',
            WebkitBackdropFilter: 'blur(3px)',
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-label': '词场 Vocab 复习卡片',
            style: {
              width: '440px',
              maxWidth: 'calc(100vw - 32px)',
              background: bg,
              color: text,
              border: `1px solid ${line}`,
              borderRadius: '20px',
              boxShadow: '0 24px 60px rgba(0,0,0,.32)',
              fontFamily:
                '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif',
              overflow: 'hidden',
            },
          },
          header,
          settingsPanel,
          body,
          footerStats,
        ),
      )
    }

    // ── DOM 兜底层 ─────────────────────────────────────────────────────────
    // 新会话（sessionId 还没生成）时 DSH 根本不渲染 conversation.input.left，
    // 槽位方案会整块消失。这里用 MutationObserver + 轮询兜底：只要输入框在、
    // 而页面上没有胶囊，就在左下角挂一个等价的 DOM 胶囊；React 胶囊一出现就撤掉。
    let fallbackEl = null
    let fallbackTimer = null

    function fallbackLabel() {
      const deck = activeDeck()
      return deck ? deck.label : 'CET4'
    }

    function removeFallback() {
      if (fallbackEl && fallbackEl.parentNode) fallbackEl.parentNode.removeChild(fallbackEl)
      fallbackEl = null
    }

    function ensureFallback() {
      if (typeof document === 'undefined' || !document.body) return
      if (document.querySelector('[data-dsh-part="capsule"]')) {
        removeFallback()
        return
      }
      const composer = document.querySelector('textarea, [contenteditable="true"]')
      if (!composer) {
        removeFallback()
        return
      }
      if (fallbackEl && document.body.contains(fallbackEl)) {
        fallbackEl.textContent = `📖 ${fallbackLabel()}`
        return
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-dsh-vocab-capsule', '1')
      button.setAttribute('data-dsh-plugin', 'dsh-vocab-plugin')
      button.textContent = `📖 ${fallbackLabel()}`
      Object.assign(button.style, {
        position: 'fixed',
        left: '16px',
        bottom: '16px',
        zIndex: 2147482000,
        display: 'inline-flex',
        alignItems: 'center',
        height: '30px',
        padding: '0 12px',
        borderRadius: '999px',
        border: `1px solid ${line}`,
        background: bg,
        color: text,
        fontSize: '12px',
        fontWeight: '600',
        cursor: 'pointer',
        boxShadow: '0 6px 18px rgba(0,0,0,.18)',
      })
      button.addEventListener('click', () => {
        if (state.open) closeCard()
        else openCard()
      })
      document.body.appendChild(button)
      fallbackEl = button
    }

    function startCapsuleWatchdog() {
      if (typeof document === 'undefined') return () => {}
      ensureFallback()
      const schedule = () => {
        if (fallbackTimer) return
        fallbackTimer = setTimeout(() => {
          fallbackTimer = null
          ensureFallback()
        }, 150)
      }
      let observer
      if (typeof MutationObserver !== 'undefined' && document.body) {
        observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
      }
      const interval = typeof setInterval === 'function' ? setInterval(ensureFallback, 1200) : null
      return () => {
        if (observer) observer.disconnect()
        if (interval !== null) clearInterval(interval)
        if (fallbackTimer) clearTimeout(fallbackTimer)
        removeFallback()
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // `name` must be the SLOT KEY (that is what the slot service routes on);
        // `id` is our entry key inside that slot. Mounts are isolated so one
        // rejected slot cannot hide the other.
        const mounts = [
          // 正常会话：输入框左侧
          ['conversation.input.left', 'dsh-vocab-plugin:capsule', 60, '词场 Vocab — 待复习词数', Capsule],
          // 新会话英雄区：input.left 在 sessionId 生成前不会被渲染，这里兜一个
          ['conversation.hero.options', 'dsh-vocab-plugin:capsule-hero', 20, '词场 Vocab — 待复习词数', Capsule],
          // 卡片：会话内挂 header.actions，根级 shell.overlay 保证新会话也能弹
          ['conversation.session.header.actions', 'dsh-vocab-plugin:card', 140, '词场 Vocab — 复习卡片', WordCard],
          ['shell.overlay', 'dsh-vocab-plugin:card-overlay', 140, '词场 Vocab — 复习卡片', WordCard],
        ]
        for (const [slot, id, order, label, Component] of mounts) {
          try {
            ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id, order, label }, Component))
          } catch (error) {
            console.error('[dsh-vocab-plugin] cannot mount', slot, error)
          }
        }
        // DOM 兜底：只在槽位确实没渲染出胶囊时出现（MutationObserver + 1.2s 轮询）
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => startCapsuleWatchdog(), 'dsh-vocab-plugin: capsule watchdog')
        }
      },
      internals: Object.freeze({ state, refreshQueue, switchDeck }),
    }
  },
})
