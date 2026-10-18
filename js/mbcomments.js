// 博客评论前端（mbcomments）
// - 只依赖原生 DOM/fetch，无框架
// - 评论正文按纯文本渲染（textContent + 自动识别 http(s) 链接），不做 HTML 注入
// - 首次进入视口才请求接口；姓名/邮箱/网址存 localStorage
(function () {
  'use strict';

  const root = document.getElementById('mbc');
  if (!root) return;

  const postKey = String(root.dataset.postKey || '').trim();
  const postTitle = String(root.dataset.postTitle || '').trim();
  const apiBase = String(root.dataset.apiBase || 'https://mousebomb.org/api').replace(/\/+$/, '');
  const cssHref = String(root.dataset.css || '');
  const isEn = String(root.dataset.lang || 'zh-CN').toLowerCase().startsWith('en');

  // 样式走 JS 注入，避免在 body 里塞 <link>
  if (cssHref && !document.querySelector('link[data-mbc-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssHref;
    link.setAttribute('data-mbc-css', '1');
    document.head.appendChild(link);
  }

  const T = isEn
    ? {
        loading: 'Loading comments…',
        loadFailed: 'Failed to load comments. Please refresh and try again.',
        count: (n) => `${n} ${n === 1 ? 'comment' : 'comments'}`,
        none: 'No comments yet. Be the first to share your thoughts.',
        reply: 'Reply',
        replyingTo: (name) => `Replying to ${name}`,
        cancel: 'Cancel',
        name: 'Name',
        email: 'Email',
        website: 'Website (optional)',
        content: 'Write a comment…',
        hint: 'Your email will not be published.',
        submit: 'Post comment',
        submitting: 'Posting…',
        nameRequired: 'Please enter your name.',
        emailRequired: 'Please enter a valid email address.',
        contentRequired: 'Please write something.',
        postFailed: 'Failed to post. Please try again.',
        network: 'Network error. Please try again.',
        pending: 'Comment submitted. It will appear after review.',
        admin: 'Author',
        websiteLabel: 'website',
      }
    : {
        loading: '评论加载中…',
        loadFailed: '评论加载失败，请刷新重试。',
        count: (n) => `${n} 条评论`,
        none: '还没有评论，来说两句吧。',
        reply: '回复',
        replyingTo: (name) => `回复 ${name}`,
        cancel: '取消',
        name: '昵称',
        email: '邮箱',
        website: '网站（选填）',
        content: '写下你的想法…',
        hint: '邮箱不会公开。',
        submit: '发表评论',
        submitting: '提交中…',
        nameRequired: '请填写昵称。',
        emailRequired: '请填写有效的邮箱。',
        contentRequired: '请写点内容。',
        postFailed: '发表失败，请重试。',
        network: '网络异常，请重试。',
        pending: '评论已提交，审核通过后显示。',
        admin: '站长',
        websiteLabel: '网站',
      };

  const LS_NAME = 'mbc:name';
  const LS_EMAIL = 'mbc:email';
  const LS_URL = 'mbc:url';

  const state = {
    loaded: false,
    loading: false,
    submitting: false,
    parentId: null,
    total: 0,
  };

  /** 小工具：创建元素 */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 读取 localStorage，失败时返回空串（隐私模式） */
  function lsGet(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function lsSet(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  // ---------- 骨架 ----------
  root.textContent = '';

  const summary = el('div', 'mbc-summary', T.loading);
  summary.setAttribute('aria-live', 'polite');
  const list = el('ol', 'mbc-list');
  const empty = el('div', 'mbc-empty', T.none);
  empty.hidden = true;

  const form = document.createElement('form');
  form.className = 'mbc-form';
  form.setAttribute('novalidate', 'novalidate');
  form.innerHTML = `
    <div class="mbc-reply-bar" hidden>
      <span class="mbc-reply-text"></span>
      <button type="button" class="mbc-reply-cancel"></button>
    </div>
    <div class="mbc-fields">
      <input class="mbc-input" name="authorName" type="text" maxlength="50" required>
      <input class="mbc-input" name="authorEmail" type="email" maxlength="190" required>
      <input class="mbc-input" name="authorUrl" type="url" maxlength="200">
    </div>
    <textarea class="mbc-textarea" name="content" maxlength="2000" required></textarea>
    <input class="mbc-hp" name="subject" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="mbc-actions">
      <span class="mbc-hint"></span>
      <button class="mbc-submit" type="submit"></button>
    </div>
    <div class="mbc-msg" role="status" aria-live="polite"></div>
  `;

  // 静态文案（不涉及用户输入）
  const nameInput = form.elements.namedItem('authorName');
  const emailInput = form.elements.namedItem('authorEmail');
  const urlInput = form.elements.namedItem('authorUrl');
  const contentInput = form.elements.namedItem('content');
  const submitBtn = form.querySelector('.mbc-submit');
  const msgBox = form.querySelector('.mbc-msg');
  const replyBar = form.querySelector('.mbc-reply-bar');
  const replyText = form.querySelector('.mbc-reply-text');
  const replyCancel = form.querySelector('.mbc-reply-cancel');
  const hint = form.querySelector('.mbc-hint');

  nameInput.placeholder = T.name;
  emailInput.placeholder = T.email;
  urlInput.placeholder = T.website;
  contentInput.placeholder = T.content;
  submitBtn.textContent = T.submit;
  hint.textContent = T.hint;
  replyCancel.textContent = T.cancel;
  replyBar.hidden = true;

  // 回填身份
  nameInput.value = lsGet(LS_NAME);
  emailInput.value = lsGet(LS_EMAIL);
  urlInput.value = lsGet(LS_URL);

  root.appendChild(summary);
  root.appendChild(list);
  root.appendChild(empty);
  root.appendChild(form);

  // ---------- 交互 ----------
  function clearReply() {
    state.parentId = null;
    replyBar.hidden = true;
    replyText.textContent = '';
  }

  function startReply(comment) {
    state.parentId = comment.id;
    replyBar.hidden = false;
    replyText.textContent = T.replyingTo(comment.authorName);
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    contentInput.focus();
  }

  replyCancel.addEventListener('click', clearReply);

  function showMsg(text, isError) {
    msgBox.textContent = text;
    msgBox.classList.toggle('mbc-msg--err', !!isError);
    msgBox.classList.toggle('mbc-msg--ok', !isError);
  }

  // ---------- 渲染 ----------
  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(isEn ? 'en-US' : 'zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
    } catch {
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  /** 把纯文本里的 http(s) URL 变成链接，其余保持文本节点 */
  function appendLinkified(parent, text) {
    const re = /(https?:\/\/[^\s<>"']+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));

      let url = m[0];
      const trailing = url.match(/[),.;:!?，。；：！？）】]+$/);
      const tail = trailing ? trailing[0] : '';
      if (tail) url = url.slice(0, -tail.length);

      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'nofollow ugc noopener';
      parent.appendChild(a);
      if (tail) parent.appendChild(document.createTextNode(tail));

      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderItem(comment) {
    const item = el('li', 'mbc-item');
    item.dataset.id = String(comment.id);

    const avatar = el('span', 'mbc-avatar');
    const initial = Array.from(String(comment.authorName || '?'))[0] || '?';
    avatar.dataset.initial = initial.toUpperCase();
    if (comment.avatar && /^https?:\/\//i.test(comment.avatar)) {
      const img = document.createElement('img');
      img.src = comment.avatar;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove(), { once: true });
      avatar.appendChild(img);
    }

    const main = el('div', 'mbc-main');
    const head = el('div', 'mbc-head');
    const name = el('span', 'mbc-name', comment.authorName || '');
    head.appendChild(name);

    if (comment.isAdmin) {
      head.appendChild(el('span', 'mbc-badge', T.admin));
    }

    if (comment.authorUrl && /^https?:\/\//i.test(comment.authorUrl)) {
      const site = document.createElement('a');
      site.className = 'mbc-site';
      site.href = comment.authorUrl;
      site.textContent = T.websiteLabel;
      site.target = '_blank';
      site.rel = 'nofollow ugc noopener';
      head.appendChild(site);
    }

    const time = el('time', 'mbc-time', formatDate(comment.createdAt));
    time.dateTime = comment.createdAt || '';
    head.appendChild(time);

    const reply = el('button', 'mbc-reply', T.reply);
    reply.type = 'button';
    reply.addEventListener('click', () => startReply(comment));
    head.appendChild(reply);

    const content = el('div', 'mbc-content');
    appendLinkified(content, String(comment.content || ''));

    main.appendChild(head);
    main.appendChild(content);
    item.appendChild(avatar);
    item.appendChild(main);
    return { item, main };
  }

  function renderTree(comments, total) {
    const map = new Map();
    for (const c of comments) map.set(c.id, { ...c, children: [] });

    const roots = [];
    for (const c of comments) {
      const node = map.get(c.id);
      const parent = c.parentId != null ? map.get(c.parentId) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    // 排序：顶层按「最新活动」倒序（有新回复的楼会顶上来）；楼内回复按时间正序
    const ts = (value) => {
      const t = Date.parse(value || '');
      return Number.isNaN(t) ? 0 : t;
    };
    const oldest = (a, b) => ts(a.createdAt) - ts(b.createdAt) || a.id - b.id;
    const latestAt = (node) => {
      let max = ts(node.createdAt);
      for (const child of node.children) max = Math.max(max, latestAt(child));
      return max;
    };
    for (const node of map.values()) node.children.sort(oldest);
    roots.sort((a, b) => latestAt(b) - latestAt(a) || b.id - a.id);

    list.textContent = '';
    const renderInto = (parentEl, nodes, depth) => {
      for (const node of nodes) {
        const { item, main } = renderItem(node);
        parentEl.appendChild(item);
        if (node.children.length && depth < 20) {
          const kids = el('ol', 'mbc-children');
          // 超过 3 层后不再继续缩进，避免手机上正文被挤成一条
          if (depth >= 3) kids.classList.add('mbc-children--flat');
          renderInto(kids, node.children, depth + 1);
          main.appendChild(kids);
        }
      }
    };
    renderInto(list, roots, 0);

    state.total = Number.isFinite(Number(total)) ? Number(total) : comments.length;
    summary.textContent = comments.length ? T.count(state.total) : '';
    empty.hidden = comments.length > 0;
  }

  // ---------- 请求 ----------
  async function load() {
    if (state.loaded || state.loading) return;
    state.loading = true;
    summary.textContent = T.loading;

    try {
      const url = `${apiBase}/comments?postKey=${encodeURIComponent(postKey)}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error((data && data.message) || 'load failed');

      state.loaded = true;
      const comments = Array.isArray(data.comments) ? data.comments : [];
      renderTree(comments, data.total);
    } catch (err) {
      summary.textContent = T.loadFailed;
      empty.hidden = true;
      console.error('[mbcomments]', err);
    } finally {
      state.loading = false;
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (state.submitting) return;

    const authorName = String(nameInput.value || '').trim();
    const authorEmail = String(emailInput.value || '').trim();
    const authorUrl = String(urlInput.value || '').trim();
    const content = String(contentInput.value || '').trim();
    const subject = String(form.elements.namedItem('subject').value || '');

    if (!authorName) return showMsg(T.nameRequired, true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) return showMsg(T.emailRequired, true);
    if (!content) return showMsg(T.contentRequired, true);
    if (authorUrl) {
      try {
        const u = new URL(authorUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
      } catch {
        return showMsg(T.postFailed, true);
      }
    }

    state.submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = T.submitting;
    showMsg('', false);

    try {
      const res = await fetch(`${apiBase}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          postKey,
          postTitle,
          parentId: state.parentId,
          authorName,
          authorEmail,
          authorUrl,
          content,
          subject,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showMsg((data && data.message) || T.postFailed, true);
        return;
      }

      // 成功后保留身份信息，只清正文与回复状态
      lsSet(LS_NAME, authorName);
      lsSet(LS_EMAIL, authorEmail);
      lsSet(LS_URL, authorUrl);
      contentInput.value = '';
      clearReply();
      showMsg(T.pending, false);
    } catch (err) {
      console.error('[mbcomments]', err);
      showMsg(T.network, true);
    } finally {
      state.submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = T.submit;
    }
  }

  form.addEventListener('submit', submit);

  // ---------- 懒加载 ----------
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: '300px 0px' },
    );
    io.observe(root);
  } else {
    load();
  }
})();
