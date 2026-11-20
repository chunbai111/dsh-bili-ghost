/**
 * Client half of dsh-bili-ghost.
 *
 * Registers a root-level overlay window that appears while a session is
 * running, plays today's top 鬼畜 remixes from Bilibili (through the same-origin
 * feed route owned by the Host half), and unmounts itself — stopping audio — as
 * soon as the run ends.
 */

window.__ModuleLoader__.load({
  id: 'dsh-bili-ghost',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');

    const NS = 'dsh-bili-ghost';
    const FEED_ROUTE = '/__bili-ghost/feed';
    const ARM_DELAY_MS = 1200;
    // The slot layer sits at z-index 20; 50 keeps this card above app chrome
    // while still losing to modal scrims and the context menu (1000+).
    const Z_INDEX = 50;
    const POSITION_KEY = 'dsh-bili-ghost:window-position';
    const EDGE = 20;
    // The task-progress pill occupies bottom: 96px on the same edge.
    const DEFAULT_BOTTOM = 140;
    const CARD_WIDTH = 380;
    const SAFE = 8;

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function readStoredPosition() {
      try {
        const raw =
          typeof window !== 'undefined' && window.localStorage
            ? window.localStorage.getItem(POSITION_KEY)
            : null;
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          return { x: parsed.x, y: parsed.y };
        }
      } catch {
        /* ignore unreadable storage */
      }
      return null;
    }

    const DICTS = {
      zh: {
        'overlay.label': '鬼畜陪伴',
        'window.title': '今日鬼畜',
        'window.badgeToday': '今日优质',
        'window.badgeLatest': '最新投稿',
        'window.badgeCurated': '编辑部精选',
        'window.loading': '正在挑选今天的鬼畜…',
        'window.empty': '今天暂时没挑到鬼畜，晚点再来看看。',
        'window.error': '取不到片单：{message}',
        'window.errorUpstream': 'B 站接口暂时不可用，稍后再试。',
        'window.retry': '重试',
        'window.next': '换一个',
        'window.open': '在 B 站打开',
        'window.pause': '停止播放',
        'window.play': '重新播放',
        'window.dismiss': '暂时收起',
        'window.reopen': '继续鬼畜',
        'window.drag': '拖动窗口',
        'window.footer': 'AI 干活时播放，收工自动关',
        'window.views': '{n} 播放',
        'window.likes': '{n} 赞',
        'window.stale': '网络不稳，显示的是缓存片单',
        'window.sourceWeekly': '每周必看',
        'window.sourcePrecious': '入站必看',
        'window.sourceToday': '今日鬼畜',
        'window.iframeTitle': '哔哩哔哩播放器',
      },
      en: {
        'overlay.label': 'Bilibili ghost',
        'window.title': "Today's remixes",
        'window.badgeToday': 'Top today',
        'window.badgeLatest': 'Latest uploads',
        'window.badgeCurated': "Editor's picks",
        'window.loading': "Picking today's remixes…",
        'window.empty': 'No remixes picked for today yet — check back later.',
        'window.error': 'Could not load the playlist: {message}',
        'window.errorUpstream': 'Bilibili is unreachable right now. Try again shortly.',
        'window.retry': 'Retry',
        'window.next': 'Next',
        'window.open': 'Open on Bilibili',
        'window.pause': 'Stop playback',
        'window.play': 'Play again',
        'window.dismiss': 'Hide for now',
        'window.reopen': 'Show remixes',
        'window.drag': 'Drag window',
        'window.footer': 'Plays while the AI works; closes when it stops',
        'window.views': '{n} views',
        'window.likes': '{n} likes',
        'window.stale': 'Network hiccup — showing the cached playlist',
        'window.sourceWeekly': 'Weekly picks',
        'window.sourcePrecious': 'Must-watch',
        'window.sourceToday': "Today's remixes",
        'window.iframeTitle': 'Bilibili player',
      },
    };

    let compactNumber = null;
    function formatCount(value) {
      const n = Number(value) || 0;
      try {
        compactNumber =
          compactNumber ||
          new Intl.NumberFormat(undefined, {
            notation: 'compact',
            maximumFractionDigits: 1,
          });
        return compactNumber.format(n);
      } catch {
        return String(n);
      }
    }

    // Selectors return primitives on purpose: a `state` selector would re-render
    // the whole portal subtree on every streaming update.
    function sessionKeyOf(state) {
      const rows = state && state.byId;
      if (!rows || typeof rows !== 'object') return '0:';
      const ids = Object.keys(rows);
      if (ids.length === 0) return '0:';
      // Only a session pinned to the main view counts: background and subagent
      // sessions must never start audio on the settings screen.
      let runningId = '';
      for (const id of ids) {
        const row = rows[id];
        if (!row) continue;
        const pinned = row.retainedBy && row.retainedBy.mainView;
        if (pinned > 0 && row.running) {
          runningId = id;
          break;
        }
      }
      return `${ids.length}:${runningId}`;
    }

    function statusKeyOf(statuses) {
      let runningId = '';
      if (statuses && typeof statuses.forEach === 'function') {
        statuses.forEach((entry, id) => {
          if (!runningId && entry && entry.running) runningId = id;
        });
      }
      return runningId;
    }

    function useSessionRunning(useSessions, useSessionStatus) {
      const sessionKey = useSessions(sessionKeyOf);
      const fallbackId = useSessionStatus(statusKeyOf);
      return React.useMemo(() => {
        const [count, pinnedId] = String(sessionKey).split(':');
        // Sessions exist but none is pinned to the main view: stay silent.
        if (Number(count) > 0) return pinnedId || '';
        // First paint before the session store hydrates: best-effort fallback.
        return fallbackId || '';
      }, [sessionKey, fallbackId]);
    }

    const textStyle = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };

    const buttonStyle = {
      appearance: 'none',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: '20px',
      padding: '4px 10px',
      borderRadius: 999,
      cursor: 'pointer',
    };

    function GhostWindow(props) {
      const { t, useSessions, useSessionStatus } = props;
      const runningKey = useSessionRunning(useSessions, useSessionStatus);
      const running = Boolean(runningKey);

      const [armed, setArmed] = React.useState(false);
      const [dismissed, setDismissed] = React.useState(false);
      const [feed, setFeed] = React.useState(null);
      const [index, setIndex] = React.useState(0);
      const [status, setStatus] = React.useState('loading');
      const [error, setError] = React.useState('');
      const [stale, setStale] = React.useState(false);
      const [paused, setPaused] = React.useState(false);
      const [attempt, setAttempt] = React.useState(0);
      const [position, setPosition] = React.useState(() =>
        typeof window === 'undefined' ? null : readStoredPosition(),
      );
      const [dragging, setDragging] = React.useState(false);
      const sectionRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const positionRef = React.useRef(position);
      positionRef.current = position;
      const visible = running && armed && !dismissed;

      React.useEffect(() => {
        if (!position || dragging) return undefined;
        try {
          window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
        } catch {
          /* storage can be unavailable in private contexts */
        }
        return undefined;
      }, [position, dragging]);

      React.useEffect(() => {
        if (!visible) return undefined;
        const clampToViewport = () => {
          const current = positionRef.current;
          if (!current) return;
          const width = Math.min(CARD_WIDTH, Math.max(220, window.innerWidth - EDGE * 2));
          const height = sectionRef.current
            ? sectionRef.current.getBoundingClientRect().height
            : 0;
          const next = {
            x: clamp(current.x, SAFE, Math.max(SAFE, window.innerWidth - width - SAFE)),
            // Until the card has been measured, clamping y would pin its top
            // edge to the bottom of the viewport.
            y:
              height > 0
                ? clamp(current.y, SAFE, Math.max(SAFE, window.innerHeight - height - SAFE))
                : current.y,
          };
          if (next.x !== current.x || next.y !== current.y) setPosition(next);
        };
        clampToViewport();
        window.addEventListener('resize', clampToViewport);
        return () => window.removeEventListener('resize', clampToViewport);
      }, [visible]);

      const beginDrag = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const target = event.target;
        if (
          target &&
          typeof target.closest === 'function' &&
          target.closest('button, a, input, textarea')
        ) {
          return;
        }
        const element = sectionRef.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: rect.left,
          originY: rect.top,
          width: rect.width,
          height: rect.height,
        };
        setPosition({ x: rect.left, y: rect.top });
        setDragging(true);
        if (event.currentTarget && event.currentTarget.setPointerCapture) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* capture is best-effort */
          }
        }
        event.preventDefault();
      };

      const moveDrag = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (typeof event.buttons === 'number' && event.buttons === 0) {
          endDrag(event);
          return;
        }
        const maxX = Math.max(SAFE, window.innerWidth - drag.width - SAFE);
        const maxY = Math.max(SAFE, window.innerHeight - drag.height - SAFE);
        setPosition({
          x: clamp(drag.originX + event.clientX - drag.startX, SAFE, maxX),
          y: clamp(drag.originY + event.clientY - drag.startY, SAFE, maxY),
        });
      };

      const endDrag = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (event && event.pointerId !== undefined && drag.pointerId !== event.pointerId) {
          return;
        }
        dragRef.current = null;
        setDragging(false);
        if (event && event.currentTarget && event.currentTarget.releasePointerCapture) {
          try {
            event.currentTarget.releasePointerCapture(drag.pointerId);
          } catch {
            /* capture may already be gone */
          }
        }
      };

      React.useEffect(() => {
        if (!running) {
          setArmed(false);
          setDismissed(false);
          return undefined;
        }
        if (armed) return undefined;
        const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
        return () => clearTimeout(timer);
      }, [running, armed]);

      // A new run starts from a clean slate: the previous run's playlist must
      // never flash (or autoplay) before this run's feed arrives. Keyed on the
      // session id so a run that hands over without an idle render still resets.
      React.useEffect(() => {
        if (!runningKey) return undefined;
        setFeed(null);
        setIndex(0);
        setStatus('loading');
        setError('');
        setStale(false);
        setPaused(false);
        return undefined;
      }, [runningKey]);

      React.useEffect(() => {
        if (!visible) return undefined;
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.key !== 'Escape') return;
          const target = event.target;
          if (
            target &&
            typeof target.closest === 'function' &&
            target.closest('input, textarea, select, [contenteditable="true"]')
          ) {
            return;
          }
          setDismissed(true);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [visible]);

      React.useEffect(() => {
        if (!visible) return undefined;
        let cancelled = false;
        const controller = new AbortController();
        setStatus('loading');
        setError('');
        setStale(false);

        fetch(FEED_ROUTE, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        })
          .then((response) =>
            response
              .json()
              .catch(() => null)
              .then((body) => ({ ok: response.ok, status: response.status, body })),
          )
          .then(({ ok, status, body }) => {
            if (cancelled) return;
            if (!ok) {
              const code = (body && body.error) || `HTTP ${status}`;
              throw new Error(code);
            }
            if (!body) throw new Error('bad_response');
            const videos = Array.isArray(body.videos) ? body.videos : [];
            setFeed(body);
            setIndex(0);
            setStale(Boolean(body.stale));
            // An empty playlist is a valid (calm) answer, not a failure.
            setStatus('ready');
            if (videos.length === 0) setError('');
          })
          .catch((reason) => {
            if (cancelled || (reason && reason.name === 'AbortError')) return;
            const code = String((reason && reason.message) || reason);
            setFeed(null);
            setError(
              code === 'upstream_unavailable' || code === 'bad_response'
                ? t('window.errorUpstream')
                : code,
            );
            setStatus('error');
          });

        return () => {
          cancelled = true;
          controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [visible, attempt, runningKey]);

      if (!running || typeof document === 'undefined') return null;

      if (!visible) {
        if (!armed) return null;
        const reopen = React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setDismissed(false),
            title: t('window.reopen'),
            style: {
              position: 'fixed',
              right: 20,
              bottom: 20,
              zIndex: Z_INDEX,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 14px',
              borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
              background: 'var(--dsw-alias-bg-layer-2, #fff)',
              color: 'var(--dsw-alias-label-primary, #1a1a1a)',
              boxShadow: '0 10px 30px rgba(0,0,0,0.24)',
              font: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
              pointerEvents: 'auto',
            },
          },
          React.createElement('span', { 'aria-hidden': true }, '👻'),
          t('window.reopen'),
        );
        return createPortal(reopen, document.body);
      }

      const videos = feed && Array.isArray(feed.videos) ? feed.videos : [];
      const video = videos.length > 0 ? videos[index % videos.length] : null;
      const scopeKey =
        feed && feed.scope === 'latest'
          ? 'window.badgeLatest'
          : feed && feed.scope === 'today'
            ? 'window.badgeToday'
            : 'window.badgeCurated';
      const playerSrc =
        video && video.bvid
          ? `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(
              video.bvid,
            )}&autoplay=${paused ? 0 : 1}&high_quality=1&danmaku=1&as_wide=1`
          : null;
      const sourceKey =
        video && video.source === 'weekly'
          ? 'window.sourceWeekly'
          : video && video.source === 'precious'
            ? 'window.sourcePrecious'
            : 'window.sourceToday';

      const close = () =>
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setDismissed(true),
            'aria-label': t('window.dismiss'),
            title: t('window.dismiss'),
            style: {
              ...buttonStyle,
              border: 'none',
              padding: '2px 6px',
              fontSize: 16,
              lineHeight: '20px',
              color: 'var(--dsw-alias-label-secondary, #666)',
            },
          },
          '✕',
        );

      const header = React.createElement(
        'div',
        {
          title: t('window.drag'),
          onPointerDown: beginDrag,
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onLostPointerCapture: endDrag,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          },
        },
        React.createElement('span', { 'aria-hidden': true, style: { fontSize: 15 } }, '👻'),
        React.createElement(
          'strong',
          {
            style: {
              fontSize: 13,
              fontWeight: 600,
              ...textStyle,
              minWidth: 0,
              flex: '0 1 auto',
            },
          },
          t('window.title'),
        ),
        React.createElement(
          'span',
          {
            style: {
              fontSize: 11,
              lineHeight: '16px',
              padding: '1px 7px',
              borderRadius: 999,
              color: 'var(--dsw-alias-brand-primary, #fb7299)',
              border: '1px solid var(--dsw-alias-brand-primary, #fb7299)',
              whiteSpace: 'nowrap',
            },
          },
          t(scopeKey),
        ),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement(
          'span',
          {
            'aria-hidden': true,
            title: t('window.drag'),
            style: {
              fontSize: 14,
              lineHeight: 1,
              letterSpacing: 1,
              color: 'var(--dsw-alias-label-tertiary, #999)',
              cursor: dragging ? 'grabbing' : 'grab',
            },
          },
          '⠿',
        ),
        close,
      );

      let body;
      if (status === 'loading' && !video) {
        body = React.createElement(
          'div',
          {
            style: {
              padding: '28px 16px',
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary, #666)',
            },
          },
          t('window.loading'),
        );
      } else if (status === 'error' && !video) {
        body = React.createElement(
          'div',
          { style: { padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 10 } },
          React.createElement(
            'div',
            { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d1453b)', lineHeight: 1.5 } },
            t('window.error', { message: error || '?' }),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => setAttempt((n) => n + 1),
              style: { ...buttonStyle, alignSelf: 'flex-start' },
            },
            t('window.retry'),
          ),
        );
      } else if (video && playerSrc) {
        body = React.createElement(
          'div',
          { style: { position: 'relative', background: '#000', aspectRatio: '16 / 9', width: '100%' } },
          React.createElement('iframe', {
            key: `${video.bvid}:${paused ? 'paused' : 'playing'}`,
            src: playerSrc,
            title: `${t('window.iframeTitle')} · ${video.title}`,
            allow: 'autoplay; fullscreen; picture-in-picture',
            allowFullScreen: true,
            frameBorder: '0',
            scrolling: 'no',
            referrerPolicy: 'no-referrer-when-downgrade',
            style: {
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              border: 'none',
            },
          }),
        );
      } else {
        body = React.createElement(
          'div',
          {
            style: {
              padding: '28px 16px',
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary, #666)',
            },
          },
          t('window.empty'),
        );
      }

      const stats = video && video.stats ? video.stats : null;
      const meta = !video
        ? null
        : React.createElement(
            'div',
            {
              style: {
                padding: '10px 12px 4px',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
              },
            },
            React.createElement(
              'div',
              {
                style: {
                  fontSize: 12,
                  fontWeight: 500,
                  ...textStyle,
                },
                title: video.title,
              },
              video.title,
            ),
            React.createElement(
              'div',
              {
                style: {
                  fontSize: 11,
                  color: 'var(--dsw-alias-label-secondary, #666)',
                  ...textStyle,
                },
              },
              [
                t(sourceKey),
                video.author || '',
                stats ? t('window.views', { n: formatCount(stats.view) }) : '',
                stats && stats.like > 0 ? t('window.likes', { n: formatCount(stats.like) }) : '',
              ]
                .filter(Boolean)
                .join(' · '),
            ),
          );

      const actions = !video
        ? null
        : React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px 10px',
          },
        },
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setPaused((current) => !current),
            'aria-pressed': paused,
            title: paused ? t('window.play') : t('window.pause'),
            style: buttonStyle,
          },
          paused ? t('window.play') : t('window.pause'),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => {
              setPaused(false);
              setIndex((current) => (videos.length > 0 ? (current + 1) % videos.length : 0));
            },
            disabled: videos.length < 2,
            style: { ...buttonStyle, opacity: videos.length < 2 ? 0.5 : 1 },
          },
          t('window.next'),
        ),
        React.createElement(
          'a',
          {
            href: video ? video.url : undefined,
            target: '_blank',
            rel: 'noreferrer noopener',
            tabIndex: video ? 0 : -1,
            'aria-disabled': video ? undefined : true,
            style: {
              ...buttonStyle,
              textDecoration: 'none',
              color: 'var(--dsw-alias-label-primary, #1a1a1a)',
              pointerEvents: video ? 'auto' : 'none',
              opacity: video ? 1 : 0.5,
            },
          },
          t('window.open'),
        ),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement(
          'span',
          {
            style: {
              fontSize: 10,
              color: 'var(--dsw-alias-label-tertiary, #999)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 170,
            },
          },
          video && stale ? t('window.stale') : t('window.footer'),
        ),
      );

      const liveText =
        !video && status === 'loading'
          ? t('window.loading')
          : !video && status === 'error'
            ? t('window.error', { message: error || '?' })
            : !video && status === 'ready'
              ? t('window.empty')
              : '';
      const liveRegion = React.createElement(
        'span',
        {
          role: 'status',
          'aria-live': 'polite',
          style: {
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          },
        },
        liveText,
      );

      const windowNode = React.createElement(
        'section',
        {
          ref: sectionRef,
          role: 'region',
          'aria-label': t('window.title'),
          style: {
            position: 'fixed',
            zIndex: Z_INDEX,
            left: position ? position.x : undefined,
            top: position ? position.y : undefined,
            right: position ? undefined : EDGE,
            bottom: position ? undefined : DEFAULT_BOTTOM,
            width: `min(${CARD_WIDTH}px, calc(100vw - ${EDGE * 2}px))`,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 14,
            overflow: 'hidden',
            background: 'var(--dsw-alias-bg-layer-2, #fff)',
            color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
            boxShadow: dragging
              ? '0 24px 60px rgba(0,0,0,0.34)'
              : '0 18px 50px rgba(0,0,0,0.28)',
            fontFamily:
              '"PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, -apple-system, sans-serif',
            fontSize: 13,
            lineHeight: 1.45,
            textAlign: 'left',
            pointerEvents: 'auto',
          },
        },
        liveRegion,
        header,
        body,
        meta,
        actions,
      );

      return createPortal(windowNode, document.body);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);

        ctx.effect(
          () => ctx.locale.register(NS, DICTS),
          'bili-ghost: dictionaries',
        );

        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'bili-ghost',
                  order: 240,
                  label: () => t('overlay.label'),
                },
                (props) => React.createElement(GhostWindow, { ...props, t }),
              ),
            ),
          'bili-ghost: floating remix window',
        );
      },
    };
  },
});
