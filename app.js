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
  const state = {
    session: null, accounts: [], contacts: [], filter: '', tab: 'todo', contactId: null, pollTimer: null,
    templates: [], editingTemplateId: null,
    images: new Map(), // 表示済みの画像（メッセージID → このタブの中だけで使う一時URL）
  };

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
    setTab('todo');
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

  // 要対応 = 未返信 または フォロー中
  const isTodo = (c) => Boolean(c.awaiting_since || c.follow_up_note);
  const nameOf = (c) => c.custom_name || c.display_name || '（名前未取得）';

  function renderContacts() {
    const inAccount = state.contacts.filter((c) => !state.filter || c.account.key === state.filter);
    const todoCount = inAccount.filter(isTodo).length;
    const shown = state.tab === 'todo' ? inAccount.filter(isTodo) : inAccount;
    $('contact-list').replaceChildren(...shown.map(contactRow));
    $('contacts-empty').textContent = state.tab === 'todo' ? '対応が必要な相手はいません' : 'まだメッセージはありません';
    $('contacts-empty').hidden = shown.length > 0;
    $('todo-count').textContent = String(todoCount);
    document.title = todoCount > 0 ? `(${todoCount}) LINE受信箱` : 'LINE受信箱';
  }

  function setTab(tab) {
    state.tab = tab;
    $('tab-todo').setAttribute('aria-pressed', String(tab === 'todo'));
    $('tab-all').setAttribute('aria-pressed', String(tab === 'all'));
  }

  // 「25分」「3時間」「2日」
  function elapsed(iso) {
    const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
    if (min < 60) return `${min}分`;
    if (min < 24 * 60) return `${Math.floor(min / 60)}時間`;
    return `${Math.floor(min / (24 * 60))}日`;
  }

  // 日本時間の今日（YYYY-MM-DD）。期限切れの判定に使う
  const todayJst = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const formatDue = (due) => `${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))}`;

  function followTag(c, tag) {
    const overdue = Boolean(c.follow_up_due && c.follow_up_due < todayJst());
    const due = c.follow_up_due ? `・${formatDue(c.follow_up_due)}${overdue ? ' 期限切れ' : ''}` : '';
    return el(tag, `tag follow${overdue ? ' overdue' : ''}`, `📌 ${c.follow_up_note}${due}`);
  }

  function contactRow(c) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.id = c.id;
    btn.setAttribute('aria-current', String(c.id === state.contactId));

    const displayName = nameOf(c);
    const name = el('span', 'name', displayName);
    // 呼び名を付けた相手は、LINE上の名前も小さく添える
    if (c.custom_name && c.display_name && c.custom_name !== c.display_name) name.append(el('span', 'sub', `(${c.display_name})`));
    const time = el('span', 'time', formatTime(c.last_message_at));
    const preview = el('span', 'preview', (c.last_direction === 'out' ? '送信: ' : '') + (c.last_message_preview ?? ''));
    const badge = el('span', 'badge', c.account.name);
    btn.append(avatar(c, displayName), name, time, preview, badge);
    if (isTodo(c)) {
      const tags = el('span', 'tags', '');
      if (c.awaiting_since) tags.append(el('span', 'tag waiting', `未返信 ${elapsed(c.awaiting_since)}`));
      if (c.follow_up_note) tags.append(followTag(c, 'span'));
      btn.append(tags);
    }
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
        const bubble = m.media ? mediaBubble(m) : el('div', 'bubble', m.text);
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

  // ---------- 画像・ファイル ----------
  const MEDIA_LABELS = { image: '画像', video: '動画', audio: '音声', file: 'ファイル' };
  const RESEND_REQUEST =
    '{名前}様\nお送りいただいたファイルを、こちらで受け取ることができませんでした。' +
    'お手数ですが、ファイルを分けて再度お送りいただくか、メールなど別の方法でお送りいただけますでしょうか。';

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  // 状態ごとの表示：保存済み → 表示・開く／取り込み中・失敗 → 再取得／取得不可・大きすぎ → 相手への依頼文
  function mediaBubble(m) {
    const box = el('div', 'bubble media', '');
    const label = MEDIA_LABELS[m.message_type] ?? 'ファイル';
    const title = m.media.name ? `${label}：${m.media.name}` : label;
    const size = formatSize(m.media.size);
    box.append(el('div', 'media-title', size ? `${title}（${size}）` : title));

    const { status } = m.media;
    if (status === 'stored' && m.media.image) {
      const img = document.createElement('img');
      img.className = 'media-image';
      img.alt = '受信した画像';
      img.title = 'クリックで大きく表示';
      box.append(img);
      showImage(m.id, img);
      img.addEventListener('click', () => img.src && window.open(img.src, '_blank', 'noopener'));
      box.append(actionButton('ダウンロード', () => openFile(m.id, box, true)));
    } else if (status === 'stored') {
      box.append(actionButton('ダウンロードして開く', () => openFile(m.id, box)));
    } else if (status === 'pending' || status === 'failed') {
      box.append(el('div', 'media-note', status === 'pending' ? '取り込み中です。' : '取り込みに失敗しました。'));
      box.append(actionButton('再取得', () => retryMedia(m.id, box)));
    } else {
      box.append(el('div', 'media-note', status === 'too_large'
        ? '50MBを超えるため、この画面には保存できませんでした。'
        : 'LINEからファイルを取得できなくなりました（保存期間切れなど）。'));
      box.append(actionButton('再送の依頼文を入力欄に入れる', () => insertText(RESEND_REQUEST)));
    }
    return box;
  }

  function actionButton(text, onClick) {
    const b = el('button', 'secondary small', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function mediaError(box, message) {
    box.querySelector('.media-error')?.remove();
    box.append(el('div', 'media-error error', message));
  }

  // 画像は一時リンクから中身を受け取り、このタブの中だけの一時URLで表示する（一覧の更新のたびに取り直さない）
  async function showImage(messageId, img) {
    if (state.images.has(messageId)) {
      img.src = state.images.get(messageId);
      return;
    }
    try {
      const { status, data } = await apiRequest(`/messages/${encodeURIComponent(messageId)}/media`);
      if (status !== 200 || !data.image) throw new Error('media');
      const res = await fetch(data.url);
      if (!res.ok) throw new Error('media');
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error('media');
      const url = URL.createObjectURL(blob);
      state.images.set(messageId, url);
      img.src = url;
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'forbidden') img.replaceWith(el('div', 'media-error error', '画像を表示できませんでした。「更新」を押すと再度読み込みます。'));
    }
  }

  async function openFile(messageId, box, forDownload = false) {
    try {
      const query = forDownload ? '?download=1' : '';
      const { status, data } = await apiRequest(`/messages/${encodeURIComponent(messageId)}/media${query}`);
      if (status !== 200) throw new Error('media');
      // 一時リンク（60秒で失効）をダウンロードとして開く
      const a = document.createElement('a');
      a.href = data.url;
      a.rel = 'noopener noreferrer';
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'forbidden') mediaError(box, 'ファイルを開けませんでした。時間をおいて再度お試しください。');
    }
  }

  async function retryMedia(messageId, box) {
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    try {
      const { status, data } = await apiRequest(`/messages/${encodeURIComponent(messageId)}/media/retry`, { method: 'POST', body: {} });
      if (status !== 200) throw new Error('media');
      if (data.status === 'failed') mediaError(box, 'まだ取り込めませんでした。動画は準備に時間がかかることがあります。少し待ってから再度お試しください。');
      await guarded(loadMessages);
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'forbidden') mediaError(box, '再取得できませんでした。時間をおいて再度お試しください。');
    } finally {
      for (const b of box.querySelectorAll('button')) b.disabled = false;
    }
  }

  async function selectContact(c) {
    if (state.contactId !== c.id) {
      closeForms();
      closeTemplates();
    }
    state.contactId = c.id;
    renderThreadHeader(c);
    $('action-error').textContent = '';
    for (const b of $('contact-list').querySelectorAll('button')) {
      b.setAttribute('aria-current', String(b.dataset.id === c.id));
    }
    $('reply-form').hidden = false;
    $('reply-note').textContent = `${c.account.name} から送信されます`;
    $('call-link-button').hidden = !c.account.has_call; // 通話URLを登録した公式LINEだけ表示
    $('reply-error').textContent = '';
    await guarded(loadMessages);
  }

  const currentContact = () => state.contacts.find((c) => c.id === state.contactId) ?? null;

  // 相手の名前・対応状況・メモ（一覧を更新するたびに最新の内容で描き直す）
  function renderThreadHeader(c) {
    $('thread-title').textContent = nameOf(c);
    $('thread-line-name').textContent = c.custom_name && c.display_name ? `LINE名: ${c.display_name}` : '';
    const badge = $('thread-account');
    badge.textContent = `${c.account.name} 宛て`;
    badge.hidden = false;
    $('thread-actions').hidden = false;
    $('done-button').hidden = !c.awaiting_since; // 未返信のときだけ
    $('follow-button').textContent = c.follow_up_note ? '📌 フォローを編集' : '📌 フォロー';

    const follow = c.follow_up_note ? followTag(c, 'p') : el('p', 'tag follow', '');
    follow.id = 'info-follow';
    follow.hidden = !c.follow_up_note;
    $('info-follow').replaceWith(follow);
    const memo = $('info-memo');
    memo.textContent = c.memo ? `メモ：${c.memo}` : '';
    memo.hidden = !c.memo;
    $('contact-info').hidden = !c.follow_up_note && !c.memo;
  }

  function closeForms() {
    $('follow-form').hidden = true;
    $('profile-form').hidden = true;
  }

  function openFollowForm() {
    const c = currentContact();
    if (!c) return;
    $('profile-form').hidden = true;
    $('follow-note').value = c.follow_up_note ?? '';
    $('follow-due').value = c.follow_up_due ?? '';
    $('follow-clear').hidden = !c.follow_up_note;
    $('follow-form').hidden = false;
    $('follow-note').focus();
  }

  function openProfileForm() {
    const c = currentContact();
    if (!c) return;
    $('follow-form').hidden = true;
    $('profile-name').value = c.custom_name ?? '';
    $('profile-memo').value = c.memo ?? '';
    $('profile-form').hidden = false;
    $('profile-name').focus();
  }

  // 対応状況・メモの保存（成功したらフォームを閉じて一覧を更新する）
  async function saveContact(action, body) {
    if (!state.contactId) return;
    $('action-error').textContent = '';
    try {
      const { status } = await apiRequest(`/contacts/${encodeURIComponent(state.contactId)}/${action}`, { method: 'POST', body });
      if (status !== 200) {
        $('action-error').textContent = status === 400
          ? '入力内容を確認してください（文字数の上限など）。'
          : '保存できませんでした。一覧を更新してから再度お試しください。';
        return;
      }
      closeForms();
      await refresh();
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'forbidden') {
        $('action-error').textContent = '通信に失敗しました。時間をおいて再度お試しください。';
      }
    }
  }

  async function refresh() {
    await guarded(async () => {
      await loadContacts();
      const c = currentContact();
      if (c) renderThreadHeader(c);
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

  // ---------- 定型文 ----------
  // 表示するのは「共通」と「今開いている相手の公式LINE専用」の定型文だけ
  function templatesForCurrent() {
    const c = currentContact();
    const q = $('template-search').value.trim().toLowerCase();
    return state.templates.filter(
      (t) => (t.account_key === null || t.account_key === c?.account.key) &&
        (!q || t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)),
    );
  }

  async function openTemplates() {
    $('template-panel').hidden = false;
    $('template-form').hidden = true;
    $('template-error').textContent = '';
    $('template-search').value = '';
    renderTemplates();
    $('template-search').focus();
    await loadTemplates();
  }

  function closeTemplates() {
    $('template-panel').hidden = true;
  }

  async function loadTemplates() {
    try {
      state.templates = (await api('/templates')).templates;
      renderTemplates();
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'forbidden') $('template-error').textContent = '定型文を読み込めませんでした。';
    }
  }

  function renderTemplates() {
    const list = templatesForCurrent();
    $('template-list').replaceChildren(
      ...list.map((t) => {
        const li = document.createElement('li');
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'use';
        const title = el('span', 'title', t.title);
        if (t.account_key) title.append(el('span', 'scope', state.accounts.find((a) => a.key === t.account_key)?.name ?? ''));
        use.append(title, el('span', 'body', t.body));
        use.addEventListener('click', () => insertTemplate(t));
        const edit = el('button', 'secondary small', '編集');
        edit.type = 'button';
        edit.addEventListener('click', () => openTemplateForm(t));
        li.append(use, edit);
        return li;
      }),
    );
    $('template-empty').hidden = list.length > 0 || !$('template-form').hidden;
  }

  function insertTemplate(t) {
    insertText(t.body);
    closeTemplates();
  }

  // 入力欄のカーソルの位置に差し込む（送信はしない）。
  // {名前} は相手の名前に置き換える（名前が分からなければそのまま残して気づけるようにする）
  function insertText(body) {
    const c = currentContact();
    const name = c?.custom_name || c?.display_name;
    const text = name ? body.replaceAll('{名前}', name) : body;
    const area = $('reply-text');
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? area.value.length;
    area.setRangeText(text, start, end, 'end');
    area.focus();
  }

  function openTemplateForm(t) {
    state.editingTemplateId = t?.id ?? null;
    const select = $('template-account');
    select.replaceChildren(new Option('すべての公式LINE（共通）', ''), ...state.accounts.map((a) => new Option(`${a.name} だけ`, a.key)));
    select.value = t ? t.account_key ?? '' : '';
    $('template-title').value = t?.title ?? '';
    $('template-body').value = t?.body ?? '';
    $('template-delete').hidden = !t;
    $('template-form').hidden = false;
    $('template-list').hidden = true;
    $('template-empty').hidden = true;
    $('template-error').textContent = '';
    $('template-title').focus();
  }

  function closeTemplateForm() {
    state.editingTemplateId = null;
    $('template-form').hidden = true;
    $('template-list').hidden = false;
    renderTemplates();
  }

  async function saveTemplate(remove = false) {
    const id = state.editingTemplateId;
    if (remove && !window.confirm('この定型文を削除しますか？（全員の画面から消えます）')) return;
    const path = id ? `/templates/${encodeURIComponent(id)}${remove ? '/delete' : ''}` : '/templates';
    const body = remove ? {} : { title: $('template-title').value, body: $('template-body').value, account_key: $('template-account').value || null };
    $('template-error').textContent = '';
    try {
      const { status } = await apiRequest(path, { method: 'POST', body });
      if (status !== 200) {
        $('template-error').textContent = status === 400 ? '題名と本文を入力してください（題名は50文字まで）。' : '保存できませんでした。';
        return;
      }
      closeTemplateForm();
      await loadTemplates();
    } catch (e) {
      if (e.message !== 'auth' && e.message !== 'forbidden') $('template-error').textContent = '通信に失敗しました。';
    }
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
  $('tab-todo').addEventListener('click', () => {
    setTab('todo');
    renderContacts();
  });
  $('tab-all').addEventListener('click', () => {
    setTab('all');
    renderContacts();
  });
  $('done-button').addEventListener('click', () => saveContact('done', {}));
  $('follow-button').addEventListener('click', openFollowForm);
  $('profile-button').addEventListener('click', openProfileForm);
  $('follow-cancel').addEventListener('click', closeForms);
  $('profile-cancel').addEventListener('click', closeForms);
  $('follow-clear').addEventListener('click', () => saveContact('follow-up', { note: '' }));
  $('follow-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveContact('follow-up', { note: $('follow-note').value, due: $('follow-due').value });
  });
  $('profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveContact('profile', { custom_name: $('profile-name').value, memo: $('profile-memo').value });
  });
  $('template-button').addEventListener('click', () => ($('template-panel').hidden ? openTemplates() : closeTemplates()));
  $('template-close').addEventListener('click', closeTemplates);
  $('template-search').addEventListener('input', renderTemplates);
  $('template-add').addEventListener('click', () => openTemplateForm(null));
  $('template-cancel').addEventListener('click', closeTemplateForm);
  $('template-delete').addEventListener('click', () => saveTemplate(true));
  $('template-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveTemplate();
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
