/**
 * 浏览器侧插件入口：向「设置 → 插件」贡献千问办公状态卡片。
 *
 * 格式要求（与 DSH 0.1.2-rc.1 的 client 模块加载器一致）：
 * 本文件不是 ESM 模块，而是 `window.__ModuleLoader__.load({ id, factory })`
 * 的自执行包装，末尾导出 `apply` / `inject` / `name`。
 *
 * 整段 `apply` 被 try/catch 包裹：DSH 的 slot API 一旦发生破坏性变更，
 * 这里退化为一条 console.error，而**不会**抛进 DSH loader 触发红色
 * "Failed to load plugins" 横幅——host 侧 provider 与状态路由都不受影响。
 */

window.__ModuleLoader__.load({
  id: 'dsh-qwen-connect',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react = require('react');
    let react_jsx_runtime = require('react/jsx-runtime');

    //#region status-paths.ts
    /** 与 lib/status-paths.js 保持一致（client 半无法 import host 模块）。 */
    const QWENWORK_STATUS_PATH = '/plugins/dsh-qwen-connect/status';
    const POLL_INTERVAL_MS = 60000;
    //#endregion

    //#region 样式
    const cardStyle = {
      overflow: 'hidden',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-module-platform)',
    };
    const headerStyle = {
      boxSizing: 'border-box',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      border: 0,
      padding: '13px 14px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    };
    const headTextStyle = {
      display: 'flex',
      minWidth: 0,
      flexDirection: 'column',
      gap: 3,
    };
    const nameStyle = { fontSize: 14, lineHeight: '20px', fontWeight: 600 };
    const descriptionStyle = {
      fontSize: 13,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    };
    const chevronStyle = {
      flex: '0 0 auto',
      fontSize: 18,
      lineHeight: 1,
      transition: 'transform 120ms ease',
    };
    const bodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      borderTop: '1px solid var(--dsw-alias-border-l2)',
      padding: '13px 14px',
    };
    // ---- 配置表单样式 ---------------------------------------------------
    const formSectionStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    };
    const formSectionTitleStyle = {
      margin: 0,
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    };
    const formRowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      fontSize: 13,
      lineHeight: '20px',
    };
    const formLevelsStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      paddingLeft: 12,
      borderLeft: '1px solid var(--dsw-alias-border-l2)',
    };
    const formHintStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    };
    const formInputStyle = {
      flex: '0 1 260px',
      boxSizing: 'border-box',
      height: 32,
      padding: '0 10px',
      border: '1px solid var(--dsw-alias-border-l3)',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
    };
    const rowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13,
      lineHeight: '18px',
    };
    const labelStyle = { color: 'var(--dsw-alias-label-tertiary)' };
    const valueStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontVariantNumeric: 'tabular-nums',
      textAlign: 'right',
    };
    const errorStyle = {
      fontSize: 13,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'pre-wrap',
    };
    const modelRowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13,
      lineHeight: '18px',
    };
    // ---- WorkBuddy 风格的分组 / 进度条样式 --------------------------------
    const sectionStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
      paddingTop: 2,
    };
    const quotaGroupStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    };
    const sectionTitleStyle = {
      margin: 0,
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    };
    const quotaLabelStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
    };
    const progressTrackStyle = {
      height: 8,
      overflow: 'hidden',
      borderRadius: 999,
      background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))',
    };
    function progressFillStyle(percent) {
      return {
        width: `${Math.max(0, Math.min(100, percent))}%`,
        height: '100%',
        borderRadius: 'inherit',
        background: 'var(--dsw-alias-brand-primary, #1677ff)',
      };
    }
    /** 已登录状态圆点（与 WorkBuddy 卡片一致）。 */
    function dotStyle(status) {
      return {
        width: 9,
        height: 9,
        borderRadius: '50%',
        flex: '0 0 auto',
        background:
          status === 'signed-in'
            ? 'var(--dsw-alias-state-success-primary, #22a06b)'
            : status === 'error'
              ? 'var(--dsw-alias-state-error-primary, #d92d20)'
              : 'var(--dsw-alias-label-dimmed, #9aa0a6)',
      };
    }
    const accountRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    };
    const refreshButtonStyle = {
      flex: '0 0 auto',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8,
      padding: '5px 12px',
      background: 'var(--dsw-alias-bg-module-platform)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    };
    /** 千分位格式化（积分 / 请求数等）。 */
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    }
    function formatPercent(value) {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
    }
    //#endregion

    /** 展示用的行。 */
    function Row(props) {
      return react_jsx_runtime.jsxs('div', {
        style: rowStyle,
        children: [
          react_jsx_runtime.jsx('span', { style: labelStyle, children: props.label }),
          react_jsx_runtime.jsx('span', { style: valueStyle, children: props.value }),
        ],
      });
    }

    /**
     * 单条配额：有 `remain` + `size` 时画进度条，否则只显示文本。
     *
     * 进度条语义是「剩余百分比」（与 WorkBuddy 卡片一致）。
     */
    function QuotaBar(props) {
      const item = props.item;
      const t = props.t;
      // 防御：客户端不得假设 host 数据完美——网络中断、版本不一致都可能让
      // 条目变成 null / 非对象。此处返回 null 而非抛异常，避免整个卡片白屏
      // （React 错误未被捕获时，DSH 会显示"加载失败"，用户彻底看不到卡片）。
      if (item === null || typeof item !== 'object') return null;
      const hasBar =
        typeof item.remain === 'number' && typeof item.size === 'number' && item.size > 0;
      const percent = hasBar ? (item.remain / item.size) * 100 : null;
      // `item.size` 可能来自「参考基准」而非上游真实总量——此时右侧文案
      // 不能写「剩余 X%」（会让人误以为那是剩余比例），改为「较峰值 X%」。
      const isBaseline = item.baselineBased === true;

      // 右侧文字：有进度条时显示百分比，否则显示额度本身
      let right;
      if (hasBar) {
        right = isBaseline
          ? t('peakLevel', { percent: formatPercent(percent) })
          : t('percentRemaining', { percent: formatPercent(percent) });
      } else if (item.detail !== undefined) {
        right = item.detail;
      } else if (typeof item.size === 'number') {
        right = t('quotaAmount', { value: formatNumber(item.size), unit: t(item.unit ?? 'count') });
      } else {
        right = '';
      }

      // 左侧主标签
      const label = t(item.key);

      const children = [
        react_jsx_runtime.jsxs(
          'div',
          {
            style: quotaLabelStyle,
            children: [
              react_jsx_runtime.jsx('span', { children: label }),
              react_jsx_runtime.jsx('span', {
                style: { fontVariantNumeric: 'tabular-nums' },
                children: right,
              }),
            ],
          },
          'label',
        ),
      ];

      if (hasBar) {
        children.push(
          react_jsx_runtime.jsx(
            'div',
            {
              style: progressTrackStyle,
              role: 'progressbar',
              'aria-label': label,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': Math.round(percent),
              children: react_jsx_runtime.jsx('div', { style: progressFillStyle(percent) }),
            },
            'track',
          ),
        );
        // 精确值一行（对齐 WorkBuddy 的 "剩余 500 / 500"）。
        // 基准模式下**不显示**——那不是真实配额，写出来就是编造。
        if (!isBaseline) {
          children.push(
            react_jsx_runtime.jsx(
              'div',
              {
                style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                children: t('exactRemaining', {
                  remain: formatNumber(item.remain),
                  size: formatNumber(item.size),
                }),
              },
              'exact',
            ),
          );
        } else {
          // 基准模式：只把余额本身写清楚（这是真实值），不写分母。
          children.push(
            react_jsx_runtime.jsx(
              'div',
              {
                style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                children: t('creditBalance', { value: formatNumber(item.remain) }),
              },
              'balance',
            ),
          );
        }
      } else if (typeof item.size === 'number') {
        children.push(
          react_jsx_runtime.jsx(
            'div',
            {
              style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
              children: t('quotaLimit', { value: formatNumber(item.size), unit: t(item.unit ?? 'count') }),
            },
            'limit',
          ),
        );
      }

      return react_jsx_runtime.jsx('div', { style: quotaGroupStyle, children }, props.id);
    }

    /** 一个模型条目：名称 + 倍率。 */
    function ModelRow(props) {
      const model = props.model;
      const t = props.t;
      // 同 QuotaBar：数据异常时返回 null，不让整张卡片白屏。
      if (model === null || typeof model !== 'object') return null;
      const badges = [];
      if (model.isDefault === true) badges.push(t('badgeDefault'));
      if (model.isRecommended === true) badges.push(t('badgeRecommended'));
      if (model.isNew === true) badges.push(t('badgeNew'));

      return react_jsx_runtime.jsxs(
        'div',
        {
          style: { display: 'flex', flexDirection: 'column', gap: 2 },
          children: [
            react_jsx_runtime.jsxs(
              'div',
              {
                style: modelRowStyle,
                children: [
                  react_jsx_runtime.jsx('span', {
                    style: { color: 'var(--dsw-alias-label-secondary)' },
                    children: model.name,
                  }),
                  react_jsx_runtime.jsx('span', {
                    style: {
                      ...valueStyle,
                      color: 'var(--dsw-alias-label-tertiary)',
                      fontSize: 12,
                    },
                    children: model.rate === undefined ? '' : `${model.rate}x`,
                  }),
                ],
              },
              'row',
            ),
            badges.length === 0
              ? null
              : react_jsx_runtime.jsx(
                  'div',
                  {
                    style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
                    children: badges.map((label) =>
                      react_jsx_runtime.jsx(
                        'span',
                        {
                          style: {
                            padding: '1px 8px',
                            borderRadius: 999,
                            fontSize: 11,
                            lineHeight: '18px',
                            background:
                              'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
                            color: 'var(--dsw-alias-state-success-primary, #22a06b)',
                          },
                          children: label,
                        },
                        label,
                      ),
                    ),
                  },
                  'badges',
                ),
          ],
        },
        `model-${model.id}`,
      );
    }

    /** 把 host 返回的状态文档渲染成卡片的展开区（WorkBuddy 风格）。 */
    function StatusBody(props) {
      const state = props.state;
      const t = props.t;

      if (state === null) {
        return react_jsx_runtime.jsx('div', { style: errorStyle, children: t('loading') });
      }
      if (state.error !== undefined && state.status !== 'signed-in') {
        const err = state.error;
        const text = [err.message, err.recovery].filter(Boolean).join('\n');
        return react_jsx_runtime.jsx('div', { style: errorStyle, children: text });
      }

      const sections = [];

      // ---- 账号 ----
      const accountRows = [];
      accountRows.push(
        react_jsx_runtime.jsxs(
          'div',
          {
            style: accountRowStyle,
            children: [
              react_jsx_runtime.jsx('span', { style: dotStyle('signed-in') }),
              react_jsx_runtime.jsx('span', {
                children: t('signedInAs', { name: state.nickname ?? state.account ?? '—' }),
              }),
            ],
          },
          'who',
        ),
      );
      // 账号区**只保留一行**「已登录：<名字>」。
      //
      // 移除的三行（用户明确要求精简）：
      //   · 登录标识（用户名）—— 与上一行信息重叠
      //   · 套餐（Free）—— 卡片副标题已有
      //   · 下次到期 —— Free 套餐该字段为 null，从不显示
      sections.push(
        react_jsx_runtime.jsxs(
          'div',
          {
            style: sectionStyle,
            children: [
              react_jsx_runtime.jsx('h3', { style: sectionTitleStyle, children: t('accountHeading') }, 'title'),
              ...accountRows,
            ],
          },
          'section-account',
        ),
      );

      // ---- 额度：只保留「积分」一行（带进度条）----
      const quotaChildren = [];
      //
      // 设计取舍：卡片只展示**账号 + 积分**。此前的「会话数 / 存储空间 /
      // 页面额度 / 月度请求 / 月度流量」是套餐权益上限，对日常使用没有参考
      // 价值，反而淹没真正关心的积分余额（用户明确要求精简）。
      //
      // 进度条语义：上游对 Free 套餐**只给 remaining、不给 total**
      // （实测 `quota.total === null`），因此没有真实分母。此时进度条按
      // **额度基准**（`state.creditBaseline`）画剩余比例，并在文案上标明
      // 是「相对基准」而非「总量」——绝不假装那是真实总量。
      const credits = Array.isArray(state.entitlements)
        ? state.entitlements.find((e) => e !== null && typeof e === 'object' && e.key === 'credits')
        : undefined;
      const remaining =
        typeof state.remaining === 'number'
          ? state.remaining
          : typeof credits?.remain === 'number'
            ? credits.remain
            : undefined;

      if (remaining !== undefined) {
        const hasRealTotal = typeof credits?.size === 'number' && credits.size > 0;
        const baseline = hasRealTotal
          ? credits.size
          : typeof state.creditBaseline === 'number' && state.creditBaseline > 0
            ? state.creditBaseline
            : undefined;
        quotaChildren.push(
          react_jsx_runtime.jsx(
            QuotaBar,
            {
              item: {
                key: 'credits',
                label: t('credits'),
                remain: remaining,
                ...(baseline === undefined ? {} : { size: baseline }),
                // 标记分母来源：真实总量 or 参考基准（文案与精确值行随之变化）
                ...(hasRealTotal ? {} : { baselineBased: true }),
                unit: 'credits',
              },
              t,
              id: 'credits-0',
            },
            'credits-0',
          ),
        );
        sections.push(
          react_jsx_runtime.jsx(
            'div',
            { style: sectionStyle, children: quotaChildren },
            'section-quota',
          ),
        );
      }

      // ---- 上游性能（首 token 延迟 / 输出速率）----
      //
      // 数据来自 shim 的实测采样（最近 20 次成功对话的均值）。**没有样本时
      // 整块不渲染**——显示 0 或 "—" 都会让人误以为是实测值。
      //
      // 这张卡片的用途：用户能直观看到「当前上游到底多快」，从而判断是该
      // 换模型（flash 更便宜也常更快）还是上游当前拥堵。
      const perf = state.perf;
      if (perf !== null && typeof perf === 'object') {
        const perfRows = [];
        if (typeof perf.ttftMs === 'number') {
          perfRows.push(
            react_jsx_runtime.jsxs(
              'div',
              {
                style: rowStyle,
                children: [
                  react_jsx_runtime.jsx('span', { style: labelStyle, children: t('ttft') }),
                  react_jsx_runtime.jsx('span', { style: valueStyle, children: t('ms', { value: formatNumber(perf.ttftMs) }) }),
                ],
              },
              'ttft',
            ),
          );
        }
        if (typeof perf.charsPerSec === 'number') {
          perfRows.push(
            react_jsx_runtime.jsxs(
              'div',
              {
                style: rowStyle,
                children: [
                  react_jsx_runtime.jsx('span', { style: labelStyle, children: t('speed') }),
                  react_jsx_runtime.jsx('span', { style: valueStyle, children: t('charsPerSec', { value: formatNumber(perf.charsPerSec) }) }),
                ],
              },
              'speed',
            ),
          );
        }
        if (perfRows.length > 0) {
          perfRows.push(
            react_jsx_runtime.jsx(
              'div',
              {
                style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
                children: t('perfSampleNote', { count: perf.samples ?? 0 }),
              },
              'note',
            ),
          );
          sections.push(
            react_jsx_runtime.jsxs(
              'div',
              {
                style: sectionStyle,
                children: [
                  react_jsx_runtime.jsx('h3', { style: sectionTitleStyle, children: t('perfHeading') }, 'title'),
                  ...perfRows,
                ],
              },
              'section-perf',
            ),
          );
        }
      }

      // ---- 模型 ----
      if (Array.isArray(state.models) && state.models.length > 0) {
        sections.push(
          react_jsx_runtime.jsxs(
            'div',
            {
              style: sectionStyle,
              children: [
                react_jsx_runtime.jsx('h3', { style: sectionTitleStyle, children: t('models') }, 'title'),
                // `model.id` 在构造 key 时被读取，null 项会在此抛异常 → 先过滤。
                ...state.models
                  .filter((model) => model !== null && typeof model === 'object')
                  .map((model, index) =>
                    react_jsx_runtime.jsx(
                      ModelRow,
                      { model, t },
                      `model-${typeof model.id === 'string' && model.id !== '' ? model.id : index}`,
                    ),
                  ),
              ],
            },
            'section-models',
          ),
        );
      }

      return react_jsx_runtime.jsx('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 18 },
        children: sections,
      });
    }

    /** 千问办公状态卡片。 */
    function QwenWorkPluginCard(props) {
      const t = props.t;
      const [open, setOpen] = react.useState(props.initialOpen === true);
      // `initialState` 仅供离屏渲染检查（tools/client-render-check.mjs）注入用；
      // DSH 运行时不会传该属性，行为与 useState(null) 完全一致。
      const [state, setState] = react.useState(props.initialState ?? null);
      const [busy, setBusy] = react.useState(false);
      const [nonce, setNonce] = react.useState(0);

      react.useEffect(() => {
        let cancelled = false;
        let timer = undefined;

        async function load() {
          try {
            const response = await fetch(QWENWORK_STATUS_PATH, {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            });
            if (!response.ok) {
              throw new Error(`${t('requestFailed')} (HTTP ${response.status})`);
            }
            const body = await response.json();
            if (!cancelled) setState(body);
          } catch (error) {
            if (!cancelled) {
              setState({
                status: 'unavailable',
                error: {
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            }
          }
        }

        if (open) {
          load();
          timer = setInterval(load, POLL_INTERVAL_MS);
        }
        return () => {
          cancelled = true;
          if (timer !== undefined) clearInterval(timer);
        };
      }, [open, t, nonce]);

      const signedIn = state !== null && state.status === 'signed-in';
      const subtitle = signedIn
        ? state.remaining === undefined
          ? t('signedIn')
          : `${t('signedIn')} · ${t('credits')} ${state.remaining}`
        : t('subtitle');

      return react_jsx_runtime.jsxs('div', {
        style: cardStyle,
        children: [
          react_jsx_runtime.jsxs('button', {
            type: 'button',
            style: headerStyle,
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
            children: [
              react_jsx_runtime.jsxs('span', {
                style: headTextStyle,
                children: [
                  react_jsx_runtime.jsx('span', { style: nameStyle, children: t('title') }),
                  react_jsx_runtime.jsx('span', { style: descriptionStyle, children: subtitle }),
                ],
              }),
              react_jsx_runtime.jsx('span', {
                style: { ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' },
                children: '\u2304',
              }),
            ],
          }),
          open
            ? react_jsx_runtime.jsxs('div', {
                style: bodyStyle,
                children: [
                  react_jsx_runtime.jsxs('div', {
                    style: {
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 16,
                    },
                    children: [
                      react_jsx_runtime.jsx('div', {
                        style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                        children: signedIn ? t('signedIn') : t('subtitle'),
                      }),
                      react_jsx_runtime.jsx('button', {
                        type: 'button',
                        style: refreshButtonStyle,
                        disabled: busy,
                        onClick: () => {
                          setBusy(true);
                          setNonce((v) => v + 1);
                          setTimeout(() => setBusy(false), 800);
                        },
                        children: busy ? t('refreshing') : t('refresh'),
                      }),
                    ],
                  }),
                  react_jsx_runtime.jsx(StatusBody, { state, t }),
                ],
              })
            : null,
        ],
      });
    }

    //#region 文案
    const zh = {
      title: '千问办公',
      subtitle: '复用千问办公桌面 App 登录态',
      signedIn: '已登录',
      signedInAs: '已登录：{name}',
      loading: '正在读取状态…',
      refresh: '刷新',
      refreshing: '刷新中…',
      accountHeading: '账号',
      quotaHeading: '剩余积分',
      nickname: '账号',
      account: '登录标识',
      plan: '套餐',
      nextDue: '下次到期',
      credits: '积分',
      creditsTotal: '合计：{total}',
      used: '已用',
      models: '可选模型',
      // 上游性能
      perfHeading: '上游速度',
      ttft: '首 token 延迟',
      speed: '输出速率',
      ms: '{value} 毫秒',
      charsPerSec: '{value} 字/秒',
      perfSampleNote: '基于最近 {count} 次对话实测',
      requestFailed: '读取插件状态失败',
      // 配额条目
      sessions: '会话数',
      storage: '存储空间',
      pageQuota: '页面额度',
      monthRequests: '月度请求',
      monthTraffic: '月度流量',
      // 单位
      count: '个',
      GB: 'GB',
      // 配额展示
      percentRemaining: '剩余 {percent}%',
      exactRemaining: '剩余 {remain} / {size}',
      // 上游不给总量时的措辞：表达"相对峰值还剩多少"，不假装那是配额剩余
      peakLevel: '较峰值 {percent}%',
      creditBalance: '当前余额 {value}',
      quotaLimit: '上限 {value} {unit}',
      quotaAmount: '{value} {unit}',
      // 模型徽章
      badgeDefault: '默认',
      badgeRecommended: '推荐',
      badgeNew: '新',
      // 输入框积分胶囊（仅在选中千问模型时出现）
      'pill.title': '千问办公剩余积分',
      'pill.credits': '积分',
      // ---- 配置表单 ----
      configThinkingHeading: '思考深度',
      configThinkingHint:
        '这些档位会出现在模型选择器的「思考深度」里。选中后按该档位向上游请求；不选则沿用上游默认档。',
      configThinkingEnabled: '允许模型思考',
      configThinkingEnabledHint: '关闭后一律按「不思考」发出：更快、更省积分，但复杂任务质量会下降。',
      configThinkingLevels: '在模型选择器里提供以下档位',
      configThinkingNoneSelected: '没有选中任何档位——选择器会隐藏思考深度选项，等同不指定。',
      configThinkingOff: '已关闭思考',
      configSummary: '可配置思考深度与模型白名单',
      thinkingLow: '低（low）',
      thinkingLowHint: '最快，适合简单问答。',
      thinkingMedium: '中（medium）',
      thinkingMediumHint: '默认档，速度与质量平衡。',
      thinkingHigh: '高（high）',
      thinkingHighHint: '复杂推理、多步任务。',
      thinkingXhigh: '超高（xhigh）',
      thinkingXhighHint: '更长的思考链，适合难推理。',
      thinkingMax: '最高（max）',
      thinkingMaxHint: '上游支持的极限档，思考链路最长、耗时和积分消耗都最高。',
      configModelsHeading: '模型与显示',
      configAllowedModels: '模型白名单',
      configAllowedModelsHint: '逗号分隔的模型 id。留空表示不限制（显示上游全部模型）。',
      configRefreshOnStart: '启动时拉取上游目录',
      configRefreshOnStartHint: '关闭后只使用内置目录，不再请求上游。',
      configShowCredits: '显示剩余积分',
      configShowCreditsHint: '在输入框右侧显示千问剩余积分。',
      configLoading: '正在读取配置…',
      configUnavailable: '这个配置当前不可用。',
      configSaving: '正在保存…',
      configReadOnly: '当前配置为只读，无法修改。',
      configWriteRefused: '配置没有保存成功（宿主拒绝了这次修改），已恢复为当前生效的值。',
    };
    const en = {
      title: 'QwenWork',
      subtitle: "Reuses the QwenWork desktop app's sign-in",
      signedIn: 'Signed in',
      signedInAs: 'Signed in: {name}',
      loading: 'Reading status…',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      accountHeading: 'Account',
      quotaHeading: 'Remaining credits',
      nickname: 'Account',
      account: 'Identity',
      plan: 'Plan',
      nextDue: 'Next due',
      credits: 'Credits',
      creditsTotal: 'Total: {total}',
      used: 'Used',
      models: 'Available models',
      perfHeading: 'Upstream speed',
      ttft: 'First token',
      speed: 'Output rate',
      ms: '{value} ms',
      charsPerSec: '{value} chars/s',
      perfSampleNote: 'Measured over the last {count} conversations',
      requestFailed: 'Failed to read plugin status',
      sessions: 'Sessions',
      storage: 'Storage',
      pageQuota: 'Page quota',
      monthRequests: 'Monthly requests',
      monthTraffic: 'Monthly traffic',
      count: '',
      GB: 'GB',
      percentRemaining: '{percent}% remaining',
      exactRemaining: '{remain} / {size} remaining',
      peakLevel: 'peak {percent}%',
      creditBalance: 'Current balance {value}',
      quotaLimit: 'Limit {value} {unit}',
      quotaAmount: '{value} {unit}',
      badgeDefault: 'Default',
      badgeRecommended: 'Recommended',
      badgeNew: 'New',
      // 输入框积分胶囊（仅在选中千问模型时出现）
      'pill.title': 'Qwen Work credits remaining',
      'pill.credits': 'Credits',
      // ---- Configuration form ----
      configThinkingHeading: 'Reasoning depth',
      configThinkingHint:
        'These levels appear in the model picker under reasoning depth. Picking one requests that level from upstream; leaving it unset keeps the upstream default.',
      configThinkingEnabled: 'Allow the model to think',
      configThinkingEnabledHint:
        'When off, every request is sent as "do not think": faster and cheaper, but weaker on complex tasks.',
      configThinkingLevels: 'Offer these levels in the model picker',
      configThinkingNoneSelected:
        'No level selected — the picker hides reasoning depth, which is the same as leaving it unspecified.',
      configThinkingOff: 'Thinking is off',
      configSummary: 'Reasoning depth and the model allowlist are configurable',
      thinkingLow: 'Low',
      thinkingLowHint: 'Fastest; fine for simple questions.',
      thinkingMedium: 'Medium',
      thinkingMediumHint: 'Balanced speed and quality.',
      thinkingHigh: 'High',
      thinkingHighHint: 'Complex reasoning and multi-step tasks.',
      thinkingXhigh: 'Extra high',
      thinkingXhighHint: 'Longer reasoning chains for hard problems.',
      thinkingMax: 'Max',
      thinkingMaxHint: 'The longest chain upstream offers; highest latency and credit cost.',
      configModelsHeading: 'Models and display',
      configAllowedModels: 'Model allow-list',
      configAllowedModelsHint:
        'Comma-separated model ids. Leave empty to allow every model upstream offers.',
      configRefreshOnStart: 'Fetch the upstream catalog at startup',
      configRefreshOnStartHint: 'Turn off to use only the built-in catalog.',
      configShowCredits: 'Show remaining credits',
      configShowCreditsHint: 'Show remaining Qwen Work credits next to the composer.',
      configLoading: 'Reading configuration…',
      configUnavailable: 'This configuration is currently unavailable.',
      configSaving: 'Saving…',
      configReadOnly: 'This configuration is read-only.',
      configWriteRefused:
        'The configuration was not saved (the host refused the change); the current value is shown again.',
    };
    //#endregion

    const name = 'dsh-qwen-connect';
    const inject = ['slots', 'locale'];

    /** 本插件注册到 DSH 的 provider 路由 id（与 host 侧 lib/models.js 一致）。 */
    const QWENWORK_PROVIDER_ID = 'qwenwork';

    /** 本插件的包名（含不与包名一致的 `include:` 组合层前缀形态）。 */
    const CONFIG_CARD_BUNDLES = ['dsh-qwen-connect', 'include:dsh-qwen-connect'];
    /**
     * 插件 patch 里声明的行 id（`- insert: [{ id: llm-qwenwork, ... }]`）。
     *
     * 注意它与包名不同——配置页的 key 是 `<包名>#<行 id>`，两个维度都要列。
     */
    const CONFIG_CARD_ROWS = ['llm-qwenwork', 'include:llm-qwenwork'];

    /**
     * 本会话当前指向的 provider 路由。
     *
     * 读 DSH 自己的 `modelSelection` 投影，而不是插件私有状态——投影是
     * Host 折叠出来的权威事实，用户在任何入口切换模型都会更新它。
     * `next` 优先于 `lastUsed`：已经生效但尚未被请求消费的选择，才是
     * 输入框正在显示的那一个。
     *
     * 投影形状见 dsh-api-session-controller/lib/types/types.d.ts：
     *   ModelSelectionProjection = { lastUsed: ModelSelection|null, next: ModelSelection|null }
     *   ModelSelection           = { provider, model, reasoningEffort? }
     */
    function selectedProviderOf(projection) {
      const selection = projection?.next ?? projection?.lastUsed;
      const provider = selection?.provider;
      return typeof provider === 'string' && provider !== '' ? provider : undefined;
    }

    /**
     * 输入框右侧的积分胶囊。
     *
     * **只在当前会话选中千问反代的模型时出现**：其他 provider 的会话里
     * 显示千问积分是误导，而且会白开一个 60 秒轮询循环。因此归属判定
     * 放在最前面，判定不通过连 fetch 都不启动（不是先拉再藏）。
     *
     * 数据来自 host 的 `/plugins/dsh-qwen-connect/status`（与设置卡片同源），
     * 60 秒轮询一次。`showCredits=false` 时 host 根本不返回额度字段，
     * 这里自然渲染成 nothing——不在客户端做「有数据但藏起来」的假开关。
     */
    function QwenWorkCreditsPill(props) {
      const t = props.t;
      const [status, setStatus] = react.useState(null);
      // 归属：本会话是否正用千问。useProjection 缺失时保守判定为「不属于」，
      // 宁可本次不显示，也不在其他 provider 的会话里显示千问积分。
      const projection =
        typeof props.useProjection === 'function' ? props.useProjection('modelSelection') : undefined;
      const owned = selectedProviderOf(projection) === QWENWORK_PROVIDER_ID;

      react.useEffect(() => {
        if (!owned) {
          // 切走 provider 时清掉旧读数，避免切回来瞬间显示过期余额。
          setStatus(null);
          return undefined;
        }
        let cancelled = false;
        const load = async () => {
          try {
            const res = await fetch(QWENWORK_STATUS_PATH, {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            });
            if (!res.ok) return;
            const json = await res.json();
            if (!cancelled) setStatus(json);
          } catch {
            /* 网络抖动不影响输入框 */
          }
        };
        void load();
        const timer = setInterval(load, POLL_INTERVAL_MS);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [owned]);

      if (!owned) return null;

      const remaining = status !== null && typeof status.remaining === 'number' ? status.remaining : null;
      if (remaining === null) return null;
      if (status?.config?.showCredits === false) return null;

      const total = typeof status.total === 'number' ? status.total : null;
      const text = total === null
        ? formatNumber(remaining)
        : `${formatNumber(remaining)} / ${formatNumber(total)}`;
      // 低额度提示：仅当有 total 且剩余不足 10% 时变色，避免误导读数
      const low = total !== null && total > 0 && remaining / total < 0.1;
      return react.createElement(
        'span',
        {
          title: t('pill.title'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            borderRadius: 999,
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-module-platform)',
            color: low
              ? 'var(--dsw-alias-label-warning, var(--dsw-alias-label-secondary))'
              : 'var(--dsw-alias-label-tertiary)',
            fontSize: 12,
            lineHeight: '18px',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          },
        },
        t('pill.credits'),
        ' ',
        text,
      );
    }

    //#region 配置表单
    /**
     * 思考档位的展示顺序与文案键。
     *
     * 顺序与 host 的 `THINKING_LEVEL_IDS` 一致（低 → 高），客户端不重排，
     * 避免两处顺序不一致时用户看到的档位顺序与选择器里的不同。
     */
    const THINKING_LEVELS = [
      { id: 'low', field: 'thinkingLow', labelKey: 'thinkingLow' },
      { id: 'medium', field: 'thinkingMedium', labelKey: 'thinkingMedium' },
      { id: 'high', field: 'thinkingHigh', labelKey: 'thinkingHigh' },
      { id: 'xhigh', field: 'thinkingXhigh', labelKey: 'thinkingXhigh' },
      { id: 'max', field: 'thinkingMax', labelKey: 'thinkingMax' },
    ];

    /** 一个开关行。 */
    function SwitchRow(props) {
      const { label, hint, checked, disabled, onToggle } = props;
      return react_jsx_runtime.jsxs('label', {
        style: formRowStyle,
        children: [
          react_jsx_runtime.jsxs('span', {
            style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
            children: [
              react_jsx_runtime.jsx('span', {
                style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
                children: label,
              }),
              hint === undefined || hint === ''
                ? null
                : react_jsx_runtime.jsx('span', {
                    style: {
                      fontSize: 12,
                      lineHeight: '18px',
                      color: 'var(--dsw-alias-label-tertiary)',
                    },
                    children: hint,
                  }),
            ],
          }),
          react_jsx_runtime.jsx('input', {
            type: 'checkbox',
            checked: checked === true,
            disabled: disabled === true,
            onChange: (event) => onToggle(event.target.checked),
            style: { flex: '0 0 auto', width: 16, height: 16, cursor: disabled === true ? 'default' : 'pointer' },
          }),
        ],
      });
    }

    /**
     * 插件配置表单（`plugins.row.config` / `plugins.bundle.config`）。
     *
     * ⚠️ 这张表单**必须自己画**：DSH 不会因为插件导出了 `Config` schema 就
     * 自动生成表单。owner 只把 `form.state`（已接受的值 + revision + 可写性）
     * 和 `form.mutate`（带版本围栏的写入）交过来。不注册这个槽位，
     * 插件页面上就只剩校验，什么控件都不会出现。
     *
     * 写入一律走 `form.mutate([{op:'set', path:[field], value}], revision)`：
     * 由宿主做校验与并发围栏，客户端不做本地乐观更新——本地改了但宿主拒绝，
     * 界面就会显示一个并不存在的配置。
     */
    function QwenWorkConfigForm(props) {
      const { t, form, view } = props;
      const snapshot = form === undefined || form === null ? undefined : form.state;
      const value = snapshot?.value ?? {};
      const status = snapshot?.status ?? 'loading';
      const writable = snapshot?.writable === true && status === 'ready';
      const revision = snapshot?.revision;
      const [busy, setBusy] = react.useState(null);
      const [error, setError] = react.useState(null);
      /**
       * 给不可控输入框用的重挂载计数器。
       *
       * 输入框用 `defaultValue`（非受控）才能正常打字；但这也意味着宿主
       * **拒绝**写入时，框里会留着那个没被接受的文本，而页面上没有任何提示
       * ——界面显示了一个并不存在的配置。写入被拒时把 key 换掉即可让它
       * 重新以权威值挂载。
       */
      const [resetToken, setResetToken] = react.useState(0);

      /** 写一个字段。 */
      const write = (field, next) => {
        if (form === undefined || form === null || writable !== true) return;
        setBusy(field);
        setError(null);
        Promise.resolve(form.mutate([{ op: 'set', path: [field], value: next }], revision))
          .then((accepted) => {
            /**
             * ⚠️ `mutate` 的拒绝有**两种**形态，都必须处理：
             *   - 抛错：传输失败 / 宿主抛异常
             *   - 返回 `false`：宿主校验拒绝或 revision 冲突（不抛错）
             * 只 catch 不判 false 时，被拒的写入会静默留在界面上。
             */
            if (accepted === true) return;
            setError(t('configWriteRefused'));
            setResetToken((token) => token + 1);
          })
          .catch((cause) => {
            setError(String(cause?.message ?? cause));
            setResetToken((token) => token + 1);
          })
          .finally(() => setBusy(null));
      };

      /** 把文本框里的逗号串解析成模型 id 数组并写入。 */
      const commitAllowedModels = (raw) => {
        const ids = String(raw)
          .split(/[,，\s]+/)
          .map((item) => item.trim())
          .filter((item) => item !== '');
        write('allowedModelIds', ids);
      };

      /**
       * summary 视图：插件列表页在**没有 description** 时用它顶一行说明。
       *
       * ⚠️ 这个视图拿不到 `form`（宿主只 dispatch `{view:'summary'}`，见
       * dsh-client-ui-plugin-manager/lib/client.js:2807），所以**不能**在这里
       * 声称「当前生效哪些档位」——`value` 永远是 `{}`，照它渲染出来的
       * 是默认值而不是用户的实际配置，属于在界面上编造状态。
       *
       * 因此这里只给一句与配置无关的静态说明，真正的当前值在 page 视图里。
       */
      if (view === 'summary') {
        const note = form === undefined || form === null
          ? null
          : value.thinkingEnabled === false
            ? t('configThinkingOff')
            : null;
        return react_jsx_runtime.jsx('span', {
          style: { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
          children: note ?? t('configSummary'),
        });
      }

      /**
       * 没有 `form` 就什么都不渲染。
       *
       * 两种情形会走到这里，且都不该显示「正在读取配置…」（那会永远转下去）：
       *   1. `plugins.bundle.config`：owner 只 dispatch `{view}`，**不传 form**
       *      （我们的配置命名空间是条目 id，不是包名，那儿本来就没有对应表单）；
       *   2. 本条目尚未出现在 settings 的 describe 里（例如 schema 缺少
       *      `.volatile()` 时整条被丢弃）。
       * 后者属于配置面缺陷，由单元测试守住，不在界面上伪装成「加载中」。
       */
      if (form === undefined || form === null) return null;
      if (status === 'loading') {
        return react_jsx_runtime.jsx('p', { style: formHintStyle, children: t('configLoading') });
      }
      if (status === 'unavailable') {
        return react_jsx_runtime.jsx('p', { style: formHintStyle, children: t('configUnavailable') });
      }

      const thinkingOn = value.thinkingEnabled !== false;
      const levels = THINKING_LEVELS.filter((level) => value[level.field] !== false);
      /**
       * 写入进行中禁用全部控件。
       *
       * 每次写入都是一次带 `revision` 围栏的配置往返：连点第二个开关时
       * 手上的 revision 已经过期，宿主会返回 `false`，界面就会误报
       * 「配置没有保存成功」。等上一次落地再允许下一次即可，代价只是
       * 一次往返的等待。
       */
      const controlsDisabled = !writable || busy !== null;

      return react_jsx_runtime.jsxs('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 20 },
        children: [
          // ---- 思考深度 ----
          react_jsx_runtime.jsxs('section', {
            style: formSectionStyle,
            children: [
              react_jsx_runtime.jsx('h3', { style: formSectionTitleStyle, children: t('configThinkingHeading') }),
              react_jsx_runtime.jsx('p', {
                style: formHintStyle,
                children: t('configThinkingHint'),
              }),
              react_jsx_runtime.jsx(SwitchRow, {
                label: t('configThinkingEnabled'),
                hint: t('configThinkingEnabledHint'),
                checked: thinkingOn,
                disabled: controlsDisabled,
                onToggle: (next) => write('thinkingEnabled', next),
              }),
              thinkingOn
                ? react_jsx_runtime.jsxs('div', {
                    style: formLevelsStyle,
                    children: [
                      react_jsx_runtime.jsx('span', {
                        style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
                        children: t('configThinkingLevels'),
                      }),
                      // key 必须作为 jsx() 的第三个参数传入：放进 props 对象会被
                      // 展开后触发 React「key should not be spread」警告。
                      ...THINKING_LEVELS.map((level) =>
                        react_jsx_runtime.jsx(
                          SwitchRow,
                          {
                            label: t(level.labelKey),
                            hint: t(`${level.labelKey}Hint`),
                            checked: value[level.field] !== false,
                            disabled: controlsDisabled,
                            onToggle: (next) => write(level.field, next),
                          },
                          level.id,
                        ),
                      ),
                      levels.length === 0
                        ? react_jsx_runtime.jsx('span', {
                            style: {
                              fontSize: 12,
                              lineHeight: '18px',
                              color: 'var(--dsw-alias-label-warning)',
                            },
                            children: t('configThinkingNoneSelected'),
                          })
                        : null,
                    ],
                  })
                : null,
            ],
          }),
          // ---- 模型 ----
          react_jsx_runtime.jsxs('section', {
            style: formSectionStyle,
            children: [
              react_jsx_runtime.jsx('h3', { style: formSectionTitleStyle, children: t('configModelsHeading') }),
              react_jsx_runtime.jsxs('label', {
                style: { ...formRowStyle, alignItems: 'flex-start' },
                children: [
                  react_jsx_runtime.jsxs('span', {
                    style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 auto' },
                    children: [
                      react_jsx_runtime.jsx('span', {
                        style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
                        children: t('configAllowedModels'),
                      }),
                      react_jsx_runtime.jsx('span', {
                        style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
                        children: t('configAllowedModelsHint'),
                      }),
                    ],
                  }),
                  // key 作为第三个参数传入：放进 props 会被展开，触发 React 警告。
                  react_jsx_runtime.jsx('input', {
                    type: 'text',
                    defaultValue: Array.isArray(value.allowedModelIds)
                      ? value.allowedModelIds.join(', ')
                      : '',
                    disabled: controlsDisabled,
                    'aria-label': t('configAllowedModels'),
                    // 提交点选两个：失焦（最常见）与回车（输入完直接确认）。
                    // 只有失焦时，打完字直接关面板会让这次编辑静默丢失。
                    onBlur: (event) => commitAllowedModels(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      commitAllowedModels(event.currentTarget.value);
                    },
                    style: formInputStyle,
                    // 写入被拒时换 key 重新挂载，让它回到权威值而不是留着被拒的文本。
                  }, `allowed-model-ids-${resetToken}`),
                ],
              }),
              react_jsx_runtime.jsx(SwitchRow, {
                label: t('configRefreshOnStart'),
                hint: t('configRefreshOnStartHint'),
                checked: value.refreshCatalogOnStart !== false,
                disabled: controlsDisabled,
                onToggle: (next) => write('refreshCatalogOnStart', next),
              }),
              react_jsx_runtime.jsx(SwitchRow, {
                label: t('configShowCredits'),
                hint: t('configShowCreditsHint'),
                checked: value.showCredits !== false,
                disabled: controlsDisabled,
                onToggle: (next) => write('showCredits', next),
              }),
            ],
          }),
          // ---- 状态行 ----
          error === null
            ? null
            : react_jsx_runtime.jsx('p', {
                style: {
                  margin: 0,
                  fontSize: 12,
                  lineHeight: '18px',
                  color: 'var(--dsw-alias-state-error-primary)',
                  whiteSpace: 'pre-wrap',
                },
                role: 'alert',
                children: error,
              }),
          busy === null
            ? null
            : react_jsx_runtime.jsx('p', { style: formHintStyle, children: t('configSaving') }),
          writable
            ? null
            : react_jsx_runtime.jsx('p', { style: formHintStyle, children: t('configReadOnly') }),
        ],
      });
    }
    //#endregion

    /**
     * 注册卡片本体与积分胶囊。
     *
     * ⚠️ 槽位名必须与当前 DSH 的 Slot 树一致：
     *   - 设置卡片 → `settings.models.provider-card`（keyed，dispatch 键是
     *     provider 的 `settingsNs`）。旧版注册在 `settings.plugin.item`，
     *     该槽位在当前 DSH 已不存在，因此卡片从来没渲染过。
     *   - 积分胶囊 → `conversation.input.right`（list，按 `id` 区分，
     *     与 WorkBuddy 的同类胶囊并列）。
     */
    function apply(ctx) {
      try {
        const namespace = 'settings.qwenwork';
        ctx.effect(
          () => ctx.locale.register(namespace, { zh, en }),
          'dsh-qwen-connect: settings copy',
        );
        const t = ctx.locale.bind(namespace);

        // 设置页：provider 卡片扩展区（keyed by settingsNs）
        ctx.effect(
          () =>
            ctx.slots.inject('settings.models.provider-card', () =>
              ctx.slots.register(
                {
                  name: 'settings.models.provider-card',
                  key: 'qwenwork',
                  inject: () => ({ t }),
                },
                QwenWorkPluginCard,
              ),
            ),
          'dsh-qwen-connect: settings provider card',
        );

        // 插件配置页：`plugins.row.config` / `plugins.bundle.config`
        //
        // ⚠️ key 的形态是 `<包名>#<行 id>`（见 dsh-client-ui-plugin-manager 的
        // rowConfigKey）。我们的包名是 `dsh-qwen-connect`，但插件 patch 里的
        // 行 id 是 `llm-qwenwork`，两者**不相等**——照抄「包名#包名」会挂在
        // 一个永远不会被 dispatch 的键上，页面表现为「有配置但一片空白」。
        //
        // 而且行 id 可能出现带 `include:` 前缀的形态（profile 组合层的前缀），
        // 包名也可能。这里把四种组合都注册：keyed 槽位里没被 dispatch 的键
        // 不会渲染任何东西，多注册没有代价；漏注册才会让页面空白且不报错。
        for (const bundle of CONFIG_CARD_BUNDLES) {
          for (const rowId of CONFIG_CARD_ROWS) {
            ctx.effect(
              () =>
                ctx.slots.inject('plugins.row.config', () =>
                  ctx.slots.register(
                    {
                      name: 'plugins.row.config',
                      key: `${bundle}#${rowId}`,
                      inject: () => ({ t }),
                    },
                    QwenWorkConfigForm,
                  ),
                ),
              `dsh-qwen-connect: row config ${bundle}#${rowId}`,
            );
          }
          ctx.effect(
            () =>
              ctx.slots.inject('plugins.bundle.config', () =>
                ctx.slots.register(
                  { name: 'plugins.bundle.config', key: bundle, inject: () => ({ t }) },
                  QwenWorkConfigForm,
                ),
              ),
            `dsh-qwen-connect: bundle config ${bundle}`,
          );
        }

        // 输入框：剩余积分胶囊
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.right', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.right',
                  id: 'dsh-qwen-connect-credits',
                  order: 6,
                  inject: () => ({ t }),
                },
                QwenWorkCreditsPill,
              ),
            ),
          'dsh-qwen-connect: composer credits pill',
        );
      } catch (error) {
        console.error(
          '[dsh-qwen-connect] client card failed to load (host provider unaffected):',
          error,
        );
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
