// LINE受信箱（管理画面）
// ・ログインは Supabase Auth（メール＋パスワード）。ログイン情報はこのタブの中だけに保存し、タブを閉じると消える
// ・データは毎回 admin-api（サーバー側）から受け取る。権限の確認はすべてサーバー側で行う
// ・受け取った文字は必ず「文字として」表示し、HTMLとしては扱わない（不正なスクリプトの実行を防ぐ）
'use strict';

(() => {
  // 他のサイトの中に埋め込まれて表示されるのを防ぐ
  if (window.top !== window.self) {
    document.body.textContent = '';
    return;
  }

  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = window.LINE_INBOX_CONFIG;
  const API = `${SUPABASE_URL}/functions/v1/admin-api`;
  const SESSION_KEY = 'line-inbox-session';
  const POLL_MS = 60_000;

  const $ = (id) => document.getElementById(id);
  const state = { session: null, accounts: [], contacts: [], filter: '', contactId: null, pollTimer: null };

  // ---------- ログイン情報の保存（このタブの中だけ） ----------
  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
    } catch {
      return null;
    }
  }
  function saveSession(s) {
    state.session = s;
    try {
      if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // 保存できない環境でも、このページを開いている間は使える
    }
  }

  // ---------- Supabase Auth ----------
  async function authRequest(path, body, accessToken) {
    const headers = { apikey: SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function toSession(data) {
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  }

  async function login(email, password) {
    const r = await authRequest('token?grant_type=password', { email, password });
    if (!r.ok) return false;
    saveSession(toSession(r.data));
    return true;
  }

  async function refreshIfNeeded() {
    const s = state.session;
    if (!s) return false;
    if (Date.now() < s.expiresAt - 60_000) return true;
    const r = await authRequest('token?grant_type=refresh_token', { refresh_token: s.refreshToken });
    if (!r.ok) {
      saveSession(null);
      return false;
    }
    saveSession(toSession(r.data));
    return true;
  }

  async function logout() {
    const token = state.session?.accessToken;
    saveSession(null);
    stopPolling();
    if (token) await authRequest('logout', {}, token).catch(() => {});
    showLogin();
  }

  // ---------- admin-api ----------
  // 応答の状態番号と中身を返す（ログイン切れ・権限なしはここで処理する）
  async function apiRequest(path, { method = 'GET', body } = {}) {
    if (!(await refreshIfNeeded())) {
      showLogin('ログインの有効期限が切れました。もう一度ログインしてください。');
      throw new Error('auth');
    }
    const headers = { authorization: `Bearer ${state.session.accessToken}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      saveSession(null);
      showLogin('ログインの有効期限が切れました。もう一度ログインしてください。');
      throw new Error('auth');
    }
    if (res.status === 403 && (data.error === 'not_staff' || data.error === 'forbidden')) {
      await logout();
      showLogin('このアカウントには閲覧権限がありません。管理者に確認してください。');
      throw new Error('forbidden');
    }
    return { status: res.status, data };
  }

  async function api(path) {
    const { status, data } = await apiRequest(path);
    if (status !== 200) throw new Error(`api ${status}`);
    return data;
  }

  // ---------- 画面 ----------
  function showLogin(message = '') {
    stopPolling();
    $('inbox-view').hidden = true;
    $('login-view').hidden = false;
    $('login-error').textContent = message;
    $('login-password').value = '';
  }

  async function showInbox() {
    $('login-view').hidden = true;
    $('inbox-view').hidden = false;
    setError('');
    const me = await api('/me');
    state.accounts = me.accounts;
    $('user-email').textContent = me.email;
    const filter = $('account-filter');
    filter.replaceChildren(new Option('すべての公式LINE', ''), ...me.accounts.map((a) => new Option(a.name, a.key)));
    filter.hidden = me.accounts.length <= 1; // 公式LINEが1つだけなら絞り込みは不要
    state.filter = '';
    state.contactId = null;
    await refresh();
    startPolling();
  }

  function setError(msg) {
    $('inbox-error').textContent = msg;
  }

  const timeFormat = new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo',
  });
  const formatTime = (iso) => (iso ? timeFormat.format(new Date(iso)) : '');

  // 全公式LINEの相手を1つの一覧に表示する（各行に受信先の公式LINEを表示）
  async function loadContacts() {
    const { contacts } = await api('/contacts');
    state.contacts = contacts;
    renderContacts();
  }

  function renderContacts() {
    const shown = state.contacts.filter((c) => !state.filter || c.account.key === state.filter);
    $('contact-list').replaceChildren(...shown.map(contactRow));
    $('contacts-empty').hidden = shown.length > 0;
  }

  function contactRow(c) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.id = c.id;
    btn.setAttribute('aria-current', String(c.id === state.contactId));

    const displayName = c.display_name || '（名前未取得）';
    const name = el('span', 'name', displayName);
    const time = el('span', 'time', formatTime(c.last_message_at));
    const preview = el('span', 'preview', (c.last_direction === 'out' ? '送信: ' : '') + (c.last_message_preview ?? ''));
    const badge = el('span', 'badge', c.account.name);
    btn.append(avatar(c, displayName), name, time, preview, badge);
    btn.addEventListener('click', () => selectContact(c));
    li.append(btn);
    return li;
  }

  function avatar(c, displayName) {
    if (c.picture_url) {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = c.picture_url;
      return img;
    }
    return el('span', 'avatar', displayName.slice(0, 1));
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    e.className = className;
    e.textContent = text;
    return e;
  }

  async function loadMessages() {
    if (!state.contactId) return;
    const { messages } = await api(`/contacts/${encodeURIComponent(state.contactId)}/messages`);
    const list = $('message-list');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(
      ...messages.map((m) => {
        const li = document.createElement('li');
        li.className = m.direction === 'out' ? 'out' : 'in';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = m.text;
        const time = document.createElement('time');
        time.dateTime = m.sent_at;
        time.textContent = formatTime(m.sent_at);
        li.append(bubble, time);
        return li;
      }),
    );
    if (atBottom || list.dataset.contact !== state.contactId) list.scrollTop = list.scrollHeight;
    list.dataset.contact = state.contactId;
  }

  async function selectContact(c) {
    state.contactId = c.id;
    $('thread-title').textContent = c.display_name || '（名前未取得）';
    const badge = $('thread-account');
    badge.textContent = `${c.account.name} 宛て`;
    badge.hidden = false;
    for (const b of $('contact-list').querySelectorAll('button')) {
      b.setAttribute('aria-current', String(b.dataset.id === c.id));
    }
    $('reply-form').hidden = false;
    $('reply-note').textContent = `${c.account.name} から送信されます`;
    $('call-link-button').hidden = !c.account.has_call; // 通話URLを登録した公式LINEだけ表示
    $('reply-error').textContent = '';
    await guarded(loadMessages);
  }

  async function refresh() {
    await guarded(async () => {
      await loadContacts();
      await loadMessages();
      await loadUsage();
    });
  }

  // ---------- 今月の送信数 ----------
  async function loadUsage() {
    const { accounts } = await api('/usage');
    const el = $('usage');
    const parts = accounts.map((a) => {
      const used = Math.max(a.push, a.lineTotal ?? 0);
      return `${a.name} 今月の送信 ${used}/${a.limit}通${a.lineTotal === null ? '（LINE確認不可）' : ''}`;
    });
    el.textContent = parts.join(' ／ ');
    el.classList.toggle('warn', accounts.some((a) => Math.max(a.push, a.lineTotal ?? 0) >= a.limit * 0.8));
  }

  // ---------- 返信 ----------
  const REPLY_ERRORS = {
    invalid_text: '本文を入力してください（5000文字まで）。',
    recipient_not_allowed: 'テスト期間中のため、この相手には送信できません（許可リスト外）。',
    monthly_limit_reached: '今月の送信上限（150通）に達したため、送信を停止しています。',
    quota_check_failed: 'LINEの送信数を確認できなかったため、安全のため送信しませんでした。時間をおいて再度お試しください。',
    line_not_configured: 'この公式LINEの送信設定が未完了です。管理者に確認してください。',
    line_send_failed: 'LINEへの送信に失敗しました。相手がブロックしている可能性があります。',
    sent_but_not_saved: '送信はできましたが、履歴への記録に失敗しました。もう一度送らないでください。',
    not_found: 'この相手は見つかりませんでした。一覧を更新してください。',
    call_not_configured: 'この公式LINEには通話リンクが登録されていません。',
  };

  async function sendReply() {
    const text = $('reply-text').value.trim();
    if (!text || !state.contactId) return;
    await send(`/contacts/${encodeURIComponent(state.contactId)}/messages`, { text }, true);
  }

  // 通話リンク：文面とURLはサーバー側で決まる。誤送信を防ぐため送信前に確認する
  async function sendCallLink() {
    if (!state.contactId) return;
    if (!window.confirm('この相手にLINE通話のリンクを送信しますか？')) return;
    await send(`/contacts/${encodeURIComponent(state.contactId)}/call-link`, {}, false);
  }

  async function send(path, body, clearText) {
    const textarea = $('reply-text');
    const buttons = [$('reply-button'), $('call-link-button')];
    buttons.forEach((b) => (b.disabled = true));
    $('reply-error').textContent = '';
    try {
      const { status, data } = await apiRequest(path, { method: 'POST', body });
      if (status === 200) {
        if (clearText) textarea.value = '';
        $('reply-note').textContent = data.method === 'reply' ? '無料の返信で送信しました' : '送信しました（今月の送信数に1通加算）';
      } else {
        $('reply-error').textContent = REPLY_ERRORS[data.error] ?? '送信できませんでした。時間をおいて再度お試しください。';
        if (data.error === 'sent_but_not_saved' && clearText) textarea.value = '';
      }
      await refresh();
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'forbidden') {
        $('reply-error').textContent = '通信に失敗しました。送信されたか履歴を確認してから再度お試しください。';
      }
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  async function guarded(fn) {
    try {
      await fn();
      setError('');
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'forbidden') {
        setError('読み込みに失敗しました。時間をおいて「更新」を押してください。');
      }
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // ---------- 操作 ----------
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter ?? $('login-form').querySelector('button');
    button.disabled = true;
    $('login-error').textContent = '';
    try {
      const ok = await login($('login-email').value.trim(), $('login-password').value);
      if (!ok) {
        $('login-error').textContent = 'メールアドレスまたはパスワードが違います。';
        return;
      }
      $('login-password').value = '';
      await showInbox();
    } catch {
      $('login-error').textContent = 'ログインできませんでした。通信状態を確認してください。';
    } finally {
      button.disabled = false;
    }
  });

  $('logout-button').addEventListener('click', logout);
  $('refresh-button').addEventListener('click', refresh);
  $('reply-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendReply();
  });
  $('call-link-button').addEventListener('click', sendCallLink);
  $('reply-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!$('reply-button').disabled) sendReply();
    }
  });
  $('account-filter').addEventListener('change', (e) => {
    state.filter = e.target.value;
    renderContacts();
  });

  // ---------- 起動 ----------
  state.session = loadSession();
  if (state.session) showInbox().catch(() => {});
  else showLogin();
})();
