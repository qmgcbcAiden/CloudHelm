import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSnapshot, ModelProfileDraft, ModelProviderSettings, ModelProviderView } from '@cloudhelm/contracts';
import { errorMessage, inlineError } from './error-presentation.js';
import styles from './model-settings.module.css';

type Profile = AppSnapshot['profile'];
type Section = 'api' | 'subscription' | 'review';
type Destination = { section: Section } | { providerId: string } | { close: true } | { externalAction(): void };
type NavigationGuard = (next: () => void) => void;
type Feedback = { kind: 'success' | 'error'; text: string } | null;
interface ApiDraft { modelId: string; baseUrl: string; apiKey: string }
interface ProviderConfiguration { providerId: string; saved: ModelProviderSettings; initial: ApiDraft }

function message(error: unknown): string { return inlineError(error); }

/** Credentials are write-only: renderer receives configuration status, never saved keys. */
export function ModelSettingsDialog({ current, close, report, registerNavigationGuard }: {
  current: Profile; close(): void; report(value: string): void;
  registerNavigationGuard?(guard: NavigationGuard | null): void;
}): React.JSX.Element {
  const [section, setSection] = useState<Section>('api');
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [providerId, setProviderId] = useState('');
  const [configuration, setConfiguration] = useState<ProviderConfiguration | null>(null);
  const [draft, setDraft] = useState<ApiDraft>({ modelId: '', baseUrl: '', apiKey: '' });
  const [providerSearch, setProviderSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [jevKey, setJevKey] = useState('');
  const [hasJevKey, setHasJevKey] = useState(current.hasJevKey);
  const [disableJev, setDisableJev] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<Destination | null>(null);
  const [defaultProvider, setDefaultProvider] = useState(current.provider);
  const initialProvider = useRef(current.provider);
  const callback = useRef({ close, report });
  callback.current = { close, report };
  const navigationRequest = useRef<(destination: Destination) => void>(() => undefined);
  const provider = providers.find((item) => item.id === providerId);
  const loaded = configuration?.providerId === providerId;
  const isDefault = (item: ModelProviderView): boolean => item.id === defaultProvider
    || item.name.toLowerCase() === defaultProvider.toLowerCase();
  const apiDirty = loaded && configuration !== null && (draft.apiKey !== ''
    || draft.modelId !== configuration.initial.modelId || draft.baseUrl !== configuration.initial.baseUrl);
  const dirty = section === 'api' ? apiDirty : section === 'review' && (jevKey !== '' || disableJev);
  const validApi = loaded && !!draft.modelId.trim() && !!draft.baseUrl.trim();
  const hasApiKey = configuration?.saved.hasKey || !!draft.apiKey.trim();

  useEffect(() => {
    let active = true;
    setLoadError('');
    void window.cloudhelm.listModelProviders().then((catalog) => {
      if (!active) return;
      setProviders(catalog);
      setProviderId((selected) => selected || catalog.find((item) => item.id === initialProvider.current
        || item.name.toLowerCase() === initialProvider.current.toLowerCase())?.id || catalog[0]?.id || '');
    }).catch((error: unknown) => { if (active) setLoadError(message(error)); });
    return () => { active = false; };
  }, [reload]);

  useEffect(() => {
    const selected = providers.find((item) => item.id === providerId);
    if (!selected) return;
    let active = true;
    setConfiguration(null);
    setDraft({ modelId: '', baseUrl: '', apiKey: '' });
    setShowKey(false);
    setModelSearch('');
    setFeedback(null);
    setLoadError('');
    void window.cloudhelm.modelProviderSettings(providerId).then((saved) => {
      if (!active) return;
      const initial = { modelId: saved.modelId ?? selected.models[0]?.id ?? '',
        baseUrl: saved.baseUrl ?? selected.defaultBaseUrl ?? '', apiKey: '' };
      setConfiguration({ providerId, saved, initial });
      setDraft(initial);
    }).catch((error: unknown) => { if (active) setLoadError(message(error)); });
    return () => { active = false; };
  }, [providerId, providers]);

  useEffect(() => {
    registerNavigationGuard?.((next) => navigationRequest.current({ externalAction: next }));
    return () => registerNavigationGuard?.(null);
  }, [registerNavigationGuard]);

  const visibleProviders = useMemo(() => providers.filter((item) =>
    `${item.name} ${item.id}`.toLowerCase().includes(providerSearch.trim().toLowerCase())), [providers, providerSearch]);
  const visibleModels = useMemo(() => (provider?.models ?? []).filter((item) =>
    `${item.name} ${item.id}`.toLowerCase().includes(modelSearch.trim().toLowerCase())), [provider, modelSearch]);

  function navigate(destination: Destination): void {
    setPending(null);
    setFeedback(null);
    setShowKey(false);
    if ('externalAction' in destination) destination.externalAction();
    else if ('close' in destination) callback.current.close();
    else if ('providerId' in destination) setProviderId(destination.providerId);
    else setSection(destination.section);
  }

  function requestNavigation(destination: Destination): void {
    if (busy) return;
    if ('providerId' in destination && destination.providerId === providerId) return;
    if ('section' in destination && destination.section === section) return;
    if (dirty) setPending(destination);
    else navigate(destination);
  }
  navigationRequest.current = requestNavigation;

  function discardAndNavigate(): void {
    if (!pending) return;
    if (configuration) setDraft(configuration.initial);
    setJevKey('');
    setDisableJev(false);
    navigate(pending);
  }

  function updateDraft(update: Partial<ApiDraft>): void {
    setDraft((value) => ({ ...value, ...update }));
    setFeedback(null);
  }

  function profileDraft(): ModelProfileDraft {
    return { provider: providerId, modelId: draft.modelId.trim(), baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim() || undefined };
  }

  async function saveApi(): Promise<boolean> {
    if (!provider || !configuration || !validApi || busy) return false;
    setBusy('save');
    setFeedback(null);
    try {
      const profile = profileDraft();
      await window.cloudhelm.saveModelProfile(profile);
      const initial = { modelId: profile.modelId, baseUrl: profile.baseUrl ?? '', apiKey: '' };
      setConfiguration({ providerId, saved: { modelId: initial.modelId, baseUrl: initial.baseUrl,
        hasKey: configuration.saved.hasKey || !!profile.apiKey }, initial });
      setDraft(initial);
      setShowKey(false);
      setDefaultProvider(providerId);
      setFeedback({ kind: 'success', text: '已保存为默认模型，新对话将使用此配置。' });
      callback.current.report('');
      return true;
    } catch (error) { setFeedback({ kind: 'error', text: message(error) }); callback.current.report(errorMessage(error)); return false; }
    finally { setBusy(null); }
  }

  async function saveReview(): Promise<boolean> {
    if (busy) return false;
    setBusy('save');
    setFeedback(null);
    try {
      await window.cloudhelm.saveReviewSettings({ jevKey: disableJev ? undefined : jevKey.trim() || undefined, disableJev });
      setHasJevKey(disableJev ? false : hasJevKey || !!jevKey.trim());
      setJevKey('');
      setDisableJev(false);
      setFeedback({ kind: 'success', text: 'AI 审核设置已保存。' });
      callback.current.report('');
      return true;
    } catch (error) { setFeedback({ kind: 'error', text: message(error) }); callback.current.report(errorMessage(error)); return false; }
    finally { setBusy(null); }
  }

  async function saveAndNavigate(): Promise<void> {
    if (!pending) return;
    const saved = section === 'api' ? await saveApi() : await saveReview();
    if (saved) navigate(pending);
    else setPending(null);
  }

  async function testConnection(): Promise<void> {
    if (!validApi || !hasApiKey || busy) return;
    setBusy('test');
    setFeedback(null);
    try {
      const result = await window.cloudhelm.testModelConnection(profileDraft());
      setFeedback({ kind: 'success', text: `连接正常 · ${Math.round(result.latencyMs)} ms` });
    } catch (error) { setFeedback({ kind: 'error', text: message(error) }); }
    finally { setBusy(null); }
  }

  return <section className={styles.page} aria-label="模型设置" aria-busy={busy !== null}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>偏好设置</p><h1>模型设置</h1></div>
      <button type="button" className={styles.button} disabled={busy !== null} onClick={() => requestNavigation({ close: true })}>
        <span aria-hidden="true">←</span> 返回终端
      </button>
    </header>
    <nav className={styles.sections} role="tablist" aria-label="模型接入方式">
      {([{ id: 'api', label: 'API Key', icon: 'key' }, { id: 'subscription', label: '模型订阅 · 未开放', icon: 'subscription' },
        { id: 'review', label: 'AI 审核', icon: 'shield' }] as const).map((item) =>
        <button key={item.id} id={`model-tab-${item.id}`} type="button" role="tab" aria-selected={section === item.id}
          aria-controls={`model-panel-${item.id}`} disabled={busy !== null} className={styles.sectionTab}
          onClick={() => requestNavigation({ section: item.id })}><SettingsIcon kind={item.icon} />{item.label}</button>)}
    </nav>

    {section === 'api' && <div className={styles.apiLayout} role="tabpanel" id="model-panel-api" aria-labelledby="model-tab-api">
      <aside className={styles.providers} aria-label="供应商列表">
        <h2>供应商</h2>
        <SearchField value={providerSearch} onChange={setProviderSearch} label="搜索供应商" placeholder="搜索供应商…" />
        <div className={styles.providerList}>{visibleProviders.map((item) =>
          <button type="button" key={item.id} disabled={busy !== null} className={styles.provider}
            aria-pressed={item.id === providerId} onClick={() => requestNavigation({ providerId: item.id })}>
            <span className={styles.providerBadge} aria-hidden="true">{item.id === 'cloudhelm-custom' ? '+' : item.name.slice(0, 1)}</span>
            <span className={styles.providerName}>{item.name}</span>
            {isDefault(item) && <span className={styles.defaultDot} title="默认供应商" aria-label="默认供应商" />}
          </button>)}
          {!visibleProviders.length && <p className={styles.empty}>{providers.length ? '没有找到供应商' : loadError ? '供应商目录未加载' : '正在读取供应商目录…'}</p>}
        </div>
        <p className={styles.catalogHint}>供应商与模型来自 Pi SDK</p>
      </aside>

      <div className={styles.detail}>
        {loadError ? <div className={styles.loadError} role="alert"><h2>暂时无法读取配置</h2><p>{loadError}</p>
          <button type="button" className={styles.button} onClick={() => setReload((value) => value + 1)}>重试</button></div>
          : provider ? <>
            <div className={styles.providerHeading}><div><h2>{provider.name}{isDefault(provider) && <span className={styles.badge}>默认</span>}</h2>
              <p>配置连接并选择新对话使用的模型。</p></div></div>
            <fieldset className={styles.fields} disabled={!loaded || busy !== null}>
              <div className={styles.field}><label htmlFor="model-api-key">API Key</label><div>
                <div className={styles.inputWithAction}><input id="model-api-key" type={showKey ? 'text' : 'password'} autoComplete="off"
                  spellCheck={false} value={draft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })}
                  placeholder={configuration?.saved.hasKey ? '已配置 · 留空保留现有 Key' : '粘贴供应商 API Key'} />
                  <button type="button" aria-label={showKey ? '隐藏 API Key' : '显示新输入的 API Key'} aria-pressed={showKey}
                    onClick={() => setShowKey((value) => !value)}><SettingsIcon kind={showKey ? 'eye-off' : 'eye'} /></button></div>
                <p className={styles.hint}>密钥仅保存在本机加密存储中。</p>
              </div></div>
              <div className={styles.field}><label htmlFor="model-base-url">Base URL</label><div>
                <div className={styles.urlRow}><input id="model-base-url" type="url" spellCheck={false} value={draft.baseUrl}
                  onChange={(event) => updateDraft({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
                  <button type="button" className={styles.button} disabled={!provider.defaultBaseUrl}
                    onClick={() => updateDraft({ baseUrl: provider.defaultBaseUrl ?? '' })}>恢复预置</button></div>
                <p className={styles.hint}>{provider.defaultBaseUrl ? '已预置供应商地址，可单独修改。' : '填写自定义服务的 API 地址，支持 HTTPS 或本机 HTTP。'}</p>
              </div></div>
              <div className={styles.testRow}>
                <button type="button" className={styles.button} disabled={!validApi || !hasApiKey || busy !== null}
                  onClick={() => void testConnection()}><span aria-hidden="true">▷</span>{busy === 'test' ? '正在测试…' : '测试连接'}</button>
                <span className={styles.hint}>{busy === 'test' ? '正在使用当前表单连接所选模型…' : '发送一条简短请求，可能产生少量费用。'}</span>
              </div>
            </fieldset>
            <FeedbackLine feedback={feedback} />
            <div className={styles.modelSection}>
              <div className={styles.modelHeader}><div><h3>模型选择</h3><p>已选：{draft.modelId || '尚未选择'}</p></div>
                {provider.models.length > 0 && <SearchField value={modelSearch} onChange={setModelSearch} label="搜索模型" placeholder="搜索模型…" />}</div>
              {provider.id === 'cloudhelm-custom'
                ? <label className={styles.customModel}>模型 ID<input value={draft.modelId} disabled={!loaded || busy !== null}
                  onChange={(event) => updateDraft({ modelId: event.target.value })} placeholder="服务提供的模型 ID，例如 my-model" /></label>
                : <div className={styles.modelList} role="radiogroup" aria-label="默认模型">
                  {visibleModels.map((item) => <button key={item.id} type="button" role="radio" aria-checked={draft.modelId === item.id}
                    disabled={!loaded || busy !== null} className={styles.modelRow} onClick={() => updateDraft({ modelId: item.id })}>
                    <span className={styles.radio} aria-hidden="true" /><span>{item.name}<small>{item.id}</small></span>
                  </button>)}
                  {!visibleModels.length && <p className={styles.empty}>没有找到匹配的模型</p>}
                </div>}
            </div>
          </> : !loadError && <p className={styles.empty}>正在加载模型设置…</p>}
      </div>
    </div>}

    {section === 'subscription' && <div className={styles.infoPanel} role="tabpanel" id="model-panel-subscription" aria-labelledby="model-tab-subscription">
      <span className={styles.infoIcon}><SettingsIcon kind="subscription" /></span><h2>模型订阅</h2><span className={styles.badge}>尚未开放</span>
      <p>这里将支持供应商允许的订阅账户登录，并显示账户、授权范围与计费归属。</p>
      <p>当前请使用 API Key 连接模型。订阅登录将使用独立的认证流程，不会自动切换你的凭据或计费方式。</p>
      <button type="button" className={styles.button} onClick={() => requestNavigation({ section: 'api' })}>配置 API Key</button>
    </div>}

    {section === 'review' && <div className={styles.reviewPanel} role="tabpanel" id="model-panel-review" aria-labelledby="model-tab-review">
      <div className={styles.providerHeading}><h2>AI 安全审核</h2><p>第二档审核的模型连接，与聊天模型分开配置。</p></div>
      <div className={styles.reviewStatus}><SettingsIcon kind="shield" /><div><strong>{hasJevKey && !disableJev ? '已配置 Jev 审核' : '使用主模型独立审核'}</strong>
        <p>{hasJevKey && !disableJev ? 'Jev 服务失败时等待人工处理，不会自动降级。' : '未配置 Jev Key 时，由当前对话的主模型进行独立安全审核。'}</p></div></div>
      <fieldset className={styles.reviewFields} disabled={busy !== null}>
        <label htmlFor="review-key">Jev / Vercel Gateway Key {hasJevKey && <span className={styles.badge}>已配置</span>}</label>
        <input id="review-key" type="password" autoComplete="off" spellCheck={false} value={jevKey} disabled={disableJev}
          onChange={(event) => { setJevKey(event.target.value); setFeedback(null); }} placeholder={hasJevKey ? '留空保留现有 Key' : '可选 · 填写后启用 Jev'} />
        <p className={styles.hint}>使用 Vercel Gateway 的 typesafe-ai/jev。凭据与聊天模型独立，使用费用按供应商规则计算。</p>
        {hasJevKey && <label className={styles.checkbox}><input type="checkbox" checked={disableJev}
          onChange={(event) => { setDisableJev(event.target.checked); setFeedback(null); }} />移除 Jev Key，改用主模型审核</label>}
      </fieldset>
      <div className={styles.reviewExplanation}><h3>审核如何工作</h3>
        <p>已识别的高危禁令直接拦截，完整满足低风险白名单的操作自动执行。其余操作在第二档交由审核模型判断是否允许、请求人工确认或拒绝。</p>
        <p>各主机的审核档位在主机安全设置中管理。</p></div>
      <FeedbackLine feedback={feedback} />
    </div>}

    <footer className={styles.footer}>
      <p>{section === 'api' ? '默认模型用于新对话；已有对话可在输入框中切换模型。'
        : section === 'review' ? '密钥默认仅保存在此设备。' : '当前版本不提供订阅登录。'}</p>
      <button type="button" className={styles.button} disabled={busy !== null} onClick={() => requestNavigation({ close: true })}>返回</button>
      {section === 'api' && <button type="button" className={styles.primary} disabled={busy !== null || !validApi}
        onClick={() => void saveApi()}>{busy === 'save' ? '保存中…' : '保存为默认'}</button>}
      {section === 'review' && <button type="button" className={styles.primary} disabled={busy !== null}
        onClick={() => void saveReview()}>{busy === 'save' ? '保存中…' : '保存审核设置'}</button>}
    </footer>
    {pending && <UnsavedChanges api={section === 'api'} busy={busy !== null} canSave={section !== 'api' || !!validApi}
      cancel={() => setPending(null)} discard={discardAndNavigate} save={() => void saveAndNavigate()} />}
  </section>;
}

function SearchField({ value, onChange, label, placeholder }: {
  value: string; onChange(value: string): void; label: string; placeholder: string;
}): React.JSX.Element {
  return <label className={styles.search}><SettingsIcon kind="search" /><input type="search" value={value} aria-label={label}
    onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function FeedbackLine({ feedback }: { feedback: Feedback }): React.JSX.Element | null {
  if (!feedback) return null;
  return <p className={feedback.kind === 'error' ? styles.error : styles.success}
    role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.kind === 'success' && <span aria-hidden="true">✓ </span>}{feedback.text}</p>;
}

function UnsavedChanges({ api, busy, canSave, cancel, discard, save }: {
  api: boolean; busy: boolean; canSave: boolean; cancel(): void; discard(): void; save(): void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={styles.unsavedDialog} aria-labelledby="unsaved-model-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) cancel(); }}>
    <h2 id="unsaved-model-title">还有未保存的更改</h2>
    <p>{api ? '保存后，这个供应商和模型将成为新对话的默认配置。' : '保存后，将使用新的 AI 审核设置。'}</p>
    <div><button type="button" className={styles.button} disabled={busy} autoFocus onClick={cancel}>继续编辑</button>
      <button type="button" className={styles.button} disabled={busy} onClick={discard}>放弃更改</button>
      <button type="button" className={styles.primary} disabled={busy || !canSave} onClick={save}>{busy ? '保存中…' : '保存并继续'}</button></div>
  </dialog>;
}

type IconKind = 'key' | 'subscription' | 'shield' | 'search' | 'eye' | 'eye-off';
function SettingsIcon({ kind }: { kind: IconKind }): React.JSX.Element {
  const paths: Record<IconKind, React.JSX.Element> = {
    key: <><circle cx="15" cy="8" r="5" /><path d="m11.5 11.5-8 8V22H7v-3h3v-3l3-3" /></>,
    subscription: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7" /></>,
    shield: <><path d="m12 3 8 4v6c0 5-8 9-8 9S4 18 4 13V7z" /><path d="m8 12 3 3 5-6" /></>,
    search: <><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    'eye-off': <><path d="m3 3 18 18M9 5.5 12 5c6.5 0 10 7 10 7s-1 2-3 4M6 7c-2.5 2-4 5-4 5s3.5 7 10 7c1.5 0 3-.4 4.2-1M10 10a3 3 0 0 0 4 4" /></>
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
